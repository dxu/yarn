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
    // a map of name -> package versions
    this.packageVersionMetadata = {}

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
    this.packageVersionMetadata[pkg.name] = Object.keys(pkg.versions)
    // console.log('keys', this.packageVersionMetadata[pkg.name])


    const valid = []
    // TODO: formalize this
    // if its in the form XX.XX.XX
    let regex = /^[0-9]+\.[0-9]+.[0-9]+$/
    if (currentVersionRange.match(regex)) {
      // space for easy splitting
      this.logicSolver.require(`${pkg.name} ${currentVersionRange}`)
      console.log('requiring ', `${pkg.name} ${currentVersionRange}`)
      valid = [currentVersionRange]
    }
    // otherwise there's a range, require OR all the versions that match
    else {
      valid = this.pkg.versions.filter((ver) => {
        return semver.satisfies(ver, currentVersionRange)
      })
      this.logicSolver.or(valid)
    }

    // for every valid, you must go through all valid versions and add all
    // implies dependencies

    console.log(valid)
    throw new Error('ajjj')
    valid.map((ver) => {

    })

    // you can get the dependencies here

  }



}
