// Normalize raw Claude Code hook payloads into our internal NotifyPayload.
//
// Claude Code sends many hook events; we only surface four:
//   PermissionRequest -> permission_request
//   Notification      -> idle_prompt  (other Notification kinds dropped)
//   Stop              -> stop
//   SubagentStop      -> subagent_stop
//
// Everything else (PreToolUse, PostToolUse, UserPromptSubmit, etc.) returns
// null and is logged + dropped. We don't want every tool call to wake the
// pet — only the moments that actually require user attention.
import type { NotifyPayload } from '../../shared/types';

type Kind = NotifyPayload['kind'];

const KIND_TITLES: Record<Kind, string> = {
  permission_request: 'Claude Code 需要授权',
  idle_prompt: 'Claude Code 在等你',
  stop: 'Claude Code 任务完成',
  subagent_stop: 'Claude Code 子任务完成',
};

function fallbackId(): string {
  return Math.random().toString(36).slice(2);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function pickKind(raw: any): Kind | null {
  const ev = isString(raw?.hook_event_name) ? raw.hook_event_name : '';
  if (ev === 'PermissionRequest') return 'permission_request';
  if (ev === 'Stop') return 'stop';
  if (ev === 'SubagentStop') return 'subagent_stop';
  if (ev === 'Notification') {
    // Notification carries a `notification_type` field. Only `idle_prompt`
    // warrants a pet notification; auth_success / elicitation / etc. don't.
    const sub = isString(raw?.notification_type) ? raw.notification_type : '';
    return sub === 'idle_prompt' ? 'idle_prompt' : null;
  }
  return null;
}

function pickBody(raw: any, kind: Kind): string {
  switch (kind) {
    case 'permission_request': {
      const tool = isString(raw?.tool_name) ? raw.tool_name : '未知工具';
      return `工具:${tool} — 请回 Claude Code 批准`;
    }
    case 'idle_prompt':
      return '它已经停下等你输入啦';
    case 'stop':
      return '主任务跑完了,等你下一句';
    case 'subagent_stop':
      return '子 agent 完成,主流程继续中';
  }
}

/**
 * Convert a raw hook payload into a NotifyPayload. Returns null when the
 * hook should be dropped (unknown event or Notification subtype).
 *
 * Defensive against missing/malformed fields: every field has a fallback.
 */
export function normalizeHook(raw: unknown): NotifyPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = pickKind(r);
  if (!kind) return null;

  const sessionId =
    isString(r.sessionId) && r.sessionId.length > 0 ? r.sessionId : fallbackId();

  return {
    sessionId,
    kind,
    title: KIND_TITLES[kind],
    body: pickBody(r, kind),
    ts: Date.now(),
  };
}
