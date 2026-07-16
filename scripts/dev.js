// Cross-platform dev launcher.
// 1. Clean dist (so a previous Electron process holding files doesn't block).
// 2. Build main (tsc) + renderer (esbuild) once.
// 3. Launch Electron.
//
// We don't use tsc --watch because:
//   - The renderer doesn't go through tsc anymore (esbuild handles it).
//   - Long-running watchers conflict with `rimraf dist` on Windows (EBUSY).
//   - For a tiny project like this, full rebuilds are fast enough.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');

function step(label, cmd, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`[dev] ${label} failed with code ${result.status}`);
    process.exit(result.status || 1);
  }
}

// 1. Clean — try with rimraf first; if EBUSY, warn and continue (Electron
//    from a previous run may still be holding files).
try {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
} catch (err) {
  console.warn('[dev] clean warning:', err.message);
}

// 2. Build both halves.
//    Build the Go reminders server first. If `go` isn't on PATH or the
//    build fails, we still want to launch the desktop app — reminders
//    just won't work, but chat and the rest of the UI will. So this
//    step is non-fatal.
function tryStep(label, cmd, args) {
  console.log(`\n=== ${label} (best-effort) ===`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    console.warn(`[dev] ${label} failed with code ${result.status} — continuing without it`);
  }
}
tryStep('build reminders server', 'go', ['build', '-o', 'dist/server/remindersd', './server/cmd/remindersd']);
step('build main', 'npx', ['tsc', '-p', 'tsconfig.main.json']);
step('build renderer', 'node', ['scripts/bundle-renderer.js']);

// 3. Launch Electron in the foreground so Ctrl+C kills it cleanly.
// Pass through PET_DEBUG so the user can run `set PET_DEBUG=1 && npm run dev`
// in cmd or `$env:PET_DEBUG=1; npm run dev` in PowerShell without needing
// a shell-specific env-var prefix.
console.log('\n=== launch electron ===');
const electron = spawn('npx', ['electron', '.', '--disable-gpu'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: process.env, // inherits PET_DEBUG from the parent shell
});
electron.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => electron.kill('SIGINT'));
process.on('SIGTERM', () => electron.kill('SIGTERM'));