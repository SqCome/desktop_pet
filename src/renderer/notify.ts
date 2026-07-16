// Subscribe to NOTIFY_SHOW IPC events and surface them as bubbles +
// attention mood. No persistence — notifications are transient.
//
// The `window.petApi.notify` shape is declared globally in index.ts so
// other modules can share one declaration. We don't redeclare it here —
// doing so narrows the type and breaks TypeScript's interface merging
// in modules that don't import this file.
import type { PetStateMachine } from './state-machine';
import type { NotifyPayload } from '../shared/types';

const BUBBLE_DURATION_MS = 8000;

function showBubble(payload: NotifyPayload, onClick: () => void): void {
  const stack = document.getElementById('bubble-stack');
  if (!stack) return;

  const el = document.createElement('div');
  el.className = `bubble bubble-notify kind-${payload.kind}`;
  el.innerHTML = `
    <div class="bubble-title">${escapeHtml(payload.title)}</div>
    <div class="bubble-body">${escapeHtml(payload.body)}</div>
  `;
  el.addEventListener('click', onClick);
  stack.appendChild(el);

  // Trigger fade-in (CSS .bubble has transform/animation on append).
  window.setTimeout(() => {
    el.classList.add('bubble-fade-out');
    window.setTimeout(() => el.remove(), 400);
  }, BUBBLE_DURATION_MS);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setupNotify(sm: PetStateMachine): void {
  window.petApi.notify.onNotify((payload) => {
    sm.attention();
    showBubble(payload, () => {
      window.petApi.notify.focusPet().catch((err) => {
        console.warn('[notify] focusPet failed:', err);
      });
    });
  });
}