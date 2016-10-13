/* @flow */

import type {Reporter} from './reporters/index.js';
import type Config from './config.js';

const semver = require('semver');

export default class DependencyConstraintResolver {
  constructor(resolver) {
    this.resolver = resolver
  }

  resolve(patterns: Array<string>): Promise<?string> {
    console.log(patterns)
    // console.log(this.resolver.getAllInfoForPackageName(patterns))
    console.log(this.resolver.requestAllVersions())

    // return Promise.resolve(semver.maxSatisfying(versions, range, this.config.looseSemver));
  }
}
