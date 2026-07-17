// Settings window: lets the user change LLM provider / baseUrl / apiKey /
// model without leaving the app. The underlying IPC is `config.get` /
// `config.set`, which `storage.ts` already round-trips through disk.
//
// Lifecycle:
//   - openSettings() loads current AppConfig and pre-fills the form.
//   - User edits, hits 保存.
//   - Save calls window.petApi.config.set({ llm: { ...patch } }); the
//     resulting AppConfig is what `loadConfig` returns next time the
//     chat handler fires.

import { AppConfig, LlmConfig, LLM_PROVIDER_DEFAULTS } from '../shared/types';

const STATUS_RESET_MS = 2500;

export function setupSettings(): void {
  const window_ = document.getElementById('settings-window') as HTMLDivElement;
  const closeBtn = document.getElementById('settings-window-close') as HTMLButtonElement;
  const saveBtn = document.getElementById('settings-save') as HTMLButtonElement;
  const statusEl = document.getElementById('settings-status') as HTMLSpanElement;
  const providerEl = document.getElementById('settings-provider') as HTMLSelectElement;
  const baseUrlEl = document.getElementById('settings-baseUrl') as HTMLInputElement;
  const apiKeyEl = document.getElementById('settings-apiKey') as HTMLInputElement;
  const modelEl = document.getElementById('settings-model') as HTMLInputElement;
  const remindersUrlEl = document.getElementById('settings-remindersUrl') as HTMLInputElement;
  const remindersTokenEl = document.getElementById('settings-remindersToken') as HTMLInputElement;
  const winWidthEl = document.getElementById('settings-winWidth') as HTMLInputElement;
  const winHeightEl = document.getElementById('settings-winHeight') as HTMLInputElement;
  const autoStartEl = document.getElementById('settings-autoStart') as HTMLInputElement;

  let isOpen = false;
  let statusTimer: number | null = null;

  const showStatus = (msg: string, isError: boolean = false) => {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', isError);
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = '';
      statusEl.classList.remove('error');
    }, STATUS_RESET_MS);
  };

  const open = async () => {
    if (isOpen) return;
    isOpen = true;
    window_.classList.remove('hidden');
    window.petApi.pet.lockInteractive('settings-window');

    // Pre-fill from current config. If the user has never set a key the
    // field stays empty — that's a friendly hint to fill it in.
    try {
      const cfg: AppConfig = await window.petApi.config.get();
      const llm = cfg.llm;
      providerEl.value = llm.provider;
      baseUrlEl.value = llm.baseUrl;
      apiKeyEl.value = llm.apiKey;
      modelEl.value = llm.model;
      remindersUrlEl.value = cfg.remindersUrl || '';
      remindersTokenEl.value = cfg.remindersToken || '';
      winWidthEl.value = String(cfg.windowWidth);
      winHeightEl.value = String(cfg.windowHeight);
      autoStartEl.checked = cfg.autoStart;
    } catch (err) {
      console.error('[settings] failed to load config:', err);
      showStatus('加载配置失败', true);
    }
  };

  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    window_.classList.add('hidden');
    window.petApi.pet.unlockInteractive('settings-window');
  };

  closeBtn.addEventListener('click', close);

  // Selecting a provider auto-fills baseUrl/model from the provider
  // defaults table. The user can still override either afterwards.
  providerEl.addEventListener('change', () => {
    const preset = LLM_PROVIDER_DEFAULTS[providerEl.value as LlmConfig['provider']];
    if (!preset) return;
    if (!baseUrlEl.value.trim() || baseUrlEl.dataset.touched !== 'true') {
      baseUrlEl.value = preset.baseUrl;
    }
    if (!modelEl.value.trim() || modelEl.dataset.touched !== 'true') {
      modelEl.value = preset.model;
    }
  });
  baseUrlEl.addEventListener('input', () => {
    baseUrlEl.dataset.touched = 'true';
  });
  modelEl.addEventListener('input', () => {
    modelEl.dataset.touched = 'true';
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const llm: LlmConfig = {
      provider: providerEl.value as LlmConfig['provider'],
      baseUrl: baseUrlEl.value.trim(),
      apiKey: apiKeyEl.value.trim(),
      model: modelEl.value.trim(),
    };

    if (!llm.baseUrl) {
      showStatus('Base URL 不能为空', true);
      saveBtn.disabled = false;
      return;
    }
    if (!llm.model) {
      showStatus('Model 不能为空', true);
      saveBtn.disabled = false;
      return;
    }

    try {
      const w = parseInt(winWidthEl.value, 10);
      const h = parseInt(winHeightEl.value, 10);
      if (isNaN(w) || isNaN(h) || w < 300 || h < 300 || w > 800 || h > 800) {
        showStatus('最小 300×300,最大 800×800', true);
        saveBtn.disabled = false;
        return;
      }
      await window.petApi.config.set({
        llm,
        windowWidth: w,
        windowHeight: h,
        autoStart: autoStartEl.checked,
        remindersUrl: remindersUrlEl.value.trim(),
        remindersToken: remindersTokenEl.value.trim(),
      });
      showStatus('已保存');
    } catch (err) {
      console.error('[settings] save failed:', err);
      showStatus('保存失败', true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // Allow Escape to close, matching chat-panel behavior.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) close();
  });

  // Expose open/close for index.ts to call when the menu's ⚙ button fires.
  (window as unknown as { __openSettings: () => void; __closeSettings: () => void }).__openSettings = open;
  (window as unknown as { __openSettings: () => void; __closeSettings: () => void }).__closeSettings = close;
}
