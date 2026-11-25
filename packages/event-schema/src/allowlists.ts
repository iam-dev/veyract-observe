import type { DetailLevel, HashFn, Named } from './types.js';

export type SessionSource = 'startup' | 'resume' | 'clear' | 'compact' | 'other';
export type SessionEndReason = 'clear' | 'logout' | 'prompt_input_exit' | 'other';
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'other';

const SOURCES: ReadonlySet<string> = new Set(['startup', 'resume', 'clear', 'compact']);
const END_REASONS: ReadonlySet<string> = new Set(['clear', 'logout', 'prompt_input_exit']);
const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

export const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'ExitPlanMode', 'AskUserQuestion', 'Skill', 'SlashCommand', 'ToolSearch',
]);

export const KNOWN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide',
]);

const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Unknown strings collapse to 'other'; only non-strings yield undefined. */
export function sessionSource(raw: unknown): SessionSource | undefined {
  if (typeof raw !== 'string') return undefined;
  return SOURCES.has(raw) ? (raw as SessionSource) : 'other';
}

export function sessionEndReason(raw: unknown): SessionEndReason | undefined {
  if (typeof raw !== 'string') return undefined;
  return END_REASONS.has(raw) ? (raw as SessionEndReason) : 'other';
}

export function todoStatus(raw: unknown): TodoStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  return TODO_STATUSES.has(raw) ? (raw as TodoStatus) : 'other';
}

function classify(
  raw: string, level: DetailLevel, hash: HashFn, kind: 'tool' | 'agent-type',
  known: ReadonlySet<string>, bucket: (raw: string) => string,
): Named | undefined {
  if (typeof raw !== 'string' || !NAME_PATTERN.test(raw)) return undefined;
  if (known.has(raw)) return { name: raw };
  if (level !== 'metadata') return { name: raw };
  return { name: bucket(raw), pseudonym: hash(kind, raw) };
}

export function classifyTool(raw: string, level: DetailLevel, hash: HashFn): Named | undefined {
  return classify(raw, level, hash, 'tool', BUILTIN_TOOLS, (r) => (r.startsWith('mcp__') ? 'mcp' : 'other'));
}

export function classifyAgentType(raw: string, level: DetailLevel, hash: HashFn): Named | undefined {
  return classify(raw, level, hash, 'agent-type', KNOWN_AGENT_TYPES, () => 'other');
}
