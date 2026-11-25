// Opaque identifiers are shape-checked only. Residual risk: a well-formed identifier could still
// carry attacker-chosen content within its character class and length bound.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_ID = /^[A-Za-z0-9]{1,64}$/;
const TASK_ID = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;

function match(re: RegExp, raw: unknown): string | undefined {
  return typeof raw === 'string' && re.test(raw) ? raw : undefined;
}

export const sessionId = (raw: unknown): string | undefined => match(UUID, raw);
export const promptId = (raw: unknown): string | undefined => match(UUID, raw);
export const toolUseId = (raw: unknown): string | undefined => match(TOOL_USE_ID, raw);
export const agentId = (raw: unknown): string | undefined => match(AGENT_ID, raw);
export const taskId = (raw: unknown): string | undefined => match(TASK_ID, raw);

export function durationMs(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 86_400_000 ? raw : undefined;
}
