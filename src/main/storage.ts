// Persistent config storage. Uses a JSON file in app userData.
// Kept tiny on purpose — extend with sqlite or electron-store if it grows.
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, CURRENT_CONFIG_VERSION, DEFAULT_CONFIG } from '../shared/types';

const CONFIG_FILENAME = 'config.json';

let cache: AppConfig | null = null;

export function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

/**
 * Walk a parsed on-disk config forward through every schema version
 * between its stored version and CURRENT_CONFIG_VERSION. Each entry in
 * `migrations` upgrades the config one version. New versions only need
 * to add a function — never touch the older ones.
 *
 * Each migration mutates the passed `cfg` and returns it (for chaining).
 */
type Migration = (cfg: any) => any;

const migrations: Record<number, Migration> = {
  // v0 -> v1: baseline — every pre-versioned config is implicitly v0.
  // We don't actually need a function for this, but keep a no-op so the
  // table is symmetric and easy to reason about.
  0: (cfg) => {
    cfg.configVersion = 1;
    return cfg;
  },
  // v1 -> v2: the minimax chat-completions endpoint was migrated from
  // api.minimax.chat (model MiniMax-M1, ignores `thinking.disabled`)
  // to api.minimaxi.com (model MiniMax-M3, honors it). Rewrite any
  // user with the stale pair.
  1: (cfg) => {
    if (cfg.llm && cfg.llm.baseUrl === 'https://api.minimax.chat/v1') {
      cfg.llm.baseUrl = 'https://api.minimaxi.com/v1';
    }
    if (cfg.llm && cfg.llm.model === 'MiniMax-M1') {
      cfg.llm.model = 'MiniMax-M3';
    }
    cfg.configVersion = 2;
    return cfg;
  },
  // v2 -> v3: add remindersUrl + remindersToken (empty by default).
  // Existing configs without these fields just inherit the empty string
  // from DEFAULT_CONFIG via the shallow merge in loadConfig. The
  // migration ensures they appear in the file so the user can edit them
  // in the settings panel.
  2: (cfg) => {
    cfg.remindersUrl = typeof cfg.remindersUrl !== 'string' ? '' : cfg.remindersUrl;
    cfg.remindersToken = typeof cfg.remindersToken !== 'string' ? '' : cfg.remindersToken;
    cfg.configVersion = 3;
    return cfg;
  },
  // v3 -> v4: add claudeCodeNotify { serviceEnabled, hooksInstalled }.
  // Existing configs get both fields off (the user hasn't opted in yet);
  // the renderer/tray will toggle them via IPC. The shallow merge in
  // loadConfig would default the field at read time, but without writing
  // it here the on-disk config.json would never gain the field — so a
  // future user-initiated config:set wouldn't have it to update.
  3: (cfg) => {
    cfg.claudeCodeNotify = cfg.claudeCodeNotify && typeof cfg.claudeCodeNotify === 'object'
      ? cfg.claudeCodeNotify
      : {};
    cfg.claudeCodeNotify.serviceEnabled = cfg.claudeCodeNotify.serviceEnabled === true;
    cfg.claudeCodeNotify.hooksInstalled = cfg.claudeCodeNotify.hooksInstalled === true;
    cfg.configVersion = 4;
    return cfg;
  },
  // v4 -> v5: add windowWidth / windowHeight. Existing configs inherit
  // the 500×480 default from DEFAULT_CONFIG via the shallow merge in
  // loadConfig; writing them here ensures a user who has never opened
  // settings still gets explicit fields they can edit.
  4: (cfg) => {
    cfg.windowWidth = typeof cfg.windowWidth === 'number' && cfg.windowWidth >= 300 && cfg.windowWidth <= 4000
      ? cfg.windowWidth : 500;
    cfg.windowHeight = typeof cfg.windowHeight === 'number' && cfg.windowHeight >= 300 && cfg.windowHeight <= 4000
      ? cfg.windowHeight : 480;
    cfg.configVersion = 5;
    return cfg;
  },
  // v5 -> v6: add autoStart (default false). The user hasn't opted in yet.
  // app.setLoginItemSettings is called during boot in index.ts.
  5: (cfg) => {
    cfg.autoStart = cfg.autoStart === true;
    cfg.configVersion = 6;
    return cfg;
  },
};

function migrate(parsed: any, fromVersion: number): any {
  let cfg = parsed;
  for (let v = fromVersion; v < CURRENT_CONFIG_VERSION; v++) {
    const step = migrations[v];
    if (!step) {
      console.warn(`[storage] no migration step from v${v}; skipping`);
      cfg.configVersion = v + 1;
      continue;
    }
    console.log(`[storage] migrating config v${v} -> v${v + 1}`);
    cfg = step(cfg);
  }
  return cfg;
}

export function loadConfig(): AppConfig {
  if (cache) return cache;
  const file = getConfigPath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppConfig> & { configVersion?: number };
      const fromVersion = parsed.configVersion ?? 0;
      const migrated =
        fromVersion === CURRENT_CONFIG_VERSION
          ? parsed
          : migrate(parsed, fromVersion);
      // After migration, shallow-merge the result with DEFAULT_CONFIG so
      // brand-new fields added to DEFAULT_CONFIG still propagate.
      const merged: AppConfig = {
        ...DEFAULT_CONFIG,
        ...migrated,
        configVersion: CURRENT_CONFIG_VERSION,
        llm: { ...DEFAULT_CONFIG.llm, ...migrated.llm },
        claudeCodeNotify: { ...DEFAULT_CONFIG.claudeCodeNotify, ...migrated.claudeCodeNotify },
      };
      cache = merged;
      return merged;
    }
  } catch (err) {
    console.error('[storage] Failed to load config, falling back to defaults:', err);
  }
  cache = { ...DEFAULT_CONFIG };
  return cache;
}

export function saveConfig(next: AppConfig): void {
  // Always stamp the current version on disk. A future schema bump
  // wouldn't matter because loadConfig migrates up before merging.
  const stamped: AppConfig = { ...next, configVersion: CURRENT_CONFIG_VERSION };
  cache = stamped;
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(stamped, null, 2), 'utf-8');
  } catch (err) {
    console.error('[storage] Failed to save config:', err);
  }
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const current = loadConfig();
  const next: AppConfig = {
    ...current,
    ...patch,
    configVersion: CURRENT_CONFIG_VERSION,
    llm: { ...current.llm, ...(patch.llm ?? {}) },
  };
  saveConfig(next);
  return next;
}