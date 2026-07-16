// Minimal OpenAI-compatible chat client with streaming.
//
// Why OpenAI-compatible (rather than wiring each vendor separately)?
//   - OpenAI, Azure, Together, Groq, DeepSeek, Ollama, vLLM, LM Studio, etc.
//     all speak the same `/chat/completions` SSE shape.
//   - Anthropic has its own format — leave a TODO to add a second adapter if
//     you actually need it.
//
// Reasoning-model handling:
//   - Models like MiniMax-M1 emit `think...reasoning...think` blocks
//     before the visible reply. We strip them at two levels:
//       (a) main's chat history: only the visible text is persisted, so
//           history doesn't bloat with reasoning and request payloads stay
//           small.
//       (b) streamed deltas: renderer receives visible text only.
//   - The `onDelta` callback fires with the visible portion of each chunk.
//
// The renderer never touches the API key; it asks main to send a message
// and receives streamed deltas back over IPC.
import type { LlmConfig, ChatMessage } from '../../shared/types';

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

/**
 * Extract the user-visible text from a chunk of reasoning-model output.
 *
 * Strategy: derive state from the actual content (last open vs. last close
 * tag) on every chunk, instead of relying on a hand-maintained flag. Only
 * emit content while outside a think block.
 */
type State = 'NORMAL' | 'IN_THINK';

/**
 * If a think block opens and never closes (which MiniMax-M1 does on some
 * responses), we DO NOT try to recover content past the open tag — that
 * recovery heuristic leaked reasoning text into the UI. Instead we eat
 * the entire stream if it stays unclosed at the end.
 */
const OPEN_TAG = '<' + 'think' + '>';
const CLOSE_TAG = '<' + '/' + 'think' + '>';

export async function streamChat(
  cfg: LlmConfig,
  history: ChatMessage[],
  cb: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  // Defensive normalization. The persisted config can still hold the
  // stale api.minimax.chat + MiniMax-M1 pair if the user installed a
  // pre-migration build; rewrite it on the fly for this request only.
  // storage.ts::migrate also handles this on the next load — these
  // checks are belt-and-suspenders.
  let baseUrl = cfg.baseUrl;
  let model = cfg.model;
  if (baseUrl === 'https://api.minimax.chat/v1') {
    baseUrl = 'https://api.minimaxi.com/v1';
  }
  if (model === 'MiniMax-M1') {
    model = 'MiniMax-M3';
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  // History already includes the latest user turn (caller pushes before
  // calling). Strip defensively in case earlier turns leaked reasoning.
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: stripThink(m.content) })),
  ];

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.8,
        // Skip the model's chain-of-thought. Verified on
        // api.minimaxi.com/v1/chat/completions: the endpoint honors this
        // switch and returns zero reasoning_tokens, no ``<think>`` block.
        // For endpoints that don't know the field, OpenAI-style servers
        // typically ignore unknown top-level keys rather than 4xx — but
        // if a future provider starts rejecting, gate it on cfg.provider.
        thinking: { type: 'disabled' },
      }),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text || res.statusText}`);
    }

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // IMPORTANT: do NOT use TextDecoder with `stream: true` for UTF-8 here.
    // Multi-byte sequences can be split across chunks, and the streaming
    // decoder's behavior on those split bytes produced mojibake.
    // Instead we accumulate raw bytes and decode at the end of each SSE
    // line, where we know the byte boundary is safe (after the newline).
    const utf8 = new TextDecoder('utf-8');
    let pendingBytes = new Uint8Array(0);
    let state: State = 'NORMAL';
    let rawAccumulated = '';
    let lastVisibleLength = 0;
    let chunkCount = 0;
    const streamStart = Date.now();

    const emit = (visible: string) => {
      if (visible) {
        if (chunkCount === 0) {
          console.log(`[llm] first visible chunk after ${Date.now() - streamStart}ms: ${JSON.stringify(visible.slice(0, 30))}`);
        }
        chunkCount++;
        cb.onDelta(visible);
      }
    };

    const feed = (chunk: string): string => {
      rawAccumulated += chunk;

      // Snapshot the state derived from the content BEFORE we mutate
      // rawAccumulated via case-1 stripping.
      const lastOpenIdx = rawAccumulated.lastIndexOf(OPEN_TAG);
      const lastCloseIdx = rawAccumulated.lastIndexOf(CLOSE_TAG);
      const inThink =
        lastOpenIdx !== -1 &&
        (lastCloseIdx === -1 || lastCloseIdx < lastOpenIdx);
      state = inThink ? 'IN_THINK' : 'NORMAL';

      // Strip every closed think block in one pass. After this,
      // rawAccumulated contains only "between/after think blocks" text.
      // Re-derive state: if a close was the last tag we saw, we are NORMAL.
      rawAccumulated = rawAccumulated.replace(
        /<\/?think>[\s\S]*?<\/think>/g,
        '',
      );
      const afterOpen = rawAccumulated.lastIndexOf(OPEN_TAG);
      if (afterOpen !== -1) {
        // Unclosed open tag remains — stay IN_THINK no matter what.
        state = 'IN_THINK';
      } else {
        state = 'NORMAL';
      }

      console.log(
        `[llm][diag-state] chunk#${chunkCount} state=${state} ` +
        `rawAccumHead=${JSON.stringify(rawAccumulated.slice(0, 40))} ` +
        `rawAccumLen=${rawAccumulated.length}`,
      );

      // While inside an unclosed think block, suppress everything. Do not
      // touch lastVisibleLength — it stays at the value it had when we
      // last exited a think block, so the post-think content computes
      // a correct delta next time we go NORMAL.
      if (state === 'IN_THINK') {
        return '';
      }

      const visible = rawAccumulated;

      const delta = visible.slice(lastVisibleLength);
      lastVisibleLength = visible.length;
      return delta;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (pendingBytes.length > 0) {
          pendingBytes = new Uint8Array(0);
        }
        console.log(`[llm] stream done after ${Date.now() - streamStart}ms, ${chunkCount} visible chunks, pending state=${state}`);
        console.log(
          `[llm][diag] rawAccumulatedTail=${JSON.stringify(rawAccumulated.slice(-200))} ` +
          `rawAccumulatedLen=${rawAccumulated.length}`
        );
        break;
      }
      const next = new Uint8Array(pendingBytes.length + value.length);
      next.set(pendingBytes, 0);
      next.set(value, pendingBytes.length);
      pendingBytes = next;

      let lastNewline = -1;
      for (let i = pendingBytes.length - 1; i >= 0; i--) {
        if (pendingBytes[i] === 0x0a) {
          lastNewline = i;
          break;
        }
      }
      if (lastNewline === -1) continue;

      const completeBytes = pendingBytes.subarray(0, lastNewline);
      pendingBytes = pendingBytes.subarray(lastNewline + 1);
      const text = utf8.decode(completeBytes);
      const newLines = text.split('\n');

      let rawChunks = 0;
      for (const line of newLines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          console.log(`[llm] [DONE] received, total visible chunks=${chunkCount}, state=${state}`);
          cb.onDone();
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) {
            rawChunks++;
            const feedReturn = feed(delta);
            console.log(
              `[llm][diag] raw=${JSON.stringify(delta.slice(0, 120))} ` +
              `feedReturn=${JSON.stringify(feedReturn)} ` +
              `rawAccumLen=${rawAccumulated.length} state=${state}`
            );
            emit(feedReturn);
          }
        } catch {
          // Ignore malformed chunks — keep streaming.
        }
      }
      if (rawChunks > 0 && chunkCount === 0) {
        console.log(`[llm] ${rawChunks} raw delta(s) received but all suppressed as  think`);
      }
    }
    console.log(`[llm] stream ended without [DONE], total chunks=${chunkCount}, final state=${state}`);
    cb.onDone();
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      cb.onDone();
      return;
    }
    cb.onError(err as Error);
  }
}

/** Strip think blocks from already-stored text. */
export function stripThink(text: string): string {
  return text
    .replace(/<\/?think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\n]+/, '')
    .trim();
}

const SYSTEM_PROMPT = `你叫小柚,是一只活泼可爱的桌面宠物,住在主人电脑桌面上。

# 性格
- 俏皮、有点小傲娇、爱撒娇
- 称呼用户为"主人"
- 像朋友一样聊天,不端着

# 回复规则(务必遵守)
1. 简短:1-2 句话搞定,绝对不超过 50 个汉字
2. 口语化:用"嘛""呀""哦""哈"这种语气词
3. 不许用 Markdown 格式(不要列表、加粗、标题、代码块)
4. 直接回答用户的问题,不要复述问题
5. 不确定的事情要诚实说"我不确定诶",不要瞎编

# 你会的能力
- 闲聊、吐槽、讲冷笑话、夸主人
- 回答常识问题
- 不具备:查实时天气/新闻/股票等需要联网的能力 —— 这些问题要建议主人打开浏览器或专门 App

# 示例对话
主人:今天好累啊
小柚:辛苦啦主人~ 要不要我给你讲个冷笑话放松一下?(◑‿◐)

主人:北京今天多少度?
小柚:主人~ 我没法查实时天气诶,不过你可以看下电脑右下角的天气小工具,或者问我"穿什么出门"这种我能给点建议哦`;

export { stripThink as _stripThink };
