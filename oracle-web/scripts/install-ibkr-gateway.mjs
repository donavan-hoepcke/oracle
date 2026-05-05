#!/usr/bin/env node
/**
 * One-shot installer for the IBKR Client Portal Gateway.
 *
 * Why this exists: the gateway is IBKR's intellectual property —
 * vendoring its 12 MB of JARs into a public repo is legally murky. This
 * script downloads the official zip from IBKR's public CDN and unpacks
 * it into a gitignored vendor directory. Operators run it once per
 * machine; the project stays self-contained from a "clone-and-go"
 * perspective without republishing IBKR's binaries.
 *
 * Usage (from oracle-web/):
 *   node scripts/install-ibkr-gateway.mjs
 *   # or via npm:
 *   npm run ibkr-gateway:install
 *
 * Idempotent — safe to re-run. If the gateway is already installed the
 * script skips the download. Pass --force to redownload regardless.
 *
 * Environment overrides:
 *   IBKR_GATEWAY_URL — alternate download URL (e.g. for an internal mirror)
 *   IBKR_GATEWAY_DIR — alternate install location (default: vendor/ibkr-gateway)
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');

const DEFAULT_URL = 'https://download2.interactivebrokers.com/portal/clientportal.gw.zip';
const DEFAULT_DIR = join(REPO_DIR, 'vendor', 'ibkr-gateway');

const args = new Set(process.argv.slice(2));
const force = args.has('--force');

const downloadUrl = process.env.IBKR_GATEWAY_URL ?? DEFAULT_URL;
const installDir = process.env.IBKR_GATEWAY_DIR ?? DEFAULT_DIR;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function alreadyInstalled() {
  // The gateway zip ships a `dist/<jar>` and `bin/run.sh` + `bin/run.bat`.
  // Presence of those two paths is a good "installed and not corrupted"
  // proxy without parsing the jar contents.
  const distExists = await exists(join(installDir, 'dist'));
  const binExists = await exists(join(installDir, 'bin'));
  return distExists && binExists;
}

async function downloadTo(url, dest) {
  console.log(`→ downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  const file = createWriteStream(dest);
  // res.body is a Web ReadableStream; convert to Node by piping each chunk.
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    file.write(value);
  }
  await new Promise((resolveStream, reject) => {
    file.end((err) => (err ? reject(err) : resolveStream()));
  });
  console.log(`✓ saved to ${dest}`);
}

async function runProcess(command, args) {
  return new Promise((resolveProc, reject) => {
    const proc = spawn(command, args, { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolveProc();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function commandExists(command) {
  // Best-effort detection. `command -v` on POSIX, `where` on Windows.
  // We don't fail hard here — if the lookup itself errors we just say
  // "no" and the caller falls through to the next candidate.
  return new Promise((resolveCheck) => {
    const isWindows = process.platform === 'win32';
    const probe = isWindows ? 'where' : 'sh';
    const args = isWindows ? [command] : ['-c', `command -v ${command}`];
    const proc = spawn(probe, args, { stdio: 'ignore' });
    proc.on('error', () => resolveCheck(false));
    proc.on('exit', (code) => resolveCheck(code === 0));
  });
}

async function unzipTo(zipPath, dest) {
  console.log(`→ extracting to ${dest}`);
  await mkdir(dest, { recursive: true });
  // Cross-platform unzip without an npm dep. We try the most reliable
  // option per platform first, then fall back. GNU tar (the default on
  // most Linux distros) does NOT extract zip archives — that was the
  // bug Copilot caught — so prefer `unzip` on Unix.
  if (process.platform === 'win32') {
    // PowerShell's Expand-Archive ships with every Windows install since
    // 10. tar.exe (libarchive-backed) also works since Win10 1803, but
    // Expand-Archive is the documented Microsoft path.
    await runProcess('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${dest}" -Force`,
    ]);
  } else {
    // Unix: prefer `unzip`. If unavailable, try `bsdtar` (installed by
    // libarchive on macOS). GNU tar is the wrong tool for .zip and we
    // refuse to use it here.
    if (await commandExists('unzip')) {
      await runProcess('unzip', ['-q', '-o', zipPath, '-d', dest]);
    } else if (await commandExists('bsdtar')) {
      await runProcess('bsdtar', ['-xf', zipPath, '-C', dest]);
    } else {
      throw new Error(
        'Neither `unzip` nor `bsdtar` is installed. Install one (e.g. `apt install unzip`) and re-run.',
      );
    }
  }
  console.log(`✓ extracted`);
}

async function writeReadme() {
  const readmePath = join(installDir, 'README.local.md');
  const body = `# IBKR Client Portal Gateway (vendored locally)

This directory was populated by \`scripts/install-ibkr-gateway.mjs\`. The
contents are IBKR's intellectual property; this directory is gitignored.

To start the gateway:

\`\`\`powershell
# Windows
${join(installDir, 'bin', 'run.bat')} ${join(installDir, 'root', 'conf.yaml')}
\`\`\`

\`\`\`bash
# Unix
${join(installDir, 'bin', 'run.sh')} ${join(installDir, 'root', 'conf.yaml')}
\`\`\`

Then authenticate at https://localhost:5000 in a browser.

See \`docs/ibkr-setup.md\` for the full operator runbook.

To redownload (e.g. after IBKR ships an update), run:

\`\`\`bash
node scripts/install-ibkr-gateway.mjs --force
\`\`\`
`;
  await writeFile(readmePath, body, 'utf-8');
}

async function main() {
  if (!force && (await alreadyInstalled())) {
    console.log(`IBKR gateway already installed at ${installDir}`);
    console.log('  pass --force to redownload');
    return;
  }
  if (force && (await exists(installDir))) {
    console.log(`→ --force: removing existing ${installDir}`);
    await rm(installDir, { recursive: true, force: true });
  }

  const zipPath = join(tmpdir(), `clientportal.gw.${Date.now()}.zip`);
  try {
    await downloadTo(downloadUrl, zipPath);
    await unzipTo(zipPath, installDir);
    await writeReadme();
    console.log('');
    console.log('✓ IBKR gateway ready.');
    console.log(`  Install dir: ${installDir}`);
    console.log('  Next steps: see docs/ibkr-setup.md');
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('install failed:', err.message ?? err);
  process.exit(1);
});
