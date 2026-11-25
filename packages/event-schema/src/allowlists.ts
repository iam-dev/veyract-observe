import type { DetailLevel, HashFn, Named } from './types.js';

const SOURCES = ['startup', 'resume', 'clear', 'compact'] as const;
const END_REASONS = ['clear', 'logout', 'prompt_input_exit'] as const;
const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export type SessionSource = typeof SOURCES[number] | 'other';
export type SessionEndReason = typeof END_REASONS[number] | 'other';
export type TodoStatus = typeof TODO_STATUSES[number] | 'other';

/** Unknown strings collapse to 'other'; only non-strings yield undefined. */
function bucket<T extends string>(known: readonly T[]): (raw: unknown) => T | 'other' | undefined {
  const set: ReadonlySet<string> = new Set(known);
  return (raw) => (typeof raw !== 'string' ? undefined : set.has(raw) ? (raw as T) : 'other');
}

export const sessionSource = bucket(SOURCES);
export const sessionEndReason = bucket(END_REASONS);
export const todoStatus = bucket(TODO_STATUSES);

/**
 * The allowlists are exported as frozen arrays for reference only. Classification uses private Sets, so a
 * consumer cannot widen what is kept (a ReadonlySet type does not stop `Set.prototype.add` at runtime).
 */
export const BUILTIN_TOOLS: readonly string[] = Object.freeze([
  'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'ExitPlanMode', 'AskUserQuestion', 'Skill', 'SlashCommand', 'ToolSearch',
]);

export const KNOWN_AGENT_TYPES: readonly string[] = Object.freeze([
  'general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide',
]);

const TOOL_SET: ReadonlySet<string> = new Set(BUILTIN_TOOLS);
const AGENT_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_AGENT_TYPES);

const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function classify(
  raw: unknown, level: DetailLevel, hash: HashFn, kind: 'tool' | 'agent-type',
  known: ReadonlySet<string>, bucketName: (raw: string) => string,
): Named | undefined {
  if (typeof raw !== 'string' || !NAME_PATTERN.test(raw)) return undefined;
  if (known.has(raw) || level !== 'metadata') return { name: raw };
  return { name: bucketName(raw), pseudonym: hash(kind, raw) };
}

/** Non-strings and malformed names yield undefined. */
export function classifyTool(raw: unknown, level: DetailLevel, hash: HashFn): Named | undefined {
  return classify(raw, level, hash, 'tool', TOOL_SET, (r) => (r.startsWith('mcp__') ? 'mcp' : 'other'));
}

export function classifyAgentType(raw: unknown, level: DetailLevel, hash: HashFn): Named | undefined {
  return classify(raw, level, hash, 'agent-type', AGENT_TYPE_SET, () => 'other');
}
