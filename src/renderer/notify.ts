// Subscribe to NOTIFY_SHOW IPC events and surface them as bubbles +
// attention mood. Also maintains a persistent task-checklist panel —
// one section per Claude Code session (a session = one claude process),
// updated in place as TodoWrite and Task* hooks fire.
//
// Sessions are grouped by session_id (each Claude Code process has a
// unique session_id) and assigned sequential labels #1, #2, … on first
// sighting. This lets the user distinguish multiple concurrent Claude
// sessions even in the same project directory.
//
// Two update shapes share this panel:
//   - TodoWrite (PostToolUse): payload.todos is the canonical full list.
//     We REPLACE the session's section wholesale.
//   - TaskCreated / TaskCompleted: payload.todos is a single item with
//     `taskId`. We MERGE it into the session's accumulated list, keying by
//     `taskId` so the same logical task never appears twice.
//
// The panel auto-shows on the first update and auto-clears each session's
// section once its list is fully completed (after a brief hold so the
// user can see "✓ all done" before it disappears).
//
// The `window.petApi.notify` shape is declared globally in index.ts so
// other modules can share one declaration. We don't redeclare it here —
// doing so narrows the type and breaks TypeScript's interface merging
// in modules that don't import this file.
import type { PetStateMachine } from './state-machine';
import type { NotifyPayload, TodoItem } from '../shared/types';

const BUBBLE_DURATION_MS = 8000;
// How long after a session finishes all its todos before we drop its
// section from the panel. Gives the user a moment to see "everything is
// done" before it disappears. Without this delay the section would flash
// away the instant the last tick lands — disorienting when running
// fast-finishing tasks.
const SESSION_FINISHED_HOLD_MS = 2500;

// Per-session state. Keyed by session_id — each Claude Code process (even
// in the same cwd) gets a unique session_id, so we can distinguish
// multiple concurrent Claude sessions hitting the same desktop-pet.
//
// `taskOrder` records the order in which tasks first appeared so the
// panel list stays stable even as statuses flip. Map keys = taskId (or
// array index for TodoWrite entries that have no taskId — those get a
// synthetic key derived from their content).
//
// Sessions are assigned sequential labels (#1, #2, …) on first sighting
// and keep that label until all their tasks are completed and removed.
interface SessionState {
  todos: TodoItem[];
  taskOrder: string[];
}
const sessionTodos = new Map<string, SessionState>();
// Order in which sessions first appeared — drives #1 / #2 numbering.
const sessionOrder: string[] = [];
// Pre-computed display labels keyed by sessionId.
const sessionLabels = new Map<string, string>();
const sessionRemovalTimers = new Map<string, number>();
let panelEl: HTMLElement | null = null;
// userToggledOff flips true when the user explicitly hides the panel via
// the menu. After that, new todo updates still update the underlying
// state (so toggling back on shows fresh data) but they don't re-show
// the panel automatically.
let userToggledOff = false;

function getPanel(): HTMLElement | null {
  if (panelEl && document.body.contains(panelEl)) return panelEl;
  panelEl = document.getElementById('todo-panel');
  return panelEl;
}

function showPanel(): void {
  const panel = getPanel();
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.classList.add('visible');
  userToggledOff = false;
}

function hidePanel(): void {
  const panel = getPanel();
  if (!panel) return;
  panel.classList.add('hidden');
  panel.classList.remove('visible');
}

function isPanelHidden(): boolean {
  return getPanel()?.classList.contains('hidden') ?? false;
}

/**
 * A list is "finished" when every item is completed (no in_progress,
 * no pending). At that point the session's section is no longer useful —
 * it would just show ✓ ✓ ✓ until the user manually closes it.
 */
function isListFinished(todos: TodoItem[]): boolean {
  return todos.length > 0 && todos.every((t) => t.status === 'completed');
}

function clearRemovalTimer(sessionId: string): void {
  const t = sessionRemovalTimers.get(sessionId);
  if (t !== undefined) {
    window.clearTimeout(t);
    sessionRemovalTimers.delete(sessionId);
  }
}

function scheduleRemoval(sessionId: string): void {
  clearRemovalTimer(sessionId);
  const timer = window.setTimeout(() => {
    sessionTodos.delete(sessionId);
    sessionRemovalTimers.delete(sessionId);
    // Clean up order/label tracking.
    const idx = sessionOrder.indexOf(sessionId);
    if (idx >= 0) sessionOrder.splice(idx, 1);
    sessionLabels.delete(sessionId);
    renderPanel();
  }, SESSION_FINISHED_HOLD_MS);
  sessionRemovalTimers.set(sessionId, timer);
}

/**
 * Pick a stable identity for a TodoItem. Task* events carry taskId; TodoWrite
 * entries don't — fall back to the content text, which is the natural
 * identity for the TodoWrite list (the agent passes the same content text
 * for the same logical item across writes).
 */
function taskKey(t: TodoItem): string {
  return t.taskId ?? `tw:${t.content}`;
}

/**
 * Update the panel for one session based on a NotifyPayload's todos.
 *
 * Sessions are keyed by sessionId — each Claude Code process has a unique
 * session_id. Sequential labels (#1, #2, …) are assigned on first sighting
 * and stable for the session's lifetime.
 *
 * Merge strategy depends on whether the items carry taskId:
 *   - All items have taskId (Task* events): merge by taskId — new tasks
 *     are appended, existing ones get status updates in place.
 *   - No items have taskId (TodoWrite): replace the list wholesale
 *     (Claude Code sends the canonical full list each write).
 *
 * After updating state, schedule or cancel the removal timer depending
 * on whether the new list is fully completed.
 */
function updateTodoPanel(payload: NotifyPayload): void {
  const sessionId = payload.sessionId || 'unknown';
  const incoming = payload.todos;
  if (!incoming) {
    console.log('[notify] updateTodoPanel: no todos in payload');
    return;
  }
  console.log('[notify] updateTodoPanel', sessionId, incoming.length, 'items');

  // Assign a sequential label on first sighting.
  if (!sessionLabels.has(sessionId)) {
    sessionOrder.push(sessionId);
    const projectPrefix = payload.project ? `${payload.project} ` : '';
    sessionLabels.set(sessionId, `${projectPrefix}#${sessionOrder.length}`);
  }

  const allHaveTaskId = incoming.every((t) => Boolean(t.taskId));
  const existing = sessionTodos.get(sessionId);

  if (allHaveTaskId) {
    // Merge into accumulated state.
    const state: SessionState = existing ?? { todos: [], taskOrder: [] };
    for (const item of incoming) {
      const key = taskKey(item);
      const idx = state.taskOrder.indexOf(key);
      if (idx === -1) {
        state.taskOrder.push(key);
        state.todos.push(item);
      } else {
        // Partial merge: TaskUpdate→PostToolUse only carries
        // taskId + status (no content). Preserve the existing row's
        // content/activeForm if the incoming item doesn't supply them.
        if (item.content) state.todos[idx].content = item.content;
        state.todos[idx].status = item.status;
        if (item.activeForm !== undefined) state.todos[idx].activeForm = item.activeForm;
      }
    }
    sessionTodos.set(sessionId, state);
  } else {
    // TodoWrite canonical list — replace wholesale.
    sessionTodos.set(sessionId, {
      todos: incoming.slice(),
      taskOrder: incoming.map(taskKey),
    });
  }

  const finalState = sessionTodos.get(sessionId)!;
  if (isListFinished(finalState.todos)) {
    scheduleRemoval(sessionId);
  } else {
    clearRemovalTimer(sessionId);
  }
  renderPanel();
}

function renderPanel(): void {
  const panel = getPanel();
  if (!panel) return;

  if (sessionTodos.size === 0) {
    console.log('[notify] renderPanel: no sessions, hiding');
    // No active sessions — panel auto-collapses. Avoids an empty box
    // lingering after the last task finishes.
    panel.innerHTML = '';
    hidePanel();
    return;
  }

  // Auto-show on first content (if user hasn't explicitly hidden it).
  // CSS uses .visible as the "has content" state (opacity:1, pointer-events:auto)
  // and .hidden as the user-toggled-off state. .visible and .hidden are independent
  // — removing .hidden alone leaves opacity:0 / pointer-events:none, so the panel
  // would be in DOM but invisible and non-interactive. Add .visible to actually
  // show it.
  if (!userToggledOff) {
    panel.classList.remove('hidden');
    panel.classList.add('visible');
  }

  const sections: string[] = [];
  for (const sessionId of sessionOrder) {
    const entry = sessionTodos.get(sessionId);
    if (!entry) continue;
    const label = sessionLabels.get(sessionId) || '?';
    const itemHtml = entry.todos
      .map((t, i) => renderTodoRow(t, sessionId, i))
      .join('');
    sections.push(`
      <div class="todo-section" data-session-id="${escapeHtml(sessionId)}">
        <div class="todo-section-header">${escapeHtml(label)}</div>
        <ul class="todo-list">${itemHtml}</ul>
      </div>
    `);
  }
  panel.innerHTML = sections.join('');
}

// ── Panel drag ─────────────────────────────────────────────────────────

const PANEL_LOCK = 'todo-panel';
const PANEL_DRAG_LOCK = 'todo-panel-drag';

/** Drag state, null when not dragging. */
let drag: { el: HTMLElement; startX: number; startY: number; startLeft: number; startTop: number } | null = null;

function initPanelDrag(): void {
  const panel = getPanel();
  if (!panel) return;

  // Keep the window interactive while the cursor is over the panel.
  // Without this, the pet canvas's mouseleave would disable it and the
  // panel would be invisible to mouse events.
  panel.addEventListener('mouseenter', () => window.petApi.pet.lockInteractive(PANEL_LOCK));
  panel.addEventListener('mouseleave', () => window.petApi.pet.unlockInteractive(PANEL_LOCK));

  // Event delegation: mousedown on any .todo-section-header starts a drag.
  panel.addEventListener('mousedown', (e) => {
    const header = (e.target as HTMLElement).closest('.todo-section-header') as HTMLElement | null;
    if (!header) return;
    e.preventDefault();
    // Extra lock during active drag: if the cursor leaves the panel while
    // dragging, the mouseenter/mouseleave lock would release and the
    // window would go click-through — killing the drag mid-move. A
    // separate drag lock keeps the window interactive until mouseup.
    window.petApi.pet.lockInteractive(PANEL_DRAG_LOCK);
    const rect = panel.getBoundingClientRect();
    drag = {
      el: panel,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    };
  });
}

document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  // Keep the panel fully within the window — never clipped by the
  // viewport edges. This is the simplest way to avoid clipping without
  // needing a full-screen window.
  const maxLeft = Math.max(0, window.innerWidth - drag.el.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - drag.el.offsetHeight);
  const left = Math.max(0, Math.min(maxLeft, drag.startLeft + dx));
  const top = Math.max(0, Math.min(maxTop, drag.startTop + dy));
  drag.el.style.left = `${left}px`;
  drag.el.style.top = `${top}px`;
});

document.addEventListener('mouseup', () => {
  if (drag) {
    window.petApi.pet.unlockInteractive(PANEL_DRAG_LOCK);
  }
  drag = null;
});

function renderTodoRow(todo: TodoItem, sessionId: string, index: number): string {
  let icon = '';
  let cls = 'todo-row todo-pending';
  if (todo.status === 'completed') {
    icon = '✓';
    cls = 'todo-row todo-completed';
  } else if (todo.status === 'in_progress') {
    icon = '⏳';
    cls = 'todo-row todo-in-progress';
  } else {
    icon = '○';
  }
  const tooltip = todo.activeForm && todo.activeForm !== todo.content
    ? ` title="${escapeHtml(todo.activeForm)}"`
    : '';
  return `
    <li class="${cls}" data-session-id="${escapeHtml(sessionId)}" data-index="${index}"${tooltip}>
      <span class="todo-icon">${icon}</span>
      <span class="todo-content">${escapeHtml(todo.content)}</span>
    </li>
  `;
}

export function toggleTodoPanel(): void {
  if (isPanelHidden()) {
    showPanel();
  } else {
    hidePanel();
    userToggledOff = true;
  }
}

function showBubble(payload: NotifyPayload, onClick: () => void): void {
  const stack = document.getElementById('bubble-stack');
  if (!stack) return;

  const el = document.createElement('div');
  el.className = `bubble bubble-notify kind-${payload.kind}`;
  const titleSuffix = payload.project
    ? ` <span class="bubble-project-suffix">· ${escapeHtml(payload.project)}</span>`
    : '';
  const tooltipParts: string[] = [];
  if (payload.taskHint) tooltipParts.push(payload.taskHint);
  if (payload.project) tooltipParts.push(`[${payload.project}]`);
  if (tooltipParts.length) el.title = tooltipParts.join(' · ');
  el.innerHTML = `
    <div class="bubble-title">${escapeHtml(payload.title)}${titleSuffix}</div>
    <div class="bubble-body">${escapeHtml(payload.body)}</div>
  `;
  el.addEventListener('click', onClick);
  stack.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add('visible');
    stack.scrollTop = stack.scrollHeight;
  });

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
  initPanelDrag();
  window.petApi.notify.onNotify((payload) => {
    console.log('[notify] onNotify', payload.kind, payload.todos?.length ?? 0, 'todos');
    sm.attention();
    if (payload.kind === 'todo_update') {
      updateTodoPanel(payload);
      return;
    }
    showBubble(payload, () => {
      window.petApi.notify.focusPet().catch((err) => {
        console.warn('[notify] focusPet failed:', err);
      });
    });
  });
}