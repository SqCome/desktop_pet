// Chat — two-track UI:
//
// 1. **Bubbles** (`#bubble-stack`): transient speech-bubbles floating over
//    the pet. Used for the "live" feel — see what the pet is saying *now*.
//    Old bubbles auto-collapse into a "查看历史" chip.
//
// 2. **Chat history window** (`#chat-window`): a separate scrollable panel
//    showing the full conversation log, like a chat app. Opened via the
//    context menu's 📜 entry. Every user message and assistant reply is
//    appended here in real time. New messages auto-scroll into view.
//
// Both UIs receive every message, so the user can read the latest reply
// in a bubble OR scroll back through the conversation log — whatever fits
// their workflow.

import { getStateMachine } from './pet';

const THINKING_PHRASES = ['嗯...', '想想...', '让我想想...', '稍等...'];

export function setupChat(): void {
  const panel = document.getElementById('chat-panel') as HTMLDivElement;
  const input = document.getElementById('chat-input') as HTMLInputElement;
  const sendBtn = document.getElementById('chat-send') as HTMLButtonElement;
  const stopBtn = document.getElementById('chat-stop') as HTMLButtonElement;
  const stack = document.getElementById('bubble-stack') as HTMLDivElement;
  const chatWindow = document.getElementById('chat-window') as HTMLDivElement;
  const chatMessages = document.getElementById('chat-window-messages') as HTMLDivElement;
  const chatClose = document.getElementById('chat-window-close') as HTMLButtonElement;
  const chatHeader = chatWindow.querySelector('.chat-window-header') as HTMLElement;

  // ---------- shared state -------------------------------------------

  let streaming = false;
  let currentBubble: HTMLDivElement | null = null;
  let currentBubbleTextEl: HTMLDivElement | null = null;
  // Latest user bubble in this turn. Captured at onSend() so onDone()
  // can dismiss it together with the reply bubble 30s after the
  // stream finishes (user and reply share the same 30s clock).
  let currentUserBubble: HTMLDivElement | null = null;
  let currentLogRow: HTMLDivElement | null = null; // assistant's row in chat-window
  let rawReply = '';
  let firstByteTimer: number | null = null;
  const FIRST_BYTE_TIMEOUT_MS = 8_000;
  const REPLY_AUTO_CLOSE_MS = 30_000;

  // ---------- chat window controls -----------------------------------

  const openChatWindow = () => chatWindow.classList.remove('hidden');
  const closeChatWindow = () => chatWindow.classList.add('hidden');
  const isChatWindowOpen = () => !chatWindow.classList.contains('hidden');

  chatClose.addEventListener('click', closeChatWindow);

  // ---------- interactive lock while cursor is over the bubble stack --
  //
  // The BrowserWindow defaults to click-through (`setIgnoreMouseEvents(true,
  // {forward:true})`). The renderer's only "I'm over the pet" toggle is
  // the `mouseenter`/`mouseleave` pair on `#pet-canvas` (see pet.ts).
  // When the user moves the cursor from the pet onto a bubble, the
  // canvas fires `mouseleave`, main flips ignore-mouse back ON, and any
  // further click — including the × close button on a bubble — falls
  // through to the desktop. This was the "气泡关不掉" regression.
  //
  // Fix: while the cursor is over the bubble stack, hold an interactive
  // lock. The lock token-based API in main lets multiple panels hold
  // their own locks; we use a stable token `chat-bubble-stack` so the
  // menu (`menu-lock`) and chat input (`chat-panel-lock`) are unaffected.
  //
  // Note: we attach to `#bubble-stack` (the container), not each bubble.
  // The CSS for `#bubble-stack` was flipped from `pointer-events: none`
  // to `auto` so mouseenter/leave fire even when the cursor is over
  // the 8px gap between bubbles. Individual `.bubble` elements already
  // had `pointer-events: auto` for the close button to work.
  const BUBBLE_STACK_LOCK = 'chat-bubble-stack';
  stack.addEventListener('mouseenter', () => {
    window.petApi.pet.lockInteractive(BUBBLE_STACK_LOCK);
  });
  stack.addEventListener('mouseleave', () => {
    window.petApi.pet.unlockInteractive(BUBBLE_STACK_LOCK);
  });

  // Drag the window by its header. We do this in the renderer (rather than
  // asking main for a movable BrowserWindow) to keep this feature contained.
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  chatHeader.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    const rect = chatWindow.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - chatWindow.offsetWidth, e.clientX - dragOffsetX));
    const y = Math.max(0, Math.min(window.innerHeight - chatWindow.offsetHeight, e.clientY - dragOffsetY));
    chatWindow.style.left = `${x}px`;
    chatWindow.style.top = `${y}px`;
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  /** Append a row to the chat log (auto-scrolls to bottom). */
  const appendLogRow = (role: 'user' | 'assistant' | 'error' | 'system', text: string): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = `chat-msg ${role}`;
    row.textContent = text;
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return row;
  };

  const updateLogRow = (row: HTMLDivElement, text: string): void => {
    row.textContent = text;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };

  /** Fetch historical messages from main and populate the log on open. */
  const loadHistory = async (): Promise<void> => {
    chatMessages.innerHTML = '';
    try {
      const history = await window.petApi.chat.getHistory();
      if (!history || history.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-msg assistant';
        empty.textContent = '还没有聊天记录哦~ 跟主人打个招呼吧(◑‿◐)';
        empty.style.fontStyle = 'italic';
        empty.style.color = '#999';
        chatMessages.appendChild(empty);
        return;
      }
      for (const msg of history) {
        appendLogRow(msg.role, msg.content);
      }
    } catch (err) {
      appendLogRow('error', `加载历史失败: ${(err as Error).message}`);
    }
  };

  // ---------- bubble helpers -----------------------------------------

  /** Create a fresh bubble. Returns the bubble element. */
  const createBubble = (initialText: string, isThinking: boolean, role: 'assistant' | 'user' = 'assistant'): HTMLDivElement => {
    const bubble = document.createElement('div');
    const roleClass = role === 'user' ? ' role-user' : ' role-assistant';
    bubble.className = 'bubble' + roleClass + (isThinking ? ' thinking' : '');

    const text = document.createElement('div');
    text.className = 'bubble-text';
    if (isThinking) {
      text.textContent = initialText;
      const dots = document.createElement('span');
      dots.className = 'thinking-dots';
      dots.textContent = '...';
      text.appendChild(dots);
    } else {
      text.textContent = initialText;
    }
    bubble.appendChild(text);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'bubble-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', () => dismissBubble(bubble));
    bubble.appendChild(closeBtn);

    stack.appendChild(bubble);
    requestAnimationFrame(() => {
      bubble.classList.add('visible');
      // The stack is a normal `flex-direction: column` — newest bubble
      // is at the bottom of the column. Pin the scroll position to the
      // bottom so the latest message is always in view.
      stack.scrollTop = stack.scrollHeight;
    });

    // Auto-dismiss timers are NOT attached here — the 30s clock starts
    // only after the reply stream finishes (see onDone). Attaching the
    // timer at first-chunk would let it tick down while the reply is
    // still streaming, so a slow 25s reply would only stay on screen
    // for 5 more seconds after the last token. The thinking bubble
    // (isThinking=true) and the user bubble (role='user') both skip
    // this; onDone will schedule them as a pair.

    return bubble;
  };

  const dismissBubble = (bubble: HTMLElement): void => {
    bubble.classList.remove('visible');
    setTimeout(() => bubble.remove(), 250);
  };

  // ---------- streaming -----------------------------------------------

  const setStreaming = (on: boolean): void => {
    if (streaming === on) return;
    streaming = on;
    sendBtn.classList.toggle('hidden', on);
    stopBtn.classList.toggle('hidden', !on);
    getStateMachine()?.setSpeaking(on);

    if (on) {
      if (firstByteTimer !== null) window.clearTimeout(firstByteTimer);
      firstByteTimer = window.setTimeout(() => {
        firstByteTimer = null;
        if (streaming && currentBubble?.classList.contains('thinking')) {
          console.warn('[chat] first byte timeout, aborting');
          void window.petApi.chat.stop();
          if (currentBubble) dismissBubble(currentBubble);
          if (currentLogRow) {
            updateLogRow(currentLogRow, '主人~ 我脑子卡住啦,再说一次试试?(ᗒᗩᗕ)');
            currentLogRow.classList.remove('thinking');
            currentLogRow.classList.add('error');
          }
          currentBubble = null;
          currentBubbleTextEl = null;
          currentLogRow = null;
          setStreaming(false);
        }
      }, FIRST_BYTE_TIMEOUT_MS);
    } else {
      if (firstByteTimer !== null) {
        window.clearTimeout(firstByteTimer);
        firstByteTimer = null;
      }
    }
  };

  // ---------- actions -------------------------------------------------

  const onSend = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text) return;
    (window as unknown as { __petChatStart: number }).__petChatStart = performance.now();
    if (streaming) {
      await window.petApi.chat.stop();
      if (currentBubble && currentBubble.classList.contains('thinking')) {
        dismissBubble(currentBubble);
      }
      if (currentLogRow) currentLogRow.remove();
      currentBubble = null;
      currentBubbleTextEl = null;
      currentLogRow = null;
      rawReply = '';
    }
    input.value = '';

    // Log: append user message immediately
    appendLogRow('user', text);

    // Bubble: show user message on the right side of the bubble-stack.
    // No 30s timer here — onDone will pair it with the reply bubble so
    // both share one 30s clock that starts when the reply finishes.
    currentUserBubble = createBubble(text, false, 'user');

    // Bubble: show thinking indicator
    const phrase = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
    currentBubble = createBubble(phrase, true);
    currentBubbleTextEl = currentBubble.querySelector('.bubble-text') as HTMLDivElement;

    // Log: append a thinking placeholder for the assistant reply
    currentLogRow = appendLogRow('assistant', phrase + '...');

    setStreaming(true);

    try {
      await window.petApi.chat.send(text);
    } catch (err) {
      const msg = friendlyError(err);
      if (currentBubble) dismissBubble(currentBubble);
      if (currentLogRow) {
        updateLogRow(currentLogRow, msg);
        currentLogRow.classList.add('error');
      }
      setStreaming(false);
      currentBubble = null;
      currentBubbleTextEl = null;
      currentLogRow = null;
      currentUserBubble = null;
    }
  };

  const onStop = async (): Promise<void> => {
    await window.petApi.chat.stop();
  };

  sendBtn.addEventListener('click', onSend);
  stopBtn.addEventListener('click', onStop);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    } else if (e.key === 'Escape') {
      hidePanel();
    }
  });

  // ---------- IPC subscriptions --------------------------------------

  window.petApi.chat.onStream((chunk) => {
    if (!streaming) setStreaming(true);
    rawReply += chunk;

    // Bubble update
    if (currentBubble && currentBubbleTextEl) {
      if (currentBubble.classList.contains('thinking')) {
        const elapsed = Math.round(performance.now() - (window as unknown as { __petChatStart: number }).__petChatStart);
        console.log(`[chat] first chunk after ${elapsed}ms: ${JSON.stringify(chunk.slice(0, 30))}`);
        if (firstByteTimer !== null) {
          window.clearTimeout(firstByteTimer);
          firstByteTimer = null;
        }
        // The thinking bubble becomes the reply bubble in place. The
        // 30s auto-close timer is attached in onDone() (not here) so
        // it counts down from the END of the stream, not from the
        // first chunk — a 25s reply would otherwise vanish 5s after
        // the last token, which feels too fast.
        currentBubble.classList.remove('thinking');
        currentBubbleTextEl.textContent = chunk;
      } else {
        currentBubbleTextEl.textContent += chunk;
      }
    }

    // Chat log update (replace the thinking placeholder progressively)
    if (currentLogRow) {
      if (currentLogRow.classList.contains('thinking')) {
        currentLogRow.classList.remove('thinking');
        updateLogRow(currentLogRow, chunk);
      } else {
        currentLogRow.textContent = (currentLogRow.textContent || '') + chunk;
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    }
  });

  window.petApi.chat.onDone(() => {
    setStreaming(false);
    // The reply stream is complete — start the 30s auto-close clock for
    // this turn's pair of bubbles. Capturing the elements into local
    // consts means the timer closure still holds a valid reference
    // even though onDone nulls the module-level variables below.
    const replyBubble = currentBubble;
    const userBubble = currentUserBubble;
    if (replyBubble) {
      window.setTimeout(() => {
        if (replyBubble.isConnected) dismissBubble(replyBubble);
      }, REPLY_AUTO_CLOSE_MS);
    }
    if (userBubble) {
      window.setTimeout(() => {
        if (userBubble.isConnected) dismissBubble(userBubble);
      }, REPLY_AUTO_CLOSE_MS);
    }
    currentBubble = null;
    currentBubbleTextEl = null;
    currentLogRow = null;
    currentUserBubble = null;
    rawReply = '';
  });

  // ---------- menu integration ---------------------------------------

  window.__openChat = () => {
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      window.petApi.pet.lockInteractive('chat-panel');
      input.focus();
    } else {
      panel.classList.add('hidden');
      window.petApi.pet.unlockInteractive('chat-panel');
    }
  };

  window.__openHistory = () => {
    if (isChatWindowOpen()) {
      closeChatWindow();
    } else {
      openChatWindow();
      void loadHistory();
    }
  };

  window.addEventListener('pet:feedback', (e) => {
    const ce = e as CustomEvent<{ msg?: string }>;
    if (ce.detail?.msg) createBubble(ce.detail.msg, false);
  });

  // Main wipes chat history when the user has been idle for the session
  // timeout. Show a one-off bubble so the pet acknowledges the reset
  // (otherwise the next reply just arrives with no context and the user
  // is left wondering why the pet "forgot" the previous topic).
  window.petApi.pet.onSessionReset(() => {
    createBubble('主人~ 我们聊过一会儿啦,小柚脑子清空咯~ 重新打个招呼吧(◑‿◐)', false);
  });

  // Reminders fired by main (the cross-device scheduler pulls from a
  // Go backend). The text comes pre-formatted with an emoji prefix
  // since reminders tend to be terser than chat replies.
  //
  // The "知道了" button is a SEPARATE element below the bubble — not
  // the inline `.bubble-close` × which is hidden until hover and
  // overlaps the bubble edge. A standalone button is always visible,
  // always clickable, and easy to dismiss without aiming at a tiny ×.
  //
  // The wrap is mounted to #stage (not #bubble-stack) so its
  // `position: absolute` anchors to the window, not to the bubble
  // stack's bottom-pinned box. That keeps the reminder toast near
  // the top of the window even while other chat bubbles stream in
  // below.
  window.petApi.reminders.onFired((r) => {
    // Log end-to-end latency: how long from server fireAt to renderer
    // paint. Combined with main-side logs (`FIRE via sse|poll ... delayMs=...`)
    // this isolates which hop is slow:
    //   - sse/poll pull latency       → from main's `poll ... N rows in Xms`
    //   - server-side scheduling slip → from `delayMs=...` next to fireAt
    //   - IPC + render hop            → from this log
    const recvAt = Date.now();
    const fireToRecv = recvAt - r.fireAt;
    console.log(
      `[chat] reminder RECEIVED: id=${r.id} text="${r.text}" ` +
      `fireAt=${new Date(r.fireAt).toISOString()} ` +
      `fireToRecvMs=${fireToRecv} (createdAt=${new Date(r.createdAt).toISOString()})`,
    );

    // Single-card layout: icon · text · ack button — all inside one
    // rounded pill, so it reads as ONE unit, not two split halves.
    // The previous bubble + button split looked fragmented because
    // the flex children had mismatched widths.
    const card = document.createElement('div');
    card.className = 'reminder-card';
    card.setAttribute('role', 'alert');

    const icon = document.createElement('div');
    icon.className = 'reminder-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⏰';

    const text = document.createElement('div');
    text.className = 'reminder-text';
    text.textContent = r.text;

    const ack = document.createElement('button');
    ack.className = 'reminder-ack';
    ack.type = 'button';
    ack.textContent = '知道了';

    card.appendChild(icon);
    card.appendChild(text);
    card.appendChild(ack);

    const stage = document.getElementById('stage') as HTMLDivElement;
    stage.appendChild(card);

    // Trigger entrance animation on the next frame so the baseline
    // transform applies before the .visible class flips.
    requestAnimationFrame(() => card.classList.add('visible'));

    // As soon as the user moves the cursor over the card, mark it
    // settled so the sway stops. The card is still too small to
    // hit "知道了" while it's rocking ±8px @ 0.6s — the cursor
    // can't keep up. CSS does the rest: `.settled` overrides
    // sway+glow with just the color cycle, so the alert stays
    // visually active but the rocking stops.
    const settle = (): void => {
      card.classList.add('settled');
      card.removeEventListener('mouseenter', settle);
    };
    card.addEventListener('mouseenter', settle);

    const dismiss = (): void => {
      window.dispatchEvent(new CustomEvent('pet:reminder-dismiss'));
      card.classList.remove('visible');
      card.classList.add('dismissing');
      setTimeout(() => card.remove(), 320);
    };
    ack.addEventListener('click', dismiss);
    // Esc also dismisses — common UX expectation for toast-like alerts.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        dismiss();
        window.removeEventListener('keydown', onKey);
      }
    };
    window.addEventListener('keydown', onKey);

    window.dispatchEvent(new CustomEvent('pet:reminder-zoom'));
  });
}

function hidePanel(): void {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  panel.classList.add('hidden');
  window.petApi.pet.unlockInteractive('chat-panel');
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|unauthor/i.test(msg)) return '哎呀,API key 好像不对诶~ 检查下配置吧';
  if (/403|forbid/i.test(msg)) return '没权限访问,可能是 key 余额不足或被限流';
  if (/404|not found/i.test(msg)) return '找不到模型,检查 baseUrl 和 model 名';
  if (/network|fetch|timeout/i.test(msg)) return '网络好像断了,等下再试';
  if (/429|rate/i.test(msg)) return '说太快啦,休息一下再来';
  return `出了点小问题: ${msg.slice(0, 60)}`;
}