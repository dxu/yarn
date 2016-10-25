/* @flow */

import type {Reporter} from './reporters/index.js';
import type Config from './config.js';

const semver = require('semver');

import type {DependencyRequestPattern, Manifest} from './types.js';
import PackageResolver from './package-resolver.js'
import PackageRequest from './package-request.js';
import {MessageError} from './errors.js';

import Logic from 'logic-solver'

import {USED as USED_VISIBILITY, default as PackageReference} from './package-reference.js';

// TODO change all {} to use the map() for iterator support
export default class PackageConstraintResolver {
  constructor(config: Config, reporter: Reporter, resolver: PackageResolver) {
    this.reporter = reporter;
    this.config = config;
    this.resolver = resolver

    // cache of all package metadata, mapped from name to manifest
    // { [name]: [[Manifest]] }
    this.packageMetadata = {}

    // cache of all possible versions of a package
    // { [name]: [...versions] }
    this.packageVersions = {}
    this.currentlyFetching = {}
    // cache of all PackageRequests from
    // {[name]: [[PackageRequest]]}
    this.packageRequests = {}

    // the terms and costs that will be used by the logicSolver to minimizeWeightedSum
    this.terms = []
    this.costs = []

    // visited logic terms
    this.visited = []

    // any packages where we're not able to fetch metadata - this will happen
    // often with old, unpublished packages.
    this.unrecognizedPatterns = []

    // combinations of name, package version that have been checked
    // { [logicTerm]: bool }
    this.checkedTermsAndCost = {}

    // { [name]: [[level]] }
    // This is used for reference when calculating the cost of each package
    this.levelMap = {}

    // logic solver
    this.logicSolver = new Logic.Solver()
  }

  reporter: Reporter;
  config: Config;
  resolver: PackageResolver;

  packageMetadata: Object;
  currentlyFetching: Object;

  reduce(versions: Array<string>, range: string): Promise<?string> {
    return Promise.resolve(semver.maxSatisfying(versions, range, this.config.looseSemver));
  }

  // given a package name and a version, create a logic term
  _createLogicTerm(name, ver) {
    // TODO: see if there is an existing method for this
    return `${name}@${ver}`
  }

  // given a logic term, generate the package name and version it represents
  // in the form [name, version]
  _parseLogicTerm(term) {
    const {range, name} = PackageRequest.normalizePattern(pattern);
    return [name, range]
  }

  // ALl this method is used for currently is for fetching all package metadata
  // It is called in the pipeline in place of Package Request's findVersionInfo
  // so that we can retain the package metadata
  async addPackage(req: DependencyRequestPattern) {
    const {range, name} = PackageRequest.normalizePattern(req.pattern);

    const request = new PackageRequest(req, this.resolver);


    // find the version info
    let info: ?Manifest =
      await request.getPackageMetadata();

    if (!info) {
      // The package can no longer be found. Because this algorithm runs
      // through ALL possible packages and dependencies, this will happen often
      // with very old packages that got unpublished.
      console.log('failed to fetch ', req.pattern)

      // TODO: Should we prompt the user that there were unrecognized packages?
      this.unrecognizedPatterns.push(req.pattern)
      // We should throw an error LATER, when solve the solution, if a top level
      // dependency does not have metadata. If that is the case, chances are,
      // the developer specified the wrong package, or misspelled the name of
      // the package.
      // throw new MessageError(this.reporter.lang('unknownPackage', req.pattern));
      return
    }

    // cache the PackageRequests for now. After we run
    // logicSolver.solve(), we will use them to update the references for a
    // specific version. At this point, we do not know what version we should
    // be referencing in the future.
    this.packageRequests[name] = request
    this.packageMetadata[name] = info
    this.packageVersions[name] = Object.keys(info.versions)

    const dependenciesToFetch = []
    // create new find's for all the dependencies
    for (const ver in info.versions) {
      const dependencyNames =
        Object.keys(info.versions[ver].dependencies || {})
      dependencyNames.map((name) => {
        // if we have metadata already, ignore. otherwise, call find again
        if(this.packageMetadata[name] == null && this.currentlyFetching[name] == null) {
          dependenciesToFetch.push(this.resolver.find({
            // TODO: need to make it so it can just take a name instead of a
            // pattern, because we're not looking for a specific version here
            pattern: name,
            // TODO
            // registry: remote.registry,
            registry: 'npm',
            visibility: USED_VISIBILITY,
            optional: true,
            parentRequest: request,
          }))
          this.currentlyFetching[name] = true
        }
      })
    }
    // fetch all dependencies metadata for all versions
    return await Promise.all(dependenciesToFetch);
  }

  // first call of all top level dependencies. We differentiate these
  // packages because theY MUST be required
  async solve(topLevelDependencies): void {
    // before you do anything, add atMostOne version to all the packages
    // currently stored in the packageMetadata.
    for (let name in this.packageMetadata) {
      const pkg = this.packageMetadata[name]
      // store the version information for finding all valid package versions for
      // the future
      const keys = Object.keys(pkg.versions)
      this.logicSolver.require(
        Logic.atMostOne(
          ...keys.map(ver => this._createLogicTerm(pkg.name, ver))
        )
      )
    }

    const queue = topLevelDependencies.map((pattern) => {
      const {range, name} = PackageRequest.normalizePattern(pattern);
      return [1, name, range]
    })

    // solve that shit
    // NOTE: we use bfs so that we can retain level consistency when adding
    // terms and costs to this.terms and this.costs, otherwise you must add
    // them post traveral!
    while (queue.length > 0) {
      const [level, name, range, parent] = queue.shift()
      this.solvePackage(queue, level, name, range, parent)
    }

    // finished setting up all the logic statements! let's solve it
    let solution = this.logicSolver.solve()

    console.log('solution', solution)

    // if the solution is null, there is no valid solution!
    if (solution == null) {
      // TODO: handle this better
      throw new Error('no solution was found')
    }

    solution = this.logicSolver.minimizeWeightedSum(solution, this.terms, this.costs)
    const truthy = solution.getTrueVars()

    let promises = []

    // for every truthy solution, we now have to create all the package requests
    // and make sure all package references are appropriately created
    truthy.map((pattern) => {
      const {range, name} = PackageRequest.normalizePattern(pattern);
      const pkgReq = this.packageRequests[name]
      pkgReq.updatePattern(pattern);
      promises.push(pkgReq.setupPackageReferences())
    })

    await Promise.all(promises)

    return truthy
  }

  // Used to weight the solutions.
  // Core tenets:
  // 1. Every level of the dependency graph, is more important than the ones
  //    below. For example, the top level dependencies found in package.json
  //    are more important than the dependencies of the top level dependencies,
  //    so on and so forth.
  // 2. Packages that are more recent should be higher priority.
  // 3. We use a "cost minimizing function". Packages that are more important
  //    to the end solution should be weighted LOWER than those less important
  //
  // Thoughts: Could potentially use a ratio for #2, but would run into issues
  //           when attempting to calculate cost for a package with very few
  //           versions.
  getCost(name, ver) {
    const level = this.levelMap[name]
    const versions = this.packageVersions[name]
    const versionRecency = versions.length - (versions.lastIndexOf(ver) + 1)

    return Math.pow(10, level+1) + versionRecency
  }


  // Algorithm:
  // If it is a TLD (it does not have any parent, then anytime there is an
  // explicit version, you must require it. If it is not a TLD, anytime there
  // is an explicit version, you must add an implies relationship from the
  // parent to the child, because if the parent is true, then the child must
  // be true
  solvePackage(queue: Array, level: number, name:string, currentVersionRange, parent: string): void {
    // update the level map for the package. Since it's a BFS, it will always
    // have the minimum level value. This level is used when calculating
    // the cost of each package
    this.levelMap[name] = this.levelMap[name] || level


    const pkg = this.packageMetadata[name]
    // if we don't have the metadata, immediately return because that means it
    // was unrecognized during the metadata extraction process. Because of
    // that, we should just ignore this package instead of including it within
    // the solution
    // TODO: better error checking
    if (pkg == null) {
      // if it's a TLD, though, we should throw an error immediately. This
      // probably means they made a typo when manually including a dependency
      if (parent == null) {
        throw new Error("There was an invalid package included as a TLD")
      }
      // TODO: we might be able to immediately forbid anything that depends on
      // this package (the parent), because we don't have metadata for it!
      // this.logicSolver.forbid(parent)
      return
    }

    // all possible valid versions of this package given the range
    let valid = []

    const negatedParent = `-${parent}`

    // TODO: make check more robust
    // string of the form XXXX.XXXX.XXXX where X is a digit from 0-9
    let explicitSemverRegex = /^[0-9]+\.[0-9]+.[0-9]+$/

    // currentVersionRange is not a semver range, just a single version
    if (currentVersionRange.match(explicitSemverRegex)) {
      if (parent != null) {
        const logicTerm = this._createLogicTerm(pkg.name, currentVersionRange)
        const negatedLogicTerm = `-${logicTerm}`;
        // if it is NOT a tld, if the parent is true, then this will be true
        this.logicSolver.require(
          Logic.implies(parent, logicTerm)
        )
        // if the dependency is false, then the parent is false.
        // this.logicSolver.require(
        //   Logic.implies(negatedLogicTerm, negatedParent)
        // )

      } else {
        // this is an explicit TLD. you'll need to require it.
        this.logicSolver.require(
          this._createLogicTerm(pkg.name, currentVersionRange)
        )
      }
      valid = [currentVersionRange]
    }
    // otherwise there's a range, require at most one of
    // all the versions that match
    else {
      valid = Object.keys(pkg.versions).
        filter((ver) => {
          return semver.satisfies(ver, currentVersionRange)
        })

      const validLogicTerms =
        valid.map(ver => this._createLogicTerm(pkg.name, ver))
      const negatedValidLogicTerms =
        validLogicTerms.map(ver => `-${ver}`)
      if (parent != null) {
        // if it's not a TLD, the parent being true implies that
        // exactly one here is true
        this.logicSolver.require(
          Logic.implies(
            parent,
            Logic.exactlyOne(
              ...validLogicTerms
            )
          )
        );
        // if all of the valid logic terms are negated (i.e, they are false),
        // then it implies that the parent is false
        // this.logicSolver.require(
        //   Logic.implies(
        //     Logic.or(
        //       ...negatedValidLogicTerms,
        //     ),
        //     negatedParent,
        //   )
        // );
      } else {
        // if it's a TLD, exactly one is definitely true.
        this.logicSolver.require(
          Logic.exactlyOne(
            ...validLogicTerms
          )
        )
      }
    }

    // filter out the patterns we've already visited while solving packages
    valid = valid.filter((version) => {
      const logicTerm = this._createLogicTerm(pkg.name, version)
      return this.visited[logicTerm] == null
    })

    // for every valid, you must go through all valid versions.
    // for every valid version, solvePackage on every dependency with
    // this as the parent package.
    valid.map((currentVersion) => {
      // save the cost and term for every valid package that exists
      const logicTerm = this._createLogicTerm(pkg.name, currentVersion)

      // if we haven't kept track of the terms and costs here, push them on
      // We can guarantee that this will push the accurate cost of the most
      // important traversal of this package + ver, because
      // level order is preserved, since we are running a BFS.
      if (!this.checkedTermsAndCost[logicTerm]) {
        this.terms.push(logicTerm)
        this.costs.push(this.getCost(pkg.name, currentVersion))
      }
      this.checkedTermsAndCost[logicTerm] = true


      // grab the version and add dependencies
      const pkgInfo = pkg.versions[currentVersion]

      const dependencies = pkgInfo.dependencies

      for (const depName in dependencies) {
        queue.push([level + 1, depName, dependencies[depName], logicTerm])
      }

      // mark that we've visited this
      this.visited[logicTerm] = true
    })
  }
}



// TODO: It looks like the solver isn't properly forbidding certain solutions
// It comes up with the following solution:
//[ [ '@yunxing-test/a 0.0.1', '@yunxing-test/c 0.0.2' ],
// [ '@yunxing-test/a 0.0.1',
//   '@yunxing-test/b 0.0.1',
//   '@yunxing-test/c 0.0.3' ],
// [ '@yunxing-test/a 0.0.1',
//   '@yunxing-test/b 0.0.1',
//   '@yunxing-test/c 0.0.1' ],
// [ '@yunxing-test/a 0.0.1',
//   '@yunxing-test/b 0.0.1',
//   '@yunxing-test/c 0.0.2' ] ]
//   If you notice, the last solution and first solution conflict. The last
//   solution is actually invalid. Seems like they add yunxing-test/b despite
//   there being no dependency there. Practically it might not matter if
//   we are using a cost minimizing function, since extra packages = more cost

// TODO: Currently, we are properly solving the package.json's DEPENDENCIES.
// we should repeat this for the devDependencies, peerDependencies,
// bundledDependencies, etc.
//

