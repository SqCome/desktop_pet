// One-shot helper: writes a fresh config.json into the Electron userData
// directory. Useful the first time you set up the app.
//
// Usage:
//   node scripts/write-config.js                  # uses defaults (no key)
//   node scripts/write-config.js sk-xxx           # sets apiKey, keeps defaults
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Default config — same shape as src/shared/types.ts DEFAULT_CONFIG.
// If you change one, change the other.
const config = {
  // Keep configVersion in sync with CURRENT_CONFIG_VERSION in
  // src/shared/types.ts. Bumping it triggers storage.ts::migrate to
  // re-apply schema upgrades on next launch.
  configVersion: 2,
  alwaysOnTop: true,
  maxFps: 60,
  startHidden: false,
  pet: {
    mode: 'auto',
    assetDir: 'pet',
    sequenceFrameMs: 80,
    animation: {
      idleMotion: 'Idle',
      touchMotion: 'Flick',
      speakMotion: 'Idle',
      greetMotion: 'Shake',
      touchDurationMs: 2500,
      greetAfterIdleMs: 60_000,
      greetDurationMs: 2000,
    },
  },
  llm: {
    provider: 'minimax',
    // Verified working endpoint: api.minimaxi.com + MiniMax-M3 honors
    // `thinking: { type: 'disabled' }` and returns zero reasoning_tokens.
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: process.argv[2] || '',
    model: 'MiniMax-M3',
  },
};

// The userData folder name MUST match the running app's
// app.getPath('userData') — which uses package.json's `build.productName`
// (or `name` as a fallback), NOT just `name`. Mismatching the directory
// name means the script writes a file the app never reads.
function readProductName() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
    );
    return pkg.build?.productName || pkg.name || 'desktop-pet';
  } catch {
    return 'desktop-pet';
  }
}

function userDataDir() {
  const appName = readProductName();
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', appName);
    default:
      return path.join(home, '.config', appName);
  }
}

const dir = userDataDir();
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'config.json');
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');

console.log(`Wrote ${file}`);
if (!config.llm.apiKey) {
  console.log('  apiKey: (empty) — edit the file and add your key before chatting.');
} else {
  console.log('  apiKey: set (' + config.llm.apiKey.length + ' chars)');
}
