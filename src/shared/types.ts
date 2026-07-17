// Shared types between main and renderer.

/**
 * Bump this whenever DEFAULT_CONFIG below changes in a way that should
 * propagate to users with an existing on-disk config.json. The loadConfig
 * migration in src/main/storage.ts walks every config version newer than
 * what's on disk up to CURRENT_CONFIG_VERSION.
 *
 *  v1: initial
 *  v2: minimax baseUrl api.minimax.chat -> api.minimaxi.com, model
 *      MiniMax-M1 -> MiniMax-M3 (the chat-completions endpoint on the new
 *      host honors `thinking: { type: 'disabled' }`; the old host ignored
 *      it, so reasoning leaked into the UI).
 *  v3: added remindersUrl + remindersToken for the cross-device reminders
 *      service (Go remindersd backend).
 *  v4: added claudeCodeNotify { serviceEnabled, hooksInstalled } for the
 *      Claude Code hook bridge (HTTP server + ~/.claude/settings.json hooks).
 *  v5: added windowWidth + windowHeight so users can resize the pet window
 *      from settings without losing the pet's visual scale.
 *  v6: added autoStart for OS-level login-item (app.setLoginItemSettings).
 */
export const CURRENT_CONFIG_VERSION = 6;

/**
 * Two independent switches for the Claude Code hook bridge:
 *  - serviceEnabled: turn on the local HTTP server that receives hooks.
 *  - hooksInstalled: whether ~/.claude/settings.json currently contains
 *    our desktop-pet-notify hooks.
 * Splitting them lets users run one without the other (e.g. disable
 * notifications temporarily without removing hooks).
 */
export interface ClaudeCodeNotifyConfig {
  serviceEnabled: boolean;
  hooksInstalled: boolean;
}

export interface PetPosition {
  x: number;
  y: number;
}

/** Window geometry snapshot — used by the renderer to save the user's
 * original drag-to position before a reminder zoom, so dismiss can
 * restore the window exactly where they had it. */
export interface PetBounds extends PetPosition {
  width: number;
  height: number;
}

export interface AppConfig {
  /** Schema version — see CURRENT_CONFIG_VERSION. */
  configVersion: number;
  /** Always-on-top layer. On Mac, this maps to NSFloatingWindowLevel variants. */
  alwaysOnTop: boolean;
  /** Frame rate cap (0 = uncapped). */
  maxFps: number;
  /** Start the app hidden in the tray. */
  startHidden: boolean;
  /** Launch on OS login (app.setLoginItemSettings). */
  autoStart: boolean;
  /** Pet window width in pixels. Configurable via settings. */
  windowWidth: number;
  /** Pet window height in pixels. Configurable via settings. */
  windowHeight: number;
  /** Pet rendering mode. */
  pet: PetRenderConfig;
  /** LLM provider configuration. */
  llm: LlmConfig;
  /** Cross-device reminders service URL (Go remindersd backend). */
  remindersUrl: string;
  /** Bearer token for the reminders service. */
  remindersToken: string;
  /** Claude Code hook bridge configuration. v4+ only. */
  claudeCodeNotify: ClaudeCodeNotifyConfig;
}

/**
 * Controls how the pet is rendered. `auto` picks the first asset that
 * exists in this priority: Live2D > GIF > PNG sequence > placeholder.
 */
export type PetRenderMode = 'auto' | 'live2d' | 'gif' | 'sequence';

export interface PetRenderConfig {
  mode: PetRenderMode;
  /** Folder under `assets/` to scan. Default `pet/`. */
  assetDir: string;
  /** Frame interval for PNG sequence mode (ms). Default 80ms ≈ 12fps. */
  sequenceFrameMs: number;
  /** Animation state machine tuning. */
  animation: PetAnimationConfig;
}

/**
 * Per-state tuning for the animation state machine. Each entry maps a
 * logical state (`idle`, `touch`, `speak`, `greet`) to the Live2D motion
 * group name to play. The model's `.model3.json` declares the actual
 * groups (e.g. `Idle`, `Tap`, `Shake`, `Flick`, ...) — change these
 * values to match what your specific model exposes.
 */
export interface PetAnimationConfig {
  /** Motion group played in the `idle` state. */
  idleMotion: string;
  /** Motion group played when the user clicks / taps the pet. */
  touchMotion: string;
  /** Motion group played while chat is streaming (often same as idle). */
  speakMotion: string;
  /** Motion group played for the proactive "hello" after long idle. */
  greetMotion: string;
  /** How long the `touch` state lasts before returning to idle (ms). */
  touchDurationMs: number;
  /** Time of no interaction before firing a proactive `greet` (ms). */
  greetAfterIdleMs: number;
  /** How long the `greet` state lasts (ms). */
  greetDurationMs: number;
}

export interface LlmConfig {
  /**
   * Identifies which provider preset to use. Affects the default `baseUrl`
   * (only if you leave it empty) and the UI hint in error messages. You
   * can override `baseUrl` for any provider — `custom` is the catch-all.
   */
  provider: 'openai' | 'minimax' | 'anthropic' | 'custom';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Per-provider defaults. `provider: 'minimax'` + empty baseUrl resolves to
 * the MiniMax public endpoint; same idea for openai. `custom` requires an
 * explicit baseUrl.
 */
export const LLM_PROVIDER_DEFAULTS: Record<LlmConfig['provider'], { baseUrl: string; model: string; docs: string }> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/',
  },
  minimax: {
    baseUrl: 'https://api.minimaxi.com/v1',
    // MiniMax-M3 is the current flagship. Verified: the minimaxi.com
    // chat-completions endpoint honors `thinking: { type: 'disabled' }`
    // — model returns the answer with zero reasoning_tokens, no
    // ``<think>`` block. Earlier M1 / api.minimax.chat were a wrong-host
    // wrong-model combination that ignored every disable switch.
    model: 'MiniMax-M3',
    docs: 'https://platform.minimaxi.com/',
  },
  anthropic: {
    // Anthropic uses its own format, not OpenAI-compatible. Setting this is
    // supported by name only — actual calls will fail until an anthropic
    // adapter is wired into llm/client.ts.
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    docs: 'https://docs.anthropic.com/',
  },
  custom: {
    baseUrl: '',
    model: '',
    docs: '',
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  configVersion: CURRENT_CONFIG_VERSION,
  alwaysOnTop: true,
  maxFps: 60,
  startHidden: false,
  autoStart: false,
  windowWidth: 500,
  windowHeight: 480,
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
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: '',
    model: 'MiniMax-M3',
  },
  remindersUrl: '',
  remindersToken: '',
  claudeCodeNotify: {
    serviceEnabled: false,
    hooksInstalled: false,
  },
};

/** Channels used across IPC. Keep them in one place so both ends agree. */
export const IPC = {
  CHAT_SEND: 'chat:send',
  CHAT_STREAM: 'chat:stream',
  CHAT_DONE: 'chat:done',
  CHAT_STOP: 'chat:stop',
  CHAT_HISTORY: 'chat:history',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  /** Renderer asks main to resize the window and return the old size.
   * Used by settings panel to grow the window temporarily so the form
   * displays fully, then restore on close. */
  CONFIG_SET_WINDOW_SIZE: 'config:set-window-size',
  /** Renderer requests app exit. Maps to app.exit(0) so the app fully
   * terminates — vs. window.close() which only hides to the tray. */
  APP_QUIT: 'app:quit',
  PET_DRAG: 'pet:drag',
  PET_INTERACTION: 'pet:interaction',
  /** Renderer asks main to move the BrowserWindow to the center of the
   * primary display. Used by the reminder-zoom flow so the whole pet
   * (window + contents) recenters, not just the inner canvas. */
  PET_CENTER: 'pet:center',
  /** Renderer asks main to resize the BrowserWindow. Used during a
   * reminder so the (scaled-up) pet has room to render without being
   * clipped by the default 320×360 chrome. */
  PET_RESIZE: 'pet:resize',
  /** Grow the window by (right, bottom) pixels while keeping the pet at
   * the same screen position. The pet is centered horizontally and
   * bottom-anchored — expanding right shifts the window left so the
   * center doesn't move; expanding down shifts the window up so the
   * bottom edge doesn't move. */
  PET_EXPAND: 'pet:expand',
  /** Renderer asks main to snapshot the current window geometry so it
   * can restore the user's original drag-to position after a reminder
   * dismisses (without forcing the window back to screen center). */
  PET_SNAPSHOT_BOUNDS: 'pet:snapshot-bounds',
  /** Renderer asks main to restore a previously snapshotted geometry. */
  PET_RESTORE_BOUNDS: 'pet:restore-bounds',
  /** Set an interactive lock (with a token name) — main keeps the window
   * interactive until `releaseInteractiveLock` is called with the same token.
   * Used by UI panels (menu, chat input) to keep events flowing while the
   * cursor is outside the pet canvas. */
  INTERACTIVE_LOCK: 'pet:interactive-lock',
  INTERACTIVE_UNLOCK: 'pet:interactive-unlock',
  /** Fired by main when the session idle timeout expires and the next
   * message starts a fresh conversation. Renderer shows a "memory wiped"
   * bubble. */
  SESSION_RESET: 'pet:session-reset',
  // Reminders: desktop-pet talks to a small Go backend (remindersd) that
  // stores cross-device reminders. The desktop side polls every 60s
  // and fires due reminders as chat bubbles. All requests carry
  // `Authorization: Bearer <REMINDERS_TOKEN>` in main (not exposed to
  // the renderer).
  REMINDERS_LIST: 'reminders:list',
  REMINDERS_ADD: 'reminders:add',
  REMINDERS_REMOVE: 'reminders:remove',
  /** Pushed from main → renderer when a reminder's fireAt has passed.
   * Renderer shows a bubble. */
  REMINDER_FIRED: 'reminder:fired',
  // Claude Code hook bridge: HTTP server in main, opt-in via tray.
  /** Start the local HTTP server that receives hook POSTs. */
  NOTIFY_ENABLE: 'notify:enable',
  /** Stop the HTTP server and delete the port file. */
  NOTIFY_DISABLE: 'notify:disable',
  /** Write ~/.claude/settings.json so Claude Code invokes our bridge. */
  NOTIFY_INSTALL_HOOKS: 'notify:install-hooks',
  /** Remove our hooks from ~/.claude/settings.json (preserves other hooks). */
  NOTIFY_UNINSTALL_HOOKS: 'notify:uninstall-hooks',
  /** Fire a synthetic notification for self-test. */
  NOTIFY_TEST: 'notify:test',
  /** Main → renderer push: show a notification bubble + attention mood. */
  NOTIFY_SHOW: 'notify:show',
  /** Renderer asks main to bring the pet window to the front. */
  NOTIFY_FOCUS_PET: 'notify:focus-pet',
} as const;

export type ChatMessage = {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  ts: number;
};

/**
 * A reminder stored in the cross-device reminders service (Go backend).
 * `userId` namespaces multi-tenant data; the desktop side hardcodes
 * 'local' until user-switching UI is added. `recurring` is reserved
 * for future expansion (current scheduler only handles 'none').
 */
export type Reminder = {
  id: string;
  userId: string;
  text: string;
  /** ms epoch. */
  fireAt: number;
  recurring: 'none' | 'daily' | 'weekly';
  acknowledged: boolean;
  /** ms epoch. */
  createdAt: number;
};

/**
 * Normalized hook payload the main process forwards to the renderer.
 * `kind` is one of four normalized event types; everything else from
 * Claude Code is dropped in normalizeHook().
 */
/**
 * One todo entry as the agent updates its TodoWrite checklist. Mirrors
 * Claude Code's TodoWrite payload shape (content, status, activeForm).
 * `activeForm` is the present-tense version of `content` shown while the
 * task is in progress (e.g. content="修 bug" / activeForm="正在修 bug");
 * we surface both — content as the row label, activeForm as the spinner
 * tooltip while in_progress.
 *
 * For TaskCreated/TaskCompleted hooks we synthesize TodoItem entries from
 * `task_id` / `task_subject` / `task_description`. We tag them with
 * `taskId` so the renderer can dedupe across multiple events for the
 * same logical task (TaskCreated fires once, TaskCompleted fires once,
 * no other events mention it).
 */
export type TodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  /** Set for entries derived from Task* hooks; lets renderer dedupe. */
  taskId?: string;
};

export type NotifyPayload = {
  /** Used for dedup. Provided by Claude Code, fallback = random. */
  sessionId: string;
  kind: 'permission_request' | 'idle_prompt' | 'stop' | 'subagent_stop' | 'todo_update';
  /** Rendered as bubble title (main pre-formats the Chinese text). */
  title: string;
  /** Bubble body, <= 80 chars. */
  body: string;
  /**
   * Project directory name derived from `transcript_path` (e.g.
   * `desktop_pet` for `E:\desktop_pet`). Lets the bubble disambiguate which
   * project the hook fired for when the user has multiple Claude Code
   * sessions running.
   */
  project?: string;
  /**
   * Short hint about what the agent just finished or is waiting on.
   * For `stop` / `subagent_stop`: last assistant message, truncated to
   * <= 60 chars. For `permission_request`: tool name + brief reason.
   * For `idle_prompt`: empty (the prompt itself is the cue).
   */
  taskHint?: string;
  /**
   * For `todo_update` only: the full checklist after the latest TodoWrite
   * call. Renderer replaces its panel state with this array (no diffing on
   * our side — Claude Code sends the canonical list each time).
   *
   * For TaskCreated/TaskCompleted, this is a single-item array containing
   * one synthesized TodoItem — the renderer accumulates these into its
   * per-agent map keyed by `taskId`.
   */
  todos?: TodoItem[];
  /**
   * Claude Code's per-agent identifier. Main agent = 'main'; subagents use
   * 'agent-<uuid>' for general-purpose ones. `sessionId` alone is NOT
   * enough to disambiguate: a single session can run main + many subagents
   * in parallel, each with its own TodoWrite list.
   */
  agentId?: string;
  /**
   * Human-readable agent type. Main = 'main'; subagents get values like
   * 'general-purpose', 'Explore', 'Plan'. Used as a panel header label so
   * the user can tell at a glance which agent's checklist they're reading.
   */
  agentType?: string;
  /** Optional context for the click handler (currently unused by focusPet). */
  focusHint?: { kind: 'ide' | 'terminal'; value: string };
  /** ms epoch. */
  ts: number;
};