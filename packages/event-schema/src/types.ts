import type { SessionSource, SessionEndReason, TodoStatus } from './allowlists.js';

export type DetailLevel = 'metadata' | 'detailed' | 'sensitive-local';

export type HookEventName =
  | 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'
  | 'PostToolUseFailure' | 'PermissionRequest' | 'SubagentStart' | 'SubagentStop' | 'Stop';

export type EventType =
  | 'session.started' | 'session.ended' | 'prompt.submitted' | 'tool.requested' | 'tool.completed'
  | 'tool.failed' | 'permission.requested' | 'subagent.started' | 'subagent.stopped' | 'agent.stopped';

export type PathCategory = 'source' | 'test' | 'config' | 'docs' | 'outside' | 'none';

export type CommandCategory =
  | 'git' | 'test' | 'package' | 'build' | 'file' | 'search' | 'network' | 'container' | 'observe' | 'other';

/** Caller-supplied keyed hash; pure code in this package never sees a secret. */
export type HashFn = (kind: 'tool' | 'agent-type' | 'model' | 'stream', value: string) => string;

/**
 * A name that is either an allowlisted value, or 'mcp' / 'other' with `pseudonym = hash(kind, original)`
 * at `metadata`. At `detailed` / `sensitive-local`, `name` is the validated original and `pseudonym` is omitted.
 */
export interface Named { name: string; pseudonym?: string }

/**
 * A ProjectedCapture is not a durable event: no event id, no sequence, no trust level.
 * The spool envelope (Plan 2) and the stored observation (Plan 3) add those.
 */
export interface ProjectedCapture {
  schemaVersion: 1;
  eventType: EventType;
  hookEvent: HookEventName;
  sessionId: string;
  capturedAt: string;
  detailLevel: DetailLevel;
  promptId?: string;
  tool?: Named;
  toolUseId?: string;
  durationMs?: number;
  success?: boolean;
  isInterrupt?: boolean;
  source?: SessionSource;
  reason?: SessionEndReason;
  agentId?: string;
  agentType?: Named;
  promptLength?: number;
  pathCategory?: PathCategory;
  commandCategory?: CommandCategory;
  detail?: { path?: string; command?: string };
}

/** Associated with its parent capture by the caller (Plan 2 spool row). */
export interface SensitiveDetail {
  command?: string;
  todoSubjects?: Array<{ subject: string; status: TodoStatus }>;
  subagentDescription?: string;
}
