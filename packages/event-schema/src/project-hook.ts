/**
 * Hook payload projection: the privacy boundary of Observe.
 *
 * A raw Claude Code hook payload is untrusted and may carry file contents, command lines, prompts and
 * model output. It exists only in memory. This module builds a new ProjectedCapture from validated
 * values of the fields named in the mapping table and TOOL_FIELDS; nothing else is read, and nothing
 * is copied or spread from the input. Only own data properties are read (no inherited keys, no getters).
 * The input is expected to be JSON.parse output; projection does not throw on any such value.
 */
import { redact, truncate } from '@veyract/redaction';
import { classifyAgentType, classifyTool, sessionEndReason, sessionSource, todoStatus } from './allowlists.js';
import { commandCategory, restrictedForm } from './commands.js';
import { pathCategory, relativePath } from './paths.js';
import { TOOL_FIELDS, type ToolFieldSpec } from './tool-fields.js';
import type {
  DetailLevel, EventType, HashFn, HookEventName, Named, ProjectedCapture, SensitiveDetail,
} from './types.js';
import * as validate from './validate.js';

export interface ProjectionContext {
  level: DetailLevel;
  capturedAt: string;
  repoRoot: string | null;
  hash: HashFn;
}

export type RejectReason = 'malformed' | 'unsupported-event' | 'invalid-field';

export type ProjectionResult =
  | { ok: true; capture: ProjectedCapture; sensitive?: SensitiveDetail }
  | { ok: false; reason: RejectReason };

const SENSITIVE_COMMAND_MAX = 500;
const TODO_SUBJECT_MAX = 200;
const TODO_MAX_ITEMS = 50;
const SUBAGENT_DESCRIPTION_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const EVENT_TYPES: ReadonlyMap<string, EventType> = new Map<HookEventName, EventType>([
  ['SessionStart', 'session.started'],
  ['SessionEnd', 'session.ended'],
  ['UserPromptSubmit', 'prompt.submitted'],
  ['PreToolUse', 'tool.requested'],
  ['PostToolUse', 'tool.completed'],
  ['PostToolUseFailure', 'tool.failed'],
  ['PermissionRequest', 'permission.requested'],
  ['SubagentStart', 'subagent.started'],
  ['SubagentStop', 'subagent.stopped'],
  ['Stop', 'agent.stopped'],
]);

type Obj = object;

function isRecord(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own data property only: inherited keys and accessors are never read (no getter is invoked). */
function own(obj: Obj, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d !== undefined && 'value' in d ? d.value : undefined;
}

const reject = (reason: RejectReason): ProjectionResult => ({ ok: false, reason });

function classifyAgent(raw: unknown, ctx: ProjectionContext): Named | undefined {
  return typeof raw === 'string' ? classifyAgentType(raw, ctx.level, ctx.hash) : undefined;
}

export function projectHookPayload(raw: unknown, ctx: ProjectionContext): ProjectionResult {
  if (!isRecord(raw)) return reject('malformed');
  const hookEventRaw = own(raw, 'hook_event_name');
  if (typeof hookEventRaw !== 'string') return reject('malformed');
  const eventType = EVENT_TYPES.get(hookEventRaw);
  if (eventType === undefined) return reject('unsupported-event');
  const hookEvent = hookEventRaw as HookEventName;

  const sessionId = validate.sessionId(own(raw, 'session_id'));
  if (sessionId === undefined) return reject('invalid-field');

  const capture: ProjectedCapture = {
    schemaVersion: 1, eventType, hookEvent, sessionId, capturedAt: ctx.capturedAt, detailLevel: ctx.level,
  };
  const promptId = validate.promptId(own(raw, 'prompt_id'));
  if (promptId !== undefined) capture.promptId = promptId;

  switch (hookEvent) {
    case 'SessionStart': {
      const source = sessionSource(own(raw, 'source'));
      if (source !== undefined) capture.source = source;
      break;
    }
    case 'SessionEnd': {
      const reason = sessionEndReason(own(raw, 'reason'));
      if (reason !== undefined) capture.reason = reason;
      break;
    }
    case 'UserPromptSubmit': {
      const prompt = own(raw, 'prompt');
      if (typeof prompt === 'string') capture.promptLength = prompt.length;
      break;
    }
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return projectToolEvent(raw, hookEvent, capture, ctx);
    case 'PermissionRequest': {
      const toolRaw = own(raw, 'tool_name');
      const tool = typeof toolRaw === 'string' ? classifyTool(toolRaw, ctx.level, ctx.hash) : undefined;
      if (tool === undefined) return reject('invalid-field');
      capture.tool = tool;
      break;
    }
    case 'SubagentStart':
    case 'SubagentStop': {
      const agentId = validate.agentId(own(raw, 'agent_id'));
      if (agentId !== undefined) capture.agentId = agentId;
      const agentType = classifyAgent(own(raw, 'agent_type'), ctx);
      if (agentType !== undefined) capture.agentType = agentType;
      break;
    }
    case 'Stop':
      break;
  }
  return { ok: true, capture };
}

function projectToolEvent(
  raw: Obj, hookEvent: HookEventName, capture: ProjectedCapture, ctx: ProjectionContext,
): ProjectionResult {
  const toolRaw = own(raw, 'tool_name');
  if (typeof toolRaw !== 'string') return reject('invalid-field');
  const tool = classifyTool(toolRaw, ctx.level, ctx.hash);
  if (tool === undefined) return reject('invalid-field');
  capture.tool = tool;

  const toolUseId = validate.toolUseId(own(raw, 'tool_use_id'));
  if (toolUseId !== undefined) capture.toolUseId = toolUseId;
  if (hookEvent !== 'PreToolUse') {
    const durationMs = validate.durationMs(own(raw, 'duration_ms'));
    if (durationMs !== undefined) capture.durationMs = durationMs;
    capture.success = hookEvent === 'PostToolUse';
    if (hookEvent === 'PostToolUseFailure') {
      const isInterrupt = own(raw, 'is_interrupt');
      if (typeof isInterrupt === 'boolean') capture.isInterrupt = isInterrupt;
    }
  }
  const agentId = validate.agentId(own(raw, 'agent_id'));
  if (agentId !== undefined) capture.agentId = agentId;

  // Only built-in tools listed in TOOL_FIELDS have any tool_input key read.
  const spec: ToolFieldSpec | undefined = TOOL_FIELDS.get(toolRaw);
  const inputRaw = spec !== undefined ? own(raw, 'tool_input') : undefined;
  const input = isRecord(inputRaw) ? inputRaw : undefined;
  const field = (key: string | undefined): unknown => (input !== undefined && key !== undefined ? own(input, key) : undefined);

  // Task / Agent: the requested subagent type; other tools: the calling subagent's type.
  const agentType = classifyAgent(spec?.subagentType !== undefined ? field(spec.subagentType) : own(raw, 'agent_type'), ctx);
  if (agentType !== undefined) capture.agentType = agentType;
  if (spec === undefined) return { ok: true, capture };

  const pathRaw = field(spec.path);
  const path = typeof pathRaw === 'string' ? pathRaw : undefined;
  if (spec.path !== undefined) capture.pathCategory = pathCategory(path, ctx.repoRoot);
  const commandRaw = field(spec.command);
  const command = typeof commandRaw === 'string' ? commandRaw : undefined;
  if (command !== undefined) capture.commandCategory = commandCategory(command);

  if (ctx.level === 'metadata') return { ok: true, capture };

  const detail: { path?: string; command?: string } = {};
  if (path !== undefined) {
    const rel = relativePath(path, ctx.repoRoot);
    if (rel !== null && !CONTROL_CHARS.test(rel)) detail.path = rel;
  }
  if (command !== undefined) {
    const form = restrictedForm(command);
    if (form !== null) detail.command = form;
  }
  if (detail.path !== undefined || detail.command !== undefined) capture.detail = detail;

  if (ctx.level !== 'sensitive-local') return { ok: true, capture };

  const sensitive = sensitiveDetail(spec, command, field);
  return sensitive === undefined ? { ok: true, capture } : { ok: true, capture, sensitive };
}

function sensitiveDetail(
  spec: ToolFieldSpec, command: string | undefined, field: (key: string | undefined) => unknown,
): SensitiveDetail | undefined {
  const out: SensitiveDetail = {};
  let any = false;
  if (command !== undefined) {
    out.command = truncate(redact(command).text, SENSITIVE_COMMAND_MAX);
    any = true;
  }
  const todos = field(spec.todos);
  if (Array.isArray(todos)) {
    const subjects: Array<{ subject: string; status: NonNullable<ReturnType<typeof todoStatus>> }> = [];
    for (let i = 0; i < todos.length && subjects.length < TODO_MAX_ITEMS; i++) {
      const item = own(todos, String(i));
      if (!isRecord(item)) continue;
      const content = own(item, 'content');
      if (typeof content !== 'string') continue;
      subjects.push({
        subject: truncate(redact(content).text, TODO_SUBJECT_MAX),
        status: todoStatus(own(item, 'status')) ?? 'other',
      });
    }
    if (subjects.length > 0) {
      out.todoSubjects = subjects;
      any = true;
    }
  }
  const description = field(spec.description);
  if (typeof description === 'string') {
    out.subagentDescription = truncate(redact(description).text, SUBAGENT_DESCRIPTION_MAX);
    any = true;
  }
  return any ? out : undefined;
}
