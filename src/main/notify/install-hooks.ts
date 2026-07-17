// Read/write ~/.claude/settings.json to install or remove the
// desktop-pet-notify hooks. Idempotent: install() on an already-installed
// setup is a no-op; uninstall() with our hooks missing is a no-op.
//
// Hook events we wire up:
//   PermissionRequest, Stop, SubagentStop, Notification, PostToolUse,
//   TaskCreated, TaskCompleted
//
// PostToolUse is filtered server-side in normalize.ts — only TodoWrite
// calls reach the renderer (every other tool would spam bubbles). Adding
// it to HOOK_EVENTS is necessary so Claude Code actually invokes the
// bridge for that event; what gets surfaced is a downstream concern.
//
// TaskCreated/TaskCompleted fire whenever TaskCreate / TaskUpdate marks
// a task done. TaskUpdate to in_progress fires PostToolUse (with
// tool_name=TaskUpdate), which we relay as a todo_update so the panel
// can flip the icon from ○ to ⏳ in real time.
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

const HOOK_EVENTS = [
  'PermissionRequest',
  'Stop',
  'SubagentStop',
  'Notification',
  'PostToolUse',
  'TaskCreated',
  'TaskCompleted',
] as const;
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
 *
 * Windows bridge: normalizes line endings to CRLF before writing. cmd.exe
 * refuses to parse .cmd files with LF-only line endings — it concatenates
 * `@echo off` and `setlocal` into a single unrecognizable command and
 * silently aborts before any user-defined command runs. The .gitattributes
 * pins CRLF on checkout, but we re-normalize here as a defense in depth so
 * a developer who edits the source on a Unix machine (or commits via a
 * tool that strips CRLF) still produces a working installed script.
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
    // Defense-in-depth CRLF normalization on Windows. .gitattributes already
    // pins .cmd to CRLF on checkout, but LF can sneak back in via copy/paste
    // from web docs or Unix editors. Normalize here so the install always
    // produces a script that cmd.exe can actually parse.
    if (isWin) {
      content = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
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

/**
 * Wrap a bridge script path in a form Claude Code can spawn correctly on
 * Windows regardless of which shell it picks.
 *
 * Claude Code picks the spawn shell via `process.env.SHELL || process.env.COMSPEC`.
 * When the user runs Claude Code from MINGW64 / Git Bash, $SHELL=/bin/bash.exe
 * is inherited, so hooks are spawned via `bash -c <command>`. A bare Windows
 * path like `C:\Users\admin\...\foo.cmd` gets mangled by bash: `\` is an escape
 * character, so `\U`, `\a`, `\R`, `\d`, `\s` are eaten and bash reports
 * `command not found`. The original bug surfaced exactly this way
 * (`C:UsersadminAppDataRoaming...desktop-pet-notify.cmd: command not found`).
 *
 * Two safe forms:
 *  - On Windows, wrap the .cmd path in `cmd //c "..."`. MSYS bash rewrites
 *    `//c` to `/c` before exec; cmd.exe receives the original path. This
 *    also works if Claude Code later picks cmd.exe directly via $COMSPEC
 *    (the inner `cmd /c` is a no-op-then-error path that's already handled
 *    by the bridge's `exit /b 0`).
 *  - On POSIX, just use the bridge script path directly.
 */
function wrapForShell(bridgeCommand: string, isWin: boolean): string {
  if (!isWin) return bridgeCommand;
  // The whole command needs to be one shell token after bash's escape pass.
  // Embedding the bridge path inside double quotes inside cmd //c means
  // bash sees literal quotes (which it doesn't strip in `-c` strings) and
  // passes them through to cmd.exe, which then strips them per its own
  // quoting rules. MSYS path translation handles the `//c` → `/c`.
  return `cmd //c "${bridgeCommand}"`;
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

/**
 * Detect an entry that points to our bridge script but in the OLD,
 * unwrapped form (bare `C:\...\desktop-pet-notify.cmd`). Used by
 * installHooks() to migrate users off the broken form on the next install.
 */
function matchesBareBridgeEntry(entry: unknown, rawBridgeCommand: string): boolean {
  const inner = (entry as any)?.hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some(
    (h: any) =>
      h && typeof h === 'object' && typeof h.command === 'string' && h.command === rawBridgeCommand,
  );
}

export function installHooks(opts: { userDataDir: string }): { ok: boolean; message: string } {
  const copied = copyBridgeScript(opts.userDataDir);
  if (!copied.ok) return copied;

  const isWin = process.platform === 'win32';
  const rawBridgeCommand = bridgeScriptPath(opts.userDataDir);
  // Wrap so Claude Code can spawn the bridge correctly regardless of which
  // shell it picks ($SHELL vs $COMSPEC). On Windows, MSYS bash would eat
  // backslashes from a bare `C:\...` path; see wrapForShell for details.
  const command = wrapForShell(rawBridgeCommand, isWin);
  const settings = readSettings();
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? (settings.hooks as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  let touched = 0;
  for (const ev of HOOK_EVENTS) {
    const list = hooks[ev] as unknown[] | undefined;
    if (findOurEntry(list, command)) continue;
    // Migration: if a previous install wrote the unwrapped (broken) form,
    // remove it before adding the wrapped one. Otherwise users get a stale
    // duplicate hook that fires (and fails) twice.
    const migrated = Array.isArray(list)
      ? list.filter((entry) => !matchesBareBridgeEntry(entry, rawBridgeCommand))
      : [];
    migrated.push(makeHookEntry(command));
    hooks[ev] = migrated;
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
