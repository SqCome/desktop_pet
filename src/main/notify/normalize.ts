// Normalize raw Claude Code hook payloads into our internal NotifyPayload.
//
// Claude Code sends many hook events; we surface seven:
//   PermissionRequest -> permission_request
//   Notification      -> idle_prompt  (other Notification kinds dropped)
//   Stop              -> stop
//   SubagentStop      -> subagent_stop
//   PostToolUse       -> todo_update  (only when tool_name === TodoWrite;
//                                       every other tool is dropped)
//   TaskCreated       -> todo_update  (pushes the new task into the panel)
//   TaskCompleted     -> todo_update  (marks one task completed in panel)
//
// Both TaskCreated and TaskCompleted are mapped to `todo_update` so the
// renderer can use a single panel state model — the difference is just
// what fields to read from the payload. TaskUpdate (to in_progress) has
// no hook event in Claude Code; the panel shows those tasks as `pending`
// until the Completed hook lands.
//
// Everything else (PreToolUse, UserPromptSubmit, etc.) returns null and is
// dropped. We don't want every tool call to wake the pet — only the
// moments that actually require user attention.
import * as path from 'node:path';
import type { NotifyPayload, TodoItem } from '../../shared/types';

type Kind = NotifyPayload['kind'];

const KIND_TITLES: Record<Kind, string> = {
  permission_request: 'Claude Code 需要授权',
  idle_prompt: 'Claude Code 在等你',
  stop: 'Claude Code 任务完成',
  subagent_stop: 'Claude Code 子任务完成',
  todo_update: '任务清单已更新',
};

const TASK_HINT_MAX = 60;

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
  if (ev === 'PostToolUse') {
    // PostToolUse fires for every tool. We only want TodoWrite — the
    // checklist surface — and TaskUpdate — so we can track in_progress
    // status changes on tasks created via TaskCreate.
    // Bail for everything else to avoid spamming bubbles on
    // Read/Write/Bash/Grep/...
    const tool = isString(raw?.tool_name) ? raw.tool_name : '';
    return (tool === 'TodoWrite' || tool === 'TaskUpdate') ? 'todo_update' : null;
  }
  // TaskCreated/TaskCompleted drive the same per-agent task panel as
  // TodoWrite. Both events describe ONE task (not the full list), so the
  // renderer accumulates them — see renderer/notify.ts.
  if (ev === 'TaskCreated' || ev === 'TaskCompleted') {
    return 'todo_update';
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
    case 'todo_update': {
      // Brief summary for the bubble (the panel handles the full list).
      const todos = extractTodos(raw);
      if (!todos) return '清单已更新';
      const done = todos.filter((t) => t.status === 'completed').length;
      return `(${done}/${todos.length})`;
    }
  }
}

/**
 * Pull `todos` array out of the hook payload. Two shapes are supported:
 *
 *   1. TodoWrite (PostToolUse): `tool_input.todos` is the canonical list.
 *      Renderer replaces its per-agent state wholesale.
 *
 *   2. TaskCreated / TaskCompleted: the payload describes a SINGLE task
 *      (task_id / task_subject / task_description). We synthesize a
 *      one-item array so the renderer can run a single accumulator
 *      pipeline — the renderer accumulates per-agent across events,
 *      keying by `taskId`. New task = status pending; completed =
 *      status completed.
 *
 *   3. PostToolUse + TaskUpdate: fired when the agent marks a task
 *      in_progress (or toggles pending/completed). Carries taskId +
 *      status in tool_input. We synthesize a partial TodoItem that
 *      the renderer merges over the existing row — preserving the
 *      original content from the TaskCreated event.
 *
 * Defensive: malformed entries are skipped so a partial payload doesn't
 * break the panel.
 */
function extractTodos(raw: any): TodoItem[] | undefined {
  const ev = isString(raw?.hook_event_name) ? raw.hook_event_name : '';

  // Task* events: synthesize a single-item TodoItem from the task_* fields.
  // Claude Code's wire format for these events has historically bounced
  // between snake_case (task_id/task_subject/task_description) and camelCase
  // (taskId/taskSubject/taskDescription). Accept either so a payload shape
  // change upstream doesn't silently empty out the panel.
  if (ev === 'TaskCreated' || ev === 'TaskCompleted') {
    const taskId =
      (isString(raw?.task_id) && raw.task_id) ||
      (isString(raw?.taskId) && raw.taskId) ||
      undefined;
    const subject =
      (isString(raw?.task_subject) && raw.task_subject) ||
      (isString(raw?.taskSubject) && raw.taskSubject) ||
      '';
    if (!subject) return undefined;
    const item: TodoItem = {
      content: subject,
      status: ev === 'TaskCompleted' ? 'completed' : 'pending',
    };
    if (taskId) item.taskId = taskId;
    const desc =
      (isString(raw?.task_description) && raw.task_description) ||
      (isString(raw?.taskDescription) && raw.taskDescription) ||
      '';
    if (desc) item.activeForm = desc;
    return [item];
  }

  // PostToolUse + TaskUpdate: partial status update (in_progress).
  // The payload only carries task_id + status, not the full content.
  // The renderer merges this over the existing row by taskId.
  const tool = isString(raw?.tool_name) ? raw.tool_name : '';
  if (ev === 'PostToolUse' && tool === 'TaskUpdate') {
    const input = raw?.tool_input;
    const taskId =
      (input && isString(input.task_id) && input.task_id) ||
      (input && isString(input.taskId) && input.taskId) ||
      undefined;
    const status = input?.status;
    if (taskId && (status === 'pending' || status === 'in_progress' || status === 'completed')) {
      return [{ content: '', status, taskId }];
    }
    return undefined;
  }

  // TodoWrite: read the full list.
  const input = raw?.tool_input;
  const arr = Array.isArray(input?.todos) ? input.todos : undefined;
  if (!arr) return undefined;
  const cleaned: TodoItem[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const content = isString(entry.content) ? entry.content : '';
    if (!content) continue;
    const status = entry.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      continue;
    }
    const item: TodoItem = { content, status };
    if (isString(entry.activeForm)) item.activeForm = entry.activeForm;
    cleaned.push(item);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Extract a human-readable project name from the `transcript_path` Claude
 * Code sends on every hook.
 *
 * Claude Code stores transcripts at:
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl
 * where `<encoded-cwd>` is the working directory with each path separator
 * replaced by `--`. Concretely:
 *   D:\project-attendance-sys  →  D--project-attendance-sys
 *   C:\Users\admin             →  C--Users-admin
 *
 * To find `<encoded-cwd>` we walk up from the transcript looking for the
 * `.claude/projects` marker and take the segment right after `projects`.
 * That works uniformly for main agent and subagent transcripts — the
 * parent session id directory (between encoded-cwd and subagents/) is
 * NOT the project, but it's also NOT what we want.
 *
 * Why not just take the parent of `.claude`? Because that would be the
 * user's home directory (e.g. `admin`) — useless for distinguishing
 * between sessions in different projects.
 */
function pickProject(raw: any): string | undefined {
  const tp = isString(raw?.transcript_path) ? raw.transcript_path : '';
  if (!tp) return undefined;
  const normalized = tp.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  // Walk to find `.claude/projects/<encoded-cwd>` — the encoded cwd is
  // the segment immediately after `projects`.
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx < 0 || projectsIdx + 1 >= parts.length) return undefined;
  const encodedCwd = parts[projectsIdx + 1];
  // Encoded form uses `--` as the path separator; the drive letter is
  // glued to the first path segment (no separator), e.g. `D--foo--bar`.
  // Decode: replace `--` with the OS separator, but restore the drive
  // colon so `D--foo` → `D:\foo` not `D/foo`.
  const decoded = encodedCwd
    .replace(/^([A-Za-z])--/, '$1:\\')
    .replace(/--/g, path.sep);
  const basename = path.basename(decoded);
  // Sanity: if decoding yielded nothing or just a drive root, bail.
  if (!basename || basename === decoded && !decoded.includes(path.sep)) {
    return undefined;
  }
  return basename;
}

/**
 * Extract a short hint about what the agent was doing.
 *  - stop / subagent_stop: last assistant message, truncated to TASK_HINT_MAX.
 *  - permission_request: a one-line preview of what's being requested.
 *    Different tools have different shapes — Bash has a `command`, Edit
 *    has a `file_path`, Write has `file_path`, Read has `file_path`, etc.
 *    Pull whatever recognizable detail we have, single-line, truncated.
 *  - todo_update: brief summary like "(2/5)". Detailed list goes in `todos`.
 *  - idle_prompt: no hint — the prompt itself is the cue, a hint would be noise.
 */
function pickTaskHint(raw: any, kind: Kind): string | undefined {
  switch (kind) {
    case 'stop':
    case 'subagent_stop': {
      const msg = isString(raw?.last_assistant_message) ? raw.last_assistant_message : '';
      if (!msg) return undefined;
      // Strip whitespace runs and truncate. No fancy ellipsis — single char
      // '…' is enough and saves a column in the bubble.
      const cleaned = msg.replace(/\s+/g, ' ').trim();
      if (cleaned.length <= TASK_HINT_MAX) return cleaned;
      return cleaned.slice(0, TASK_HINT_MAX - 1) + '…';
    }
    case 'permission_request': {
      const tool = isString(raw?.tool_name) ? raw.tool_name : '';
      const input = (raw && typeof raw.tool_input === 'object' && raw.tool_input) || {};
      // Pick a representative one-liner based on the tool. If we don't
      // recognize the shape, fall back to the tool name alone.
      const detail =
        (typeof input.command === 'string' && `run: ${input.command}`) ||
        (typeof input.file_path === 'string' && `${path.basename(input.file_path)}`) ||
        (typeof input.pattern === 'string' && `pattern: ${input.pattern}`) ||
        (typeof input.url === 'string' && `fetch: ${input.url}`) ||
        (typeof input.query === 'string' && input.query);
      if (!detail) return tool || undefined;
      const cleaned = String(detail).replace(/\s+/g, ' ').trim();
      const prefix = tool ? `${tool}: ` : '';
      const combined = `${prefix}${cleaned}`;
      if (combined.length <= TASK_HINT_MAX) return combined;
      return combined.slice(0, TASK_HINT_MAX - 1) + '…';
    }
    case 'todo_update':
      return undefined;
    case 'idle_prompt':
      return undefined;
  }
}

/**
 * Convert a raw hook payload into a NotifyPayload. Returns null when the
 * hook should be dropped (unknown event, Notification subtype, or
 * PostToolUse for a non-TodoWrite tool).
 *
 * Defensive against missing/malformed fields: every field has a fallback.
 */
export function normalizeHook(raw: unknown): NotifyPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = pickKind(r);
  if (!kind) return null;

  const sessionId =
    // Claude Code emits snake_case `session_id` on the wire. Some internal
    // SDK surfaces also accept the camelCase alias — prefer the wire format,
    // fall back to camelCase, then to a random id. Stable sessionId is
    // required for the dedup window in bus.ts to collapse Claude Code's
    // retries on transient errors.
    (isString(r.session_id) && r.session_id.length > 0 && r.session_id) ||
    (isString(r.sessionId) && r.sessionId.length > 0 && r.sessionId) ||
    fallbackId();

  const project = pickProject(r);
  const taskHint = pickTaskHint(r, kind);

  // agent_id / agent_type are spread into every hook payload via pf()
  // (verified from Claude Code binary: src/tools/hooks/payload.ts::pf).
  // Main agent reports agent_id='main'; subagents report 'agent-<uuid>'
  // and an agent_type like 'general-purpose' or 'Explore'. Renderer uses
  // these to bucket todo lists per agent.
  const agentId = isString(r.agent_id) && r.agent_id.length > 0 ? r.agent_id : undefined;
  const agentType = isString(r.agent_type) && r.agent_type.length > 0 ? r.agent_type : undefined;

  const out: NotifyPayload = {
    sessionId,
    kind,
    title: KIND_TITLES[kind],
    body: pickBody(r, kind),
    project,
    taskHint,
    ts: Date.now(),
  };
  if (agentId) out.agentId = agentId;
  if (agentType) out.agentType = agentType;
  if (kind === 'todo_update') {
    const todos = extractTodos(r);
    if (todos) out.todos = todos;
  }
  return out;
}
