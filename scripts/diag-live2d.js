// Standalone diagnostic: tries to load the Live2D model in a headless-ish
// context (Node + jsdom-free, using just `fetch` and the static files) so we
// can see what's actually in the assets without going through Electron.
//
// Run with: node scripts/diag-live2d.js
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const modelDir = path.join(root, 'dist', 'renderer', 'assets', 'pet', 'live2d');
const modelJson = path.join(modelDir, 'pet.model3.json');

console.log('=== diag-live2d ===');
console.log('model dir:', modelDir);
console.log('exists:', fs.existsSync(modelJson));

if (!fs.existsSync(modelJson)) {
  console.error('ABORT: model3.json missing at expected path.');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(modelJson, 'utf-8'));
console.log('\n--- model3.json ---');
console.log('Version:', cfg.Version);
console.log('References:');
for (const [k, v] of Object.entries(cfg.FileReferences || {})) {
  if (Array.isArray(v)) {
    for (const item of v) {
      const full = path.join(modelDir, item);
      console.log(`  ${k}: ${item}  ${fs.existsSync(full) ? 'OK' : '❌ MISSING'}`);
    }
  } else if (typeof v === 'object') {
    for (const [group, files] of Object.entries(v)) {
      for (const f of files) {
        const full = path.join(modelDir, f.File);
        console.log(`  ${k}.${group}: ${f.File}  ${fs.existsSync(full) ? 'OK' : '❌ MISSING'}`);
      }
    }
  } else if (v) {
    const full = path.join(modelDir, v);
    console.log(`  ${k}: ${v}  ${fs.existsSync(full) ? 'OK' : '❌ MISSING'}`);
  }
}

console.log('\n--- moc3 sanity ---');
const mocPath = path.join(modelDir, cfg.FileReferences.Moc);
const mocBuf = fs.readFileSync(mocPath);
console.log('size:', mocBuf.length, 'bytes');
console.log('magic:', mocBuf.slice(0, 8).toString('ascii').replace(/\0/g, '\\0'));
// Live2D Cubism 4 moc3 magic is 'MOC3' (4 bytes). Cubism 3 / 2 use different magic.
if (mocBuf.slice(0, 4).toString('ascii') === 'MOC3') {
  console.log('format: Cubism 4 (.moc3) — supported');
} else if (mocBuf.slice(0, 4).toString('ascii') === 'MOC4') {
  console.log('format: Cubism 4 newer (.moc4) — may need newer pixi-live2d-display');
} else {
  console.log('format: UNKNOWN — likely Cubism 2/3, NOT supported by pixi-live2d-display v0.4');
  console.log('   expected "MOC3", got:', JSON.stringify(mocBuf.slice(0, 4).toString('ascii')));
}

console.log('\n--- texture sanity ---');
const texRel = cfg.FileReferences.Textures[0];
const texFull = path.join(modelDir, texRel);
console.log('path:', texRel);
console.log('exists:', fs.existsSync(texFull));
if (fs.existsSync(texFull)) {
  const sz = fs.statSync(texFull).size;
  console.log('size:', sz, 'bytes');
}

console.log('\n=== done ===');