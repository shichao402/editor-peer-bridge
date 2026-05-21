#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const VERSION_PATH = resolve(REPO_ROOT, 'VERSION');
const VSCODE_PACKAGE_JSON = resolve(REPO_ROOT, 'vscode-peer/package.json');
const VSCODE_PACKAGE_LOCK = resolve(REPO_ROOT, 'vscode-peer/package-lock.json');
const RIDER_BUILD_GRADLE = resolve(REPO_ROOT, 'rider-peer/build.gradle.kts');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readVersion() {
    const version = readFileSync(VERSION_PATH, 'utf8').trim();
    if (!VERSION_PATTERN.test(version)) {
        throw new Error(`Invalid VERSION value "${version}". Expected semver like 0.0.4.`);
    }
    return version;
}

function readRiderVersion() {
    const buildGradle = readFileSync(RIDER_BUILD_GRADLE, 'utf8');
    const match = buildGradle.match(/^version\s*=\s*"([^"]+)"/m);
    if (!match) throw new Error(`Missing Gradle version declaration in ${RIDER_BUILD_GRADLE}`);
    return match[1];
}

function writeRiderVersion(version) {
    const buildGradle = readFileSync(RIDER_BUILD_GRADLE, 'utf8');
    const pattern = /^version\s*=\s*"[^"]+"/m;
    if (!pattern.test(buildGradle)) throw new Error(`Missing Gradle version declaration in ${RIDER_BUILD_GRADLE}`);
    writeFileSync(RIDER_BUILD_GRADLE, buildGradle.replace(pattern, `version = "${version}"`));
}

export function collectVersionIssues() {
    const version = readVersion();
    const issues = [];
    const vscodePackage = readJson(VSCODE_PACKAGE_JSON);
    const vscodeLock = readJson(VSCODE_PACKAGE_LOCK);
    const riderVersion = readRiderVersion();

    if (vscodePackage.version !== version) {
        issues.push(`vscode-peer/package.json version is ${vscodePackage.version}, expected ${version}`);
    }
    if (vscodeLock.version !== version) {
        issues.push(`vscode-peer/package-lock.json root version is ${vscodeLock.version}, expected ${version}`);
    }
    if (vscodeLock.packages?.['']?.version !== version) {
        issues.push(`vscode-peer/package-lock.json packages[""].version is ${vscodeLock.packages?.['']?.version}, expected ${version}`);
    }
    if (riderVersion !== version) {
        issues.push(`rider-peer/build.gradle.kts version is ${riderVersion}, expected ${version}`);
    }

    return issues;
}

export function validateVersions() {
    const issues = collectVersionIssues();
    if (issues.length > 0) {
        throw new Error(`Version files do not match VERSION:\n- ${issues.join('\n- ')}\nRun npm run version:sync to update derived version files.`);
    }
}

export function validateTag(tag) {
    const version = readVersion();
    const expected = `v${version}`;
    if (tag !== expected) {
        throw new Error(`Tag ${tag} does not match VERSION ${version}. Expected ${expected}.`);
    }
}

export function syncVersions() {
    const version = readVersion();

    const vscodePackage = readJson(VSCODE_PACKAGE_JSON);
    vscodePackage.version = version;
    writeJson(VSCODE_PACKAGE_JSON, vscodePackage);

    const vscodeLock = readJson(VSCODE_PACKAGE_LOCK);
    vscodeLock.version = version;
    if (!vscodeLock.packages?.['']) {
        throw new Error(`Missing packages[""] in ${VSCODE_PACKAGE_LOCK}`);
    }
    vscodeLock.packages[''].version = version;
    writeJson(VSCODE_PACKAGE_LOCK, vscodeLock);

    writeRiderVersion(version);
}

function printHelp() {
    console.log(`Usage: node scripts/version.mjs <command>

Commands:
  read              Print VERSION
  sync              Copy VERSION into package/build files
  check             Validate package/build files match VERSION
  check-tag <tag>   Validate tag matches VERSION, e.g. v0.0.4`);
}

function main() {
    const [command, value] = process.argv.slice(2);

    try {
        if (command === 'read') {
            console.log(readVersion());
        } else if (command === 'sync') {
            syncVersions();
            console.log(`Synced version ${readVersion()}`);
        } else if (command === 'check') {
            validateVersions();
            console.log(`Version ${readVersion()} OK`);
        } else if (command === 'check-tag') {
            if (!value) throw new Error('Missing tag value for check-tag');
            validateVersions();
            validateTag(value);
            console.log(`Tag ${value} matches VERSION ${readVersion()}`);
        } else {
            printHelp();
            process.exit(command ? 2 : 0);
        }
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
