// Build wrapper that strips signing env vars before launching electron-builder.
//
// Why: GitHub Actions windows-latest runners inject WIN_CSC_LINK=workspace_path
// into every step. electron-builder 24.13.3 reads it during initialization
// even when signAndEditExecutable=false. Setting it to '' via env: block
// doesn't help because '' is not null — getCscLink returns '' which then
// flows into importCertificate('', ...) and errors out with "not a file".
//
// The only way to make getCscLink return null is to make WIN_CSC_LINK truly
// undefined in process.env before electron-builder's top-level code runs.
const { spawn } = require('node:child_process');
const path = require('node:path');

const SIGN_VARS = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WINDOWS_CSC_LINK',
  'WINDOWS_CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_INSTALLER_LINK',
  'CSC_INSTALLER_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_KEY',
];

// Build a child env that omits signing vars entirely. We pass through
// everything else (PATH, HOME, etc.) so node + electron-builder can
// function normally.
const childEnv = { ...process.env };
for (const v of SIGN_VARS) {
  delete childEnv[v];
}

const args = process.argv.slice(2);
console.log(`[build-no-sign] stripped ${SIGN_VARS.length} sign env vars`);
console.log(`[build-no-sign] launching: npx electron-builder ${args.join(' ')}`);

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', ...args],
  { stdio: 'inherit', env: childEnv, shell: false },
);
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));