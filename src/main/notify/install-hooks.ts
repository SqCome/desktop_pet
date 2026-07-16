// Read/write ~/.claude/settings.json to install or remove the
// desktop-pet-notify hooks. Idempotent: install() on an already-installed
// setup is a no-op; uninstall() with our hooks missing is a no-op.
//
// Hook events we wire up:
//   PermissionRequest, Stop, SubagentStop, Notification
//
// `settings.json` shape (Claude Code):
//   {
//     "hooks": {
//       "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "<path>" }] }],
//       "Stop":              [...],
//       "SubagentStop":      [...],
//       "Notification":      [...]
//     }
//   }
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOOK_EVENTS = ['PermissionRequest', 'Stop', 'SubagentStop', 'Notification'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

const SCRIPT_NAME_WIN = 'desktop-pet-notify.cmd';
const SCRIPT_NAME_POSIX = 'desktop-pet-notify.sh';

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function bridgeScriptPath(userDataDir: string): string {
  const isWin = process.platform === 'win32';
  return path.join(
    userDataDir,
    'scripts',
    isWin ? SCRIPT_NAME_WIN : SCRIPT_NAME_POSIX,
  );
}

function readSettings(): Record<string, unknown> {
  const p = settingsPath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    }
  } catch (err) {
    console.warn('[install-hooks] settings.json unreadable, treating as empty:', err);
  }
  return {};
}

/**
 * Copy the bridge script from the bundled source to `userData/scripts/`.
 * Runs every install — overwrites if content drifted (dev iteration).
 * Skips silently if the source can't be found (asar / dev mode split).
 */
function copyBridgeScript(userDataDir: string): { ok: boolean; message: string } {
  const isWin = process.platform === 'win32';
  const srcRel = isWin
    ? path.join(__dirname, 'scripts', SCRIPT_NAME_WIN)
    : path.join(__dirname, 'scripts', SCRIPT_NAME_POSIX);
  const dst = path.join(userDataDir, 'scripts');
  const dstFile = bridgeScriptPath(userDataDir);

  try {
    fs.mkdirSync(dst, { recursive: true });
    let content: string;
    try {
      content = fs.readFileSync(srcRel, 'utf-8');
    } catch {
      // dev: ts files aren't compiled into a runnable script path here.
      // The source-of-truth lives in src/main/notify/scripts/ — copy from
      // project root via a relative walk from dist/main/notify/.. -> project root.
      const projectRoot = path.resolve(__dirname, '..', '..', '..');
      const fallback = path.join(
        projectRoot,
        'src',
        'main',
        'notify',
        'scripts',
        isWin ? SCRIPT_NAME_WIN : SCRIPT_NAME_POSIX,
      );
      content = fs.readFileSync(fallback, 'utf-8');
    }
    fs.writeFileSync(dstFile, content, 'utf-8');
    if (!isWin) fs.chmodSync(dstFile, 0o755);
    return { ok: true, message: `copied ${dstFile}` };
  } catch (err) {
    return { ok: false, message: `failed to copy bridge script: ${(err as Error).message}` };
  }
}

function makeHookEntry(command: string): Record<string, unknown> {
  return { hooks: [{ type: 'command', command }] };
}

function findOurEntry(entries: unknown[] | undefined, command: string): boolean {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const inner = (entry as any)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (h && typeof h === 'object' && (h as any).command === command) return true;
    }
  }
  return false;
}

export function installHooks(opts: { userDataDir: string }): { ok: boolean; message: string } {
  const copied = copyBridgeScript(opts.userDataDir);
  if (!copied.ok) return copied;

  const command = bridgeScriptPath(opts.userDataDir);
  const settings = readSettings();
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? (settings.hooks as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  let touched = 0;
  for (const ev of HOOK_EVENTS) {
    const list = hooks[ev] as unknown[] | undefined;
    if (findOurEntry(list, command)) continue;
    const next = Array.isArray(list) ? [...list] : [];
    next.push(makeHookEntry(command));
    hooks[ev] = next;
    touched++;
  }
  settings.hooks = hooks;

  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    return { ok: false, message: `failed to write settings.json: ${(err as Error).message}` };
  }
  return { ok: true, message: `installed ${touched} hook(s)` };
}

export function uninstallHooks(): { ok: boolean; message: string } {
  // Best-effort: uninstall doesn't know which userDataDir; the bridge
  // command is identified by its filename ending in "desktop-pet-notify".
  const settings = readSettings();
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? (settings.hooks as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  let removed = 0;
  for (const ev of HOOK_EVENTS) {
    const list = hooks[ev] as unknown[] | undefined;
    if (!Array.isArray(list)) continue;
    const filtered = list.filter((entry) => {
      const inner = (entry as any)?.hooks;
      if (!Array.isArray(inner)) return true;
      const cmd = (h: any) => typeof h?.command === 'string' ? h.command : '';
      const hasOurs = inner.some((h) => {
        const c = cmd(h);
        return c.endsWith('desktop-pet-notify.cmd') || c.endsWith('desktop-pet-notify.sh');
      });
      if (hasOurs) removed++;
      return !hasOurs;
    });
    if (filtered.length === 0) {
      delete hooks[ev];
    } else {
      hooks[ev] = filtered;
    }
  }
  settings.hooks = hooks;

  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    return { ok: false, message: `failed to write settings.json: ${(err as Error).message}` };
  }
  return { ok: true, message: `removed ${removed} hook(s)` };
}
