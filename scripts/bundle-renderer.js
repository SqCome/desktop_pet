// Bundles the renderer with esbuild.
// Single-file output keeps `loadFile()` simple and avoids path-resolution
// issues with pixi.js's deep import graph.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function main() {
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', 'src/renderer/index.ts')],
    bundle: true,
    outfile: path.resolve(__dirname, '..', 'dist/renderer/index.js'),
    platform: 'browser',
    target: 'es2020',
    format: 'esm',
    sourcemap: true,
    loader: {
      '.json': 'json',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.gif': 'file',
    },
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'info',
  });

  // Copy static assets (html + css) to dist/renderer.
  const srcDir = path.resolve(__dirname, '..', 'src/renderer');
  const outDir = path.resolve(__dirname, '..', 'dist/renderer');
  for (const file of ['index.html', 'styles.css']) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  }

  // Copy the `assets/` tree next to the renderer so model files (Live2D /
  // GIF / PNG sequence) are reachable via relative URLs like
  // `assets/pet/live2d/pet.model3.json`. Symlinking would be cleaner on
  // POSIX but Windows symlinks need elevation, so we copy recursively.
  const assetsSrc = path.resolve(__dirname, '..', 'assets');
  const assetsDst = path.join(outDir, 'assets');
  if (fs.existsSync(assetsSrc)) {
    copyRecursive(assetsSrc, assetsDst);
  }
}

function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

main().catch((err) => {
  console.error('[bundle-renderer] failed:', err);
  process.exit(1);
});