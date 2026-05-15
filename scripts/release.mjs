#!/usr/bin/env node
// Cross-platform release tool for Editor Peer Bridge.
// - vscode-peer  -> VS Code Marketplace via @vscode/vsce
// - rider-peer   -> JetBrains Marketplace via Gradle publishPlugin
//
// Usage:
//   node scripts/release.mjs [vscode|rider|all] [--dry-run] [--skip-build]
//
// Token sources (priority high -> low):
//   1. environment variables: VSCE_PAT, JETBRAINS_PUBLISH_TOKEN
//   2. release.config.json at repo root

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(REPO_ROOT, 'release.config.json');
const EXAMPLE_PATH = resolve(REPO_ROOT, 'release.config.example.json');
const IS_WINDOWS = process.platform === 'win32';

// --- CLI parsing -----------------------------------------------------------

function parseArgs(argv) {
    const targets = [];
    const flags = { dryRun: false, skipBuild: false, help: false };

    for (const arg of argv) {
        if (arg === '--dry-run') flags.dryRun = true;
        else if (arg === '--skip-build') flags.skipBuild = true;
        else if (arg === '-h' || arg === '--help') flags.help = true;
        else if (arg === 'vscode' || arg === 'rider' || arg === 'all') targets.push(arg);
        else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
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
  node scripts/release.mjs [vscode|rider|all] [--dry-run] [--skip-build]

Targets:
  vscode    Publish vscode-peer to VS Code Marketplace
  rider     Publish rider-peer to JetBrains Marketplace
  all       Both (default)

Options:
  --dry-run     Build/package only, do not upload
  --skip-build  Skip dependency install / compile / build phases
  -h, --help    Show this help

Tokens are read from release.config.json (gitignored) or environment
variables VSCE_PAT / JETBRAINS_PUBLISH_TOKEN. Copy
release.config.example.json to release.config.json and fill in tokens.`);
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
    // On Windows, npm/npx/gradle are .cmd shims. spawn without shell:true
    // requires the explicit extension to find them on PATH.
    if (!IS_WINDOWS) return name;
    if (name === 'npm' || name === 'npx' || name === 'gradle') return `${name}.cmd`;
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

function runStep(label, cmd, args, opts = {}) {
    return new Promise((resolveStep, rejectStep) => {
        const resolved = resolveCmd(cmd);
        console.log(`\n[release] >>> ${label}`);
        console.log(`[release]     ${resolved} ${args.join(' ')}`);
        if (opts.cwd) console.log(`[release]     cwd: ${opts.cwd}`);

        // Node 18+ on Windows refuses to spawn .cmd/.bat without shell:true
        // (CVE-2024-27980), and `shell:true` with args array triggers DEP0190.
        // Workaround: invoke cmd.exe /d /s /c ourselves with a quoted line.
        let spawnCmd = resolved;
        let spawnArgs = args;
        let spawnOpts = {
            cwd: opts.cwd || REPO_ROOT,
            env: { ...process.env, ...(opts.env || {}) },
            stdio: 'inherit',
            shell: false,
        };

        if (IS_WINDOWS && /\.(cmd|bat)$/i.test(resolved)) {
            const line = [resolved, ...args].map(quoteWinArg).join(' ');
            spawnCmd = process.env.ComSpec || 'cmd.exe';
            spawnArgs = ['/d', '/s', '/c', line];
            spawnOpts.windowsVerbatimArguments = true;
        }

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

// --- Targets ---------------------------------------------------------------

async function publishVscode({ pat, dryRun, skipBuild }) {
    const cwd = resolve(REPO_ROOT, 'vscode-peer');

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
            ['--yes', '@vscode/vsce', 'publish', '--pat', pat],
            { cwd }
        );
    }
}

async function publishRider({ token, dryRun, skipBuild }) {
    const cwd = resolve(REPO_ROOT, 'rider-peer');
    const env = { JETBRAINS_PUBLISH_TOKEN: token };

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

    if (args.targets.includes('vscode') && !args.dryRun) {
        requireToken(vscePat, 'VSCE_PAT', 'vscode');
    }
    if (args.targets.includes('rider') && !args.dryRun) {
        requireToken(jbToken, 'JETBRAINS_PUBLISH_TOKEN', 'rider');
    }

    console.log(
        `[release] targets=${args.targets.join(',')} dryRun=${args.dryRun} skipBuild=${args.skipBuild}`
    );

    for (const target of args.targets) {
        if (target === 'vscode') {
            await publishVscode({
                pat: vscePat,
                dryRun: args.dryRun,
                skipBuild: args.skipBuild,
            });
        } else if (target === 'rider') {
            await publishRider({
                token: jbToken,
                dryRun: args.dryRun,
                skipBuild: args.skipBuild,
            });
        }
    }

    console.log('\n[release] done.');
}

main().catch((err) => {
    console.error(`\n[release] FAILED: ${err.message}`);
    process.exit(1);
});
