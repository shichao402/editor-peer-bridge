#!/usr/bin/env node
// Cross-platform release tool for Editor Peer Bridge.
// - vscode-peer  -> VS Code Marketplace via @vscode/vsce
// - rider-peer   -> JetBrains Marketplace via Marketplace Upload API or Gradle publishPlugin
//
// Usage:
//   node scripts/release.mjs [vscode|rider|all] [--dry-run] [--skip-build] [--from-latest|--from-tag <tag>|--from-run <github-run-id>]
//
// Token sources (priority high -> low):
//   1. environment variables: VSCE_PAT, JETBRAINS_PUBLISH_TOKEN
//   2. release.config.json at repo root

import { spawn } from 'node:child_process';
import {
    existsSync,
    readFileSync,
    readdirSync,
    rmSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(REPO_ROOT, 'release.config.json');
const EXAMPLE_PATH = resolve(REPO_ROOT, 'release.config.example.json');
const ARTIFACTS_ROOT = resolve(REPO_ROOT, '.release-artifacts');
const VSCODE_PACKAGE_JSON = resolve(REPO_ROOT, 'vscode-peer/package.json');
const RIDER_PLUGIN_XML = resolve(REPO_ROOT, 'rider-peer/src/main/resources/META-INF/plugin.xml');
const JETBRAINS_UPLOAD_URL = 'https://plugins.jetbrains.com/api/updates/upload';
const ARTIFACTS = {
    vscode: { name: 'vscode-peer-vsix', ext: '.vsix' },
    rider: { name: 'rider-peer-plugin', ext: '.zip' },
};
const IS_WINDOWS = process.platform === 'win32';

// --- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
    const targets = [];
    const flags = { dryRun: false, skipBuild: false, help: false, fromRun: '', fromTag: '', fromLatest: false };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') flags.dryRun = true;
        else if (arg === '--skip-build') flags.skipBuild = true;
        else if (arg === '-h' || arg === '--help') flags.help = true;
        else if (arg === '--from-run') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                console.error('Missing value for --from-run');
                process.exit(2);
            }
            flags.fromRun = value;
            i += 1;
        } else if (arg.startsWith('--from-run=')) {
            const value = arg.slice('--from-run='.length);
            if (!value) {
                console.error('Missing value for --from-run');
                process.exit(2);
            }
            flags.fromRun = value;
        } else if (arg === '--from-tag') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                console.error('Missing value for --from-tag');
                process.exit(2);
            }
            flags.fromTag = value;
            i += 1;
        } else if (arg.startsWith('--from-tag=')) {
            const value = arg.slice('--from-tag='.length);
            if (!value) {
                console.error('Missing value for --from-tag');
                process.exit(2);
            }
            flags.fromTag = value;
        } else if (arg === '--from-latest') {
            flags.fromLatest = true;
        } else if (arg === 'vscode' || arg === 'rider' || arg === 'all') targets.push(arg);
        else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }

    const artifactSelectors = [flags.fromRun, flags.fromTag, flags.fromLatest].filter(Boolean);
    if (artifactSelectors.length > 1) {
        console.error('Use only one of --from-run, --from-tag, or --from-latest');
        process.exit(2);
    }

    if (targets.length === 0) targets.push('all');
    const expanded = new Set();
    for (const t of targets) {
        if (t === 'all') {
            expanded.add('vscode');
            expanded.add('rider');
        } else {
            expanded.add(t);
        }
    }
    return { targets: [...expanded], ...flags };
}

function printHelp() {
    console.log(`Editor Peer Bridge release tool

Usage:
  node scripts/release.mjs [vscode|rider|all] [--dry-run] [--skip-build] [--from-latest|--from-tag <tag>|--from-run <github-run-id>]

Targets:
  vscode    Publish vscode-peer to VS Code Marketplace
  rider     Publish rider-peer to JetBrains Marketplace
  all       Both (default)

Options:
  --dry-run              Build/package only, do not upload
  --skip-build           Skip dependency install / compile / build phases
  --from-latest          Use the latest successful Package workflow run
  --from-tag <tag>       Use the latest successful Package workflow run for a tag
  --from-run <run-id>    Use a specific GitHub Actions run id
  -h, --help             Show this help

Tokens are read from release.config.json (gitignored) or environment
variables VSCE_PAT / JETBRAINS_PUBLISH_TOKEN. VS Code can also publish
with the local vsce login for the package publisher.

When using --from-latest, --from-tag, or --from-run, the GitHub CLI (gh) must be installed and authenticated.`);
}

// --- Config ----------------------------------------------------------------

function loadConfig() {
    if (!existsSync(CONFIG_PATH)) return {};
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        console.error(`Failed to parse ${CONFIG_PATH}: ${err.message}`);
        process.exit(2);
    }
}

function resolveTokens(config) {
    const vscePat = process.env.VSCE_PAT || config?.vscode?.pat || '';
    const jbToken = process.env.JETBRAINS_PUBLISH_TOKEN || config?.rider?.token || '';
    return { vscePat, jbToken };
}

function requireToken(value, name, target) {
    if (!value) {
        console.error(
            `Missing token for target "${target}": set ${name} env var or fill it into release.config.json`
        );
        if (!existsSync(CONFIG_PATH)) {
            console.error(
                `Hint: copy ${EXAMPLE_PATH} to ${CONFIG_PATH} and fill in your tokens.`
            );
        }
        process.exit(2);
    }
}

// --- Process helpers -------------------------------------------------------

function resolveCmd(name) {
    // On Windows, npm/npx/gradle/gh are .cmd shims. spawn without shell:true
    // requires the explicit extension to find them on PATH.
    if (!IS_WINDOWS) return name;
    if (name === 'npm' || name === 'npx' || name === 'gradle' || name === 'gh') return `${name}.cmd`;
    return name;
}

// Quote a single argument for cmd.exe /c. This is the same approach used by
// cross-spawn — doublequote and escape embedded backslashes/quotes/cmd metas.
function quoteWinArg(arg) {
    if (arg === '') return '""';
    if (!/[\s"\\&|<>^()%!]/.test(arg)) return arg;
    // Escape backslashes that precede a quote, and the quote itself.
    const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
    return `"${escaped}"`;
}

function createSpawnConfig(cmd, args, opts = {}, stdio = 'inherit') {
    const resolved = resolveCmd(cmd);
    let spawnCmd = resolved;
    let spawnArgs = args;
    let spawnOpts = {
        cwd: opts.cwd || REPO_ROOT,
        env: { ...process.env, ...(opts.env || {}) },
        stdio,
        shell: false,
    };

    // Node 18+ on Windows refuses to spawn .cmd/.bat without shell:true
    // (CVE-2024-27980), and `shell:true` with args array triggers DEP0190.
    // Workaround: invoke cmd.exe /d /s /c ourselves with a quoted line.
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved)) {
        const line = [resolved, ...args].map(quoteWinArg).join(' ');
        spawnCmd = process.env.ComSpec || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', line];
        spawnOpts.windowsVerbatimArguments = true;
    }

    return { resolved, spawnCmd, spawnArgs, spawnOpts };
}

function runStep(label, cmd, args, opts = {}) {
    return new Promise((resolveStep, rejectStep) => {
        const { resolved, spawnCmd, spawnArgs, spawnOpts } = createSpawnConfig(cmd, args, opts);
        console.log(`\n[release] >>> ${label}`);
        console.log(`[release]     ${resolved} ${args.join(' ')}`);
        if (opts.cwd) console.log(`[release]     cwd: ${opts.cwd}`);

        const child = spawn(spawnCmd, spawnArgs, spawnOpts);

        child.on('error', (err) => {
            rejectStep(new Error(`${label} failed to start: ${err.message}`));
        });
        child.on('exit', (code, signal) => {
            if (signal) rejectStep(new Error(`${label} terminated by signal ${signal}`));
            else if (code !== 0) rejectStep(new Error(`${label} exited with code ${code}`));
            else resolveStep();
        });
    });
}

function runCapture(label, cmd, args, opts = {}) {
    return new Promise((resolveStep, rejectStep) => {
        const { spawnCmd, spawnArgs, spawnOpts } = createSpawnConfig(cmd, args, opts, ['ignore', 'pipe', 'pipe']);
        const child = spawn(spawnCmd, spawnArgs, spawnOpts);
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (err) => {
            rejectStep(new Error(`${label} failed to start: ${err.message}`));
        });
        child.on('exit', (code, signal) => {
            if (signal) rejectStep(new Error(`${label} terminated by signal ${signal}`));
            else if (code !== 0) rejectStep(new Error(`${label} exited with code ${code}: ${stderr || stdout}`));
            else resolveStep(stdout);
        });
    });
}

// --- Artifacts --------------------------------------------------------------

function findFilesByExt(dir, extension) {
    if (!existsSync(dir)) return [];

    const matches = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) matches.push(...findFilesByExt(fullPath, extension));
        else if (entry.isFile() && extname(entry.name) === extension) matches.push(fullPath);
    }
    return matches;
}

function parseGhJsonArray(output) {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return [];
    return JSON.parse(output.slice(start, end + 1));
}

async function findPackageRunId({ tag, latest }) {
    const ghArgs = [
        'run',
        'list',
        '--workflow',
        'release.yml',
        '--status',
        'success',
        '--limit',
        '1',
        '--json',
        'databaseId,headBranch,displayTitle',
    ];

    if (tag) ghArgs.push('--branch', tag);

    const label = tag
        ? `github: find successful Package run for ${tag}`
        : 'github: find latest successful Package run';
    const output = await runCapture(label, 'gh', ghArgs, { cwd: REPO_ROOT });
    const runs = parseGhJsonArray(output);
    const run = runs[0];

    if (!run?.databaseId) {
        const suffix = latest ? '' : ` for tag ${tag}`;
        throw new Error(`No successful Package workflow run found${suffix}`);
    }

    console.log(
        `[release] using GitHub Actions run ${run.databaseId} (${run.headBranch}: ${run.displayTitle})`
    );
    return String(run.databaseId);
}

async function downloadArtifactFromRun(runId, target) {
    const artifact = ARTIFACTS[target];
    const dir = resolve(ARTIFACTS_ROOT, runId, target);

    rmSync(dir, { recursive: true, force: true });
    await runStep(
        `${target}: download GitHub Actions artifact`,
        'gh',
        ['run', 'download', runId, '--name', artifact.name, '--dir', dir],
        { cwd: REPO_ROOT }
    );

    const files = findFilesByExt(dir, artifact.ext);
    if (files.length !== 1) {
        throw new Error(
            `${target}: expected exactly one ${artifact.ext} in ${dir}, found ${files.length}`
        );
    }

    console.log(`[release] ${target}: using artifact ${files[0]}`);
    return files[0];
}

async function downloadArtifactsFromRun(runId, targets) {
    const paths = {};
    for (const target of targets) {
        paths[target] = await downloadArtifactFromRun(runId, target);
    }
    return paths;
}

// --- Targets ---------------------------------------------------------------

function readVscodePublisher() {
    const pkg = JSON.parse(readFileSync(VSCODE_PACKAGE_JSON, 'utf8'));
    if (!pkg.publisher) throw new Error(`Missing publisher in ${VSCODE_PACKAGE_JSON}`);
    return pkg.publisher;
}

async function ensureVscodeLogin(publisher, cwd) {
    const output = await runCapture('vscode: list logged-in publishers', 'npx', ['--yes', '@vscode/vsce', 'ls-publishers'], { cwd });
    const publishers = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (publishers.includes(publisher)) {
        console.log(`[release] vscode: using existing vsce login for publisher ${publisher}`);
        return;
    }

    console.log(`[release] vscode: VSCE_PAT not configured; logging in publisher ${publisher}`);
    await runStep('vscode: login publisher', 'npx', ['--yes', '@vscode/vsce', 'login', publisher], { cwd });
}

async function buildVscodePublishArgs({ pat, packagePath, cwd }) {
    const args = ['--yes', '@vscode/vsce', 'publish'];
    if (packagePath) args.push('--packagePath', packagePath);
    if (pat) {
        args.push('--pat', pat);
    } else {
        await ensureVscodeLogin(readVscodePublisher(), cwd);
    }
    return args;
}

async function publishVscode({ pat, dryRun, skipBuild, packagePath }) {
    const cwd = resolve(REPO_ROOT, 'vscode-peer');

    if (packagePath) {
        if (dryRun) {
            console.log(`[release] vscode: artifact ready (dry-run): ${packagePath}`);
            return;
        }

        await runStep(
            'vscode: publish artifact to Marketplace',
            'npx',
            await buildVscodePublishArgs({ pat, packagePath, cwd }),
            { cwd }
        );
        return;
    }

    if (!skipBuild) {
        await runStep('vscode: install dependencies', 'npm', ['install'], { cwd });
        await runStep('vscode: compile TypeScript', 'npm', ['run', 'compile'], { cwd });
    } else {
        console.log('[release] vscode: skipping install/compile (--skip-build)');
    }

    if (dryRun) {
        await runStep(
            'vscode: package vsix (dry-run)',
            'npx',
            ['--yes', '@vscode/vsce', 'package'],
            { cwd }
        );
    } else {
        await runStep(
            'vscode: publish to Marketplace',
            'npx',
            await buildVscodePublishArgs({ pat, cwd }),
            { cwd }
        );
    }
}

function readRiderPluginXmlId() {
    const xml = readFileSync(RIDER_PLUGIN_XML, 'utf8');
    const match = xml.match(/<id>\s*([^<\s]+)\s*<\/id>/);
    if (!match) throw new Error(`Failed to read plugin <id> from ${RIDER_PLUGIN_XML}`);
    return match[1];
}

async function uploadRiderPackage({ token, packagePath }) {
    if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
        throw new Error('Rider artifact upload requires Node.js 18+ with fetch/FormData/Blob support');
    }

    const xmlId = readRiderPluginXmlId();
    const form = new FormData();
    form.set('xmlId', xmlId);
    form.set('file', new Blob([readFileSync(packagePath)], { type: 'application/zip' }), basename(packagePath));

    console.log(`\n[release] >>> rider: upload artifact to JetBrains Marketplace`);
    console.log(`[release]     ${basename(packagePath)} xmlId=${xmlId}`);

    const response = await fetch(JETBRAINS_UPLOAD_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    const body = await response.text();

    if (!response.ok) {
        throw new Error(`rider: upload failed with HTTP ${response.status}: ${body}`);
    }

    if (body) console.log(body);
}

async function publishRider({ token, dryRun, skipBuild, packagePath }) {
    const cwd = resolve(REPO_ROOT, 'rider-peer');
    const env = { JETBRAINS_PUBLISH_TOKEN: token };

    if (packagePath) {
        if (dryRun) {
            console.log(`[release] rider: artifact ready (dry-run): ${packagePath}`);
            return;
        }

        await uploadRiderPackage({ token, packagePath });
        return;
    }

    if (dryRun) {
        await runStep('rider: build plugin (dry-run)', 'gradle', ['buildPlugin'], { cwd, env });
        return;
    }

    const args = ['publishPlugin'];
    if (skipBuild) {
        // Reuse existing artifact under build/distributions; tell Gradle not to
        // rebuild upstream tasks. publishPlugin still needs the zip present.
        args.push('--rerun-tasks=false');
    }
    await runStep('rider: publish plugin', 'gradle', args, { cwd, env });
}

// --- Main ------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const config = loadConfig();
    const { vscePat, jbToken } = resolveTokens(config);

    if (args.targets.includes('rider') && !args.dryRun) {
        requireToken(jbToken, 'JETBRAINS_PUBLISH_TOKEN', 'rider');
    }

    const resolvedRun = args.fromRun || (args.fromTag || args.fromLatest
        ? await findPackageRunId({ tag: args.fromTag, latest: args.fromLatest })
        : '');
    const artifactPaths = resolvedRun
        ? await downloadArtifactsFromRun(resolvedRun, args.targets)
        : {};

    console.log(
        `[release] targets=${args.targets.join(',')} dryRun=${args.dryRun} skipBuild=${args.skipBuild} fromRun=${resolvedRun || 'none'}`
    );

    for (const target of args.targets) {
        if (target === 'vscode') {
            await publishVscode({
                pat: vscePat,
                dryRun: args.dryRun,
                skipBuild: args.skipBuild,
                packagePath: artifactPaths.vscode,
            });
        } else if (target === 'rider') {
            await publishRider({
                token: jbToken,
                dryRun: args.dryRun,
                skipBuild: args.skipBuild,
                packagePath: artifactPaths.rider,
            });
        }
    }

    console.log('\n[release] done.');
}

main().catch((err) => {
    console.error(`\n[release] FAILED: ${err.message}`);
    process.exit(1);
});
