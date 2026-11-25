/**
 * Hook payload projection: the privacy boundary of Observe.
 *
 * A raw Claude Code hook payload is untrusted and may carry file contents, command lines, prompts and
 * model output. It exists only in memory. This module builds a new ProjectedCapture from validated
 * values of the fields named in the mapping table and TOOL_FIELDS; nothing else is read, and nothing
 * is copied or spread from the input. Only own data properties are read (no inherited keys, no getters).
 * The input is expected to be JSON.parse output; projection does not throw on any such value.
 */
import { redactAndTruncate } from '@veyract/redaction';
import { classifyAgentType, classifyTool, sessionEndReason, sessionSource, todoStatus } from './allowlists.js';
import { commandCategory, restrictedForm } from './commands.js';
import { own, isRecord } from './own.js';
import { categoryOfRelative, relativePath } from './paths.js';
import { TOOL_FIELDS, type ToolFieldSpec } from './tool-fields.js';
import {
  HOOK_EVENT_TYPES, isDetailLevel, type DetailLevel, type EventType, type HashFn, type HookEventName, type ProjectedCapture,
  type SensitiveDetail,
} from './types.js';
import * as validate from './validate.js';

export interface ProjectionContext {
  level: DetailLevel;
  capturedAt: string;
  repoRoot: string | null;
  hash: HashFn;
}

/** `invalid-context`: the caller's context is unusable (unknown detail level); nothing is projected. */
export type RejectReason = 'malformed' | 'unsupported-event' | 'invalid-field' | 'invalid-context';

export type ProjectionResult =
  | { ok: true; capture: ProjectedCapture; sensitive?: SensitiveDetail }
  | { ok: false; reason: RejectReason };

const SENSITIVE_COMMAND_MAX = 500;
const TODO_SUBJECT_MAX = 200;
const TODO_MAX_ITEMS = 50;
const SUBAGENT_DESCRIPTION_MAX = 200;
/** Scan at most this many todo items, however few were usable (hook budget). */
const TODO_MAX_SCAN = 1_000;
/** C0/C1 controls, line/paragraph separators and bidi controls: never kept in a readable path. */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** A Map, not an object lookup: an inherited key such as 'constructor' must never match. */
const EVENT_TYPES: ReadonlyMap<string, EventType> = new Map(Object.entries(HOOK_EVENT_TYPES));

const reject = (reason: RejectReason): ProjectionResult => ({ ok: false, reason });

/** The CALLING agent (top-level `agent_id` / `agent_type`); absent on main-thread calls. */
function addCallerAgent(raw: object, capture: ProjectedCapture, ctx: ProjectionContext): void {
  const agentId = validate.agentId(own(raw, 'agent_id'));
  if (agentId !== undefined) capture.agentId = agentId;
  const agentType = classifyAgentType(own(raw, 'agent_type'), ctx.level, ctx.hash);
  if (agentType !== undefined) capture.agentType = agentType;
}

export function projectHookPayload(raw: unknown, ctx: ProjectionContext): ProjectionResult {
  if (!isRecord(ctx) || !isDetailLevel(ctx.level) || typeof ctx.hash !== 'function') return reject('invalid-context');
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
      const tool = classifyTool(own(raw, 'tool_name'), ctx.level, ctx.hash);
      if (tool === undefined) return reject('invalid-field');
      capture.tool = tool;
      break;
    }
    case 'SubagentStart':
    case 'SubagentStop':
      addCallerAgent(raw, capture, ctx);
      break;
    case 'Stop':
      break;
  }
  return { ok: true, capture };
}

function projectToolEvent(
  raw: object, hookEvent: HookEventName, capture: ProjectedCapture, ctx: ProjectionContext,
): ProjectionResult {
  const toolRaw = own(raw, 'tool_name');
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
  addCallerAgent(raw, capture, ctx);

  // Only built-in tools listed in TOOL_FIELDS have any tool_input key read (classifyTool proved a string).
  const spec: ToolFieldSpec | undefined = TOOL_FIELDS.get(toolRaw as string);
  const inputRaw = spec !== undefined ? own(raw, 'tool_input') : undefined;
  const input = isRecord(inputRaw) ? inputRaw : undefined;
  const field = (key: string | undefined): unknown => (input !== undefined && key !== undefined ? own(input, key) : undefined);

  // agentId / agentType always describe the caller; Task / Agent add the requested type separately.
  if (spec?.subagentType !== undefined) {
    const subagentType = classifyAgentType(field(spec.subagentType), ctx.level, ctx.hash);
    if (subagentType !== undefined) capture.subagentType = subagentType;
  }
  if (spec === undefined) return { ok: true, capture };

  const pathRaw = field(spec.path);
  const path = typeof pathRaw === 'string' ? pathRaw : undefined;
  const rel = path === undefined ? null : relativePath(path, ctx.repoRoot);
  if (spec.path !== undefined) capture.pathCategory = path === undefined ? 'none' : categoryOfRelative(rel);
  const commandRaw = field(spec.command);
  const command = typeof commandRaw === 'string' ? commandRaw : undefined;
  if (command !== undefined) capture.commandCategory = commandCategory(command);

  if (ctx.level === 'metadata') return { ok: true, capture };

  const form = command === undefined ? null : restrictedForm(command);
  if (form !== null) capture.detail = { command: form };

  if (ctx.level !== 'sensitive-local') return { ok: true, capture };

  const safeRel = rel !== null && !UNSAFE_PATH_CHARS.test(rel) ? rel : undefined;
  const sensitive = sensitiveDetail(spec, safeRel, command, field);
  return sensitive === undefined ? { ok: true, capture } : { ok: true, capture, sensitive };
}

function sensitiveDetail(
  spec: ToolFieldSpec, path: string | undefined, command: string | undefined,
  field: (key: string | undefined) => unknown,
): SensitiveDetail | undefined {
  const out: SensitiveDetail = {};
  if (path !== undefined) out.path = path;
  if (command !== undefined) out.command = redactAndTruncate(command, SENSITIVE_COMMAND_MAX);
  const todos = field(spec.todos);
  if (Array.isArray(todos)) {
    const subjects: NonNullable<SensitiveDetail['todoSubjects']> = [];
    for (let i = 0; i < todos.length && i < TODO_MAX_SCAN && subjects.length < TODO_MAX_ITEMS; i++) {
      const item = own(todos, String(i));
      if (!isRecord(item)) continue;
      const content = own(item, 'content');
      if (typeof content !== 'string') continue;
      subjects.push({
        subject: redactAndTruncate(content, TODO_SUBJECT_MAX),
        status: todoStatus(own(item, 'status')) ?? 'other',
      });
    }
    if (subjects.length > 0) out.todoSubjects = subjects;
  }
  const description = field(spec.description);
  if (typeof description === 'string') {
    out.subagentDescription = redactAndTruncate(description, SUBAGENT_DESCRIPTION_MAX);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
