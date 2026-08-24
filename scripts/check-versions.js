#!/usr/bin/env node
/**
 * Fail if plugin version files disagree.
 * Usage:
 *   node scripts/check-versions.js           # CI: files must agree
 *   node scripts/check-versions.js 1.0.9     # release: also must equal this x.y.z
 */
const fs = require("fs");

const expectedTag = process.argv[2];
const semver = /^\d+\.\d+\.\d+$/;

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));

const errors = [];

if (!semver.test(manifest.version)) {
  errors.push(
    `manifest.version "${manifest.version}" must be x.y.z (no v prefix; Obsidian rejects v-tags)`
  );
}
if (manifest.version !== pkg.version) {
  errors.push(`manifest.version ${manifest.version} != package.json ${pkg.version}`);
}
if (versions[manifest.version] == null) {
  errors.push(`versions.json missing key ${manifest.version}`);
} else if (versions[manifest.version] !== manifest.minAppVersion) {
  errors.push(
    `versions.json[${manifest.version}] is ${versions[manifest.version]}, expected minAppVersion ${manifest.minAppVersion}`
  );
}
if (expectedTag !== undefined) {
  if (!semver.test(expectedTag)) {
    errors.push(`Tag "${expectedTag}" must be x.y.z (digits only, no v prefix)`);
  }
  if (expectedTag.startsWith("v")) {
    errors.push(`Obsidian does not support v-prefixed versions. Use ${expectedTag.slice(1)}.`);
  }
  if (manifest.version !== expectedTag) {
    errors.push(`Tag ${expectedTag} does not match manifest version ${manifest.version}`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}

console.log(`OK ${manifest.version} / minApp ${manifest.minAppVersion}`);
