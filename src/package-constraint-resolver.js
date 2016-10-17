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

// a node in the package dependency graph. Used for calculating weights.
// It is version agnostic. For each package node, it will contain (as children) all
// dependencies for all versions.
// Redundancies should be flattened - If there exists a package already, then
// you should just store it at the higher node
// class DepGraphNode {
//   constructor(name='$root', parent, level=0) {
//     this.name = name
//     this.version = version
//     this.level = level
//     this.parent = parent
//   }
// }


// Overall algorithm:
// 1. Get all package metadata.
// 2. While grabbing the package metadata, create the dependency graph
// 3. set up constraints while traversing the graph
// 4. have a depGraphMap mapping from package name to the dependency graph
//    node for easy access
// 5. Weight the solutions. in a dependency graph, at each level, are more important
//    than the packages below them (top level packages are most important. After that,
//    every package that is more recent will be higher priority. It can just be
//    simply calculated (for now) as a straight ratio of current package # / total # of pacakges
//      - do something for 2 package versions?
//      - maybe instead of the raito, just do a strict subtraction of weight - but then how do you handle negatives? maybe max ?
//    For each package version pattern:
//    a. For each level, weight it according to (100 ^ -(level-1)) * (current package number) / (total packages)
//
//
// Problem: We are currently collecting a flat array of all the packages, and just fetching metadata. with redundancies,
//          there will be no way to differentiate a package A at level 2, that gets re-required at level 4. Level 4 package dependencies will then be determined to be level 3, even though they should be level 5
//
//
// Alternative algorithm
// Calculate the level on addPackage, and just store them as a flat map of objects. You can calculate the level by
// continually looking for req.parentRequest() until you reach undefined


// This isn't really a "proper" constraint resolver. We just return the highest semver
// version in the versions passed that satisfies the input range. This vastly reduces
// the complexity and is very efficient for package resolution.

export default class PackageConstraintResolver {
  constructor(config: Config, reporter: Reporter, resolver: PackageResolver) {
    this.reporter = reporter;
    this.config = config;
    this.resolver = resolver

    // cache of all package metadata, mapped from name to manifest
    this.packageMetadata = {}
    this.currentlyFetching = {}

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

  // ALl this method is used for currently is for fetching all package metadata
  // It is called in the pipeline in place of Package Request's findVersionInfo
  // so that we can retain the package metadata
  async addPackage(req: DependencyRequestPattern) {
    const request = new PackageRequest(req, this.resolver);

    // starts off at level 1
    let level = 1
    let reqCheck = req

    while(reqCheck.parentRequest != null) {
      level++
      reqCheck = reqCheck.parentRequest
    }
    console.log('level ', level, 'for package', req.pattern)

    // find the version info

    const info: ?Manifest = await request.getPackageMetadata();

    if (!info) {
      throw new MessageError(this.reporter.lang('unknownPackage', req.pattern));
    }

    this.packageMetadata[info.name] = info

    const dependenciesToFetch = []
    // create new find's for all the dependencies
    for (const ver in info.versions) {
      const dependencyNames = Object.keys(info.versions[ver].dependencies || {})
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


  // given a package name and a version, create a logic term
  _createLogicTerm(name, ver) {
    return `${name} ${ver}`
  }

  // given a logic term, generate the package name and version it represents
  // in the form [name, version]
  _parseLogicTerm(term) {
    return term.split(' ')
  }


  // first call of all top level dependencies. We have to differentiate these
  // packages because theY MUST be required
  solve(topLevelDependencies): void {
    // before you do anything, add atMostOne to all the packages currently
    // stored in the packageMetadata.
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

    // solve that shit
    topLevelDependencies.map((pattern) => {
      const {range, name} = PackageRequest.normalizePattern(pattern);
      this.solvePackage(name, range)
    })

    // finished everything
    console.log('finished solving dependency solutions')

    const solutions = []
    let curSol
    // get all possible solutions
    while ((curSol = this.logicSolver.solve())) {
      solutions.push(curSol.getTrueVars());
      this.logicSolver.forbid(curSol.getFormula()); // forbid the current solution
    }

    // for every solution, get the weight, and then
    console.log(solutions)
  }

  // given a pattern, calculate the relative weight of the package version.
  // Heuristics:
  // If it's a top level dependency, then weight is ratio * 1000, for
  // for every level you go down, divide by 100
  //
  getWeight(pattern) {

  }


  // If it is a TLD (it does not have any parent, then anytime there is an explicit version, you must require
  // it. If it is not a TLD, anytime there is an explicit version, you must
  // add an implies relationship from the parent to the child, because if the parent is true, then the child must be true
  //
  // Update the dependency graph with the packages, so that we can use it to calculate relative weights of each package.
  solvePackage(name, currentVersionRange, parent?: string): void {
      // metadata
    const pkg = this.packageMetadata[name]

    // all possible valid versions of this package given the range
    let valid = []

    // TODO: make check more robust
    // string of the form XXXX.XXXX.XXXX where X is a digit from 0-9
    let explicitSemverRegex = /^[0-9]+\.[0-9]+.[0-9]+$/
    if (currentVersionRange.match(explicitSemverRegex)) {
      // currentVersionRange is an explicit semver
      if (parent != null) {
        // if it is NOT a tld, if the parent is true, then this will be true
        this.logicSolver.require(
          Logic.implies(parent, this._createLogicTerm(pkg.name, currentVersionRange))
        )
      } else {
        // this is an explicit TLD. you'll need to require it.
        this.logicSolver.require(
          Logic.and(this._createLogicTerm(pkg.name, currentVersionRange))
        )
      }
      // console.log('requiring ', `${pkg.name} ${currentVersionRange}`)
      valid = [currentVersionRange]
    }
    // otherwise there's a range, require at most one of
    // all the versions that match
    else {
      valid = Object.keys(pkg.versions).
        filter((ver) => {
          return semver.satisfies(ver, currentVersionRange)
        })

      // if it's not a TLD, the parent being true implies that
      // exactly one here is true
      if (parent != null) {
        this.logicSolver.require(
          Logic.implies(
            parent,
            Logic.exactlyOne(
              ...valid.map(ver => this._createLogicTerm(pkg.name, ver))
            )
          )
        )
      } else {
        // if it's a TLD, exactly one is definitely true.
        this.logicSolver.require(
          Logic.exactlyOne(
            ...valid.map(ver => this._createLogicTerm(pkg.name, ver))
          )
        )
      }

    }

    // for every valid, you must go through all valid versions.
    // for every valid version, solvePackage on every dependency with
    // this as the parent package.
    // console.log('valid: ', valid)
    valid.map((currentVersion) => {
      // grab the version and add dependencies
      const pkgInfo = pkg.versions[currentVersion]

      const dependencies = pkgInfo.dependencies

      for (const depName in dependencies) {
        this.solvePackage(depName, dependencies[depName], this._createLogicTerm(pkg.name, currentVersion))
      }

    })

  }
}
