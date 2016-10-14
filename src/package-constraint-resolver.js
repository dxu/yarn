/* @flow */

import type {Reporter} from './reporters/index.js';
import type Config from './config.js';
import Logic from 'logic-solver'

const semver = require('semver');

// This isn't really a "proper" constraint resolver. We just return the highest semver
// version in the versions passed that satisfies the input range. This vastly reduces
// the complexity and is very efficient for package resolution.


// built on top of the logic solver. It can take in packages, and dependencies.
// it should be used in: package resolver, npm resolver, package request

export default class PackageConstraintResolver {
  constructor(config: Config, reporter: Reporter) {
    this.reporter = reporter;
    this.config = config;
    // a map of name -> all possible package versions
    this.packageVersionMetadataMap = {}

    // for every package in revisit, if we're adding package metadata, these are
    // all of the packages that need to be added but couldn't prior to this because
    // we didn't have all the available ranges.E
    // It should contain a mapping of
    // pkg name : {
    //   pkg version range: [other dependencies in the form of `pkg.name pkg.version`]
    // }
    // it's an array because multiple packages could contain the same dependency
    this.revisitCache = {}

    // logic solver
    this.logicSolver = new Logic.Solver()
  }

  reporter: Reporter;
  config: Config;

  reduce(versions: Array<string>, range: string): Promise<?string> {
    return Promise.resolve(semver.maxSatisfying(versions, range, this.config.looseSemver));
  }

  // add package information. Anytime you fetch a package, you want to store
  // all version information for the package, so that you can resolve ranges
  // like * and ^/~ in the future

  // add a constraint.
  // For a given package request, you need to check:
  // if its a single, require it.
  // if its a range, require at most one of the entire range.
  // if it has dependencies, add the implies for the isngle, or for every range
  addConstraint(pkg, dependencies) {


  }

  // solves the logic function. should be called when all dependencies have
  // been entered
  resolve() {
    return this.logicSolver.solve()
  }

  // add any relevant package metadata needed for solving constraints
  addPackageMetadata(pkg: Object, currentVersionRange: string): void {
    // store the version information for finding all valid package versions in
    // the future
    this.packageVersionMetadataMap[pkg.name] = Object.keys(pkg.versions)
    // console.log('keys', this.packageVersionMetadataMap[pkg.name])


    console.log('hi')
    let valid = []
    // TODO: formalize this
    // if its in the form XX.XX.XX
    let explicitSemverRegex = /^[0-9]+\.[0-9]+.[0-9]+$/
    if (currentVersionRange.match(explicitSemverRegex)) {
      // space for easy splitting
      this.logicSolver.require(Logic.exactlyOne(`${pkg.name} ${currentVersionRange}`))
      console.log('requiring ', `${pkg.name} ${currentVersionRange}`)
      valid = [currentVersionRange]
    }
    // otherwise there's a range, require OR all the versions that match
    else {
      // console.log('jjj')
      valid = Object.keys(pkg.versions).
        filter((ver) => {
          // console.log(currentVersionRange, ver)
          // console.log(semver.satisfies(ver, currentVersionRange))
          return semver.satisfies(ver, currentVersionRange)
        })

      this.logicSolver.require(Logic.or(valid.map(ver => `${pkg.name} ${ver}`)))
    }

    // for every valid, you must go through all valid versions and add all
    // implies dependencies

    console.log('valid: ', valid)
    valid.map((currentVersion) => {
      // grab the version and add dependencies
      let pkgInfo = pkg.versions[currentVersion]

      let dependencies = pkgInfo.dependencies

      for (let depName in dependencies) {
        let depVersionRange = dependencies[depName]

        // for every dependency, if there is no range, then you require()
        if (depVersionRange.match(explicitSemverRegex)) {
          this.logicSolver.require(Logic.exactlyOne(`${depName} ${depVersionRange}`))
        }
        console.log('hit here')
        let depVersions = this.packageVersionMetadataMap[depName]
        console.log('hit here2')
        // otherwise, check the packageVersionMetadataMap. if we've already grabbed the metadata
        // before this, then we can add the implies.
        if (depVersions != null) {
          depVersions.map((depVersion) => {
            this.logicSolver.require(Logic.implies(Logic.exactlyOne(`${pkg.name} ${currentVersion}`), Logic.exactlyOne(`${depName} ${depVersion}`)))
          })
        console.log('hit here3')
        }
        // otherwise add it to the "revisit" cache
        // so that when the dependency's metadata is fetched in the future, we can update the logic solver
        else {
        console.log('hit here4')
          this.revisitCache[depName] = this.revisitCache[depName] || {}
          this.revisitCache[depName][depVersionRange] = this.revisitCache[depName][depVersionRange] || []
          this.revisitCache[depName][depVersionRange].push(`${pkg.name} ${currentVersion}`)
        console.log('hit here5')
        }
      }

    })
    console.log(this.revisitCache)

    // you can get the dependencies here

    // TODO: extract
    const allVersions = Object.keys(pkg.versions)
    // TODO: if there's a revisit cache entry for this package name, go through and add all the entries to the logic solver!!!
    if (this.revisitCache[pkg.name] != null) {
      // for every version range, grab every version
      for (let versionRange in this.revisitCache[pkg.name]) {
        let validVersions = allVersions.filter(function(pkgVer) {
          return semver.satisfies(pkgVer, versionRange)
        })
        // add implies rule
        validVersions.map((validVer) => {
          // Note that this package DEPENDS ON the stored revisit cache! hence the inverse implies here
          this.logicSolver.require(Logic.implies(Logic.exactlyOne(this.revisitCache[pkg.name][versionRange]), Logic.exactlyOne(`${pkg.name} ${validVer}`)))
        })
      }
    }
    // throw new Error()

  }



}
