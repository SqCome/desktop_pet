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
 */
export const CURRENT_CONFIG_VERSION = 3;

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
  /** Pet rendering mode. */
  pet: PetRenderConfig;
  /** LLM provider configuration. */
  llm: LlmConfig;
  /** Cross-device reminders service URL (Go remindersd backend). */
  remindersUrl: string;
  /** Bearer token for the reminders service. */
  remindersToken: string;
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