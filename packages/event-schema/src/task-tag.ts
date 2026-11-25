/**
 * Task-tag recognition: decides whether a PostToolUse Bash payload is the standalone command
 * `veyract observe task <ID|--none>` together with the CLI's confirmation line in stdout.
 *
 * The confirmation line is a marker that the command ran, not authentication: anything able to print
 * it can forge it, so a recognised tag is an external-observed hint, never evidence or authority.
 * There is no shell parser and no session service; compound commands and quoted mentions do not match.
 * stdout is read in memory only and no output text is returned. Only own data properties are read;
 * the function never throws on odd input.
 */
import { own } from './own.js';
import * as validate from './validate.js';

const CONFIRM_SOURCE = `^veyract-observe: (tagged (${validate.TASK_ID_SOURCE})|untagged) #[0-9a-f]{8}$`;
export const TASK_TAG_CONFIRM = new RegExp(CONFIRM_SOURCE, 'm');

const TASK_COMMAND = new RegExp(`^[ \\t]*veyract[ \\t]+observe[ \\t]+task[ \\t]+(${validate.TASK_ID_SOURCE}|--none)[ \\t]*$`);
const CONFIRM_LINE = new RegExp(CONFIRM_SOURCE);

export function recognizeTaskTag(raw: unknown): { sessionId: string; taskId: string | null } | null {
  if (own(raw, 'hook_event_name') !== 'PostToolUse' || own(raw, 'tool_name') !== 'Bash') return null;
  const sessionId = validate.sessionId(own(raw, 'session_id'));
  if (sessionId === undefined) return null;
  const command = own(own(raw, 'tool_input'), 'command');
  const stdout = own(own(raw, 'tool_response'), 'stdout');
  if (typeof command !== 'string' || typeof stdout !== 'string') return null;
  const m = TASK_COMMAND.exec(command);
  if (m === null) return null;
  const arg = m[1]!;
  const taskId = arg === '--none' ? null : arg; // TASK_COMMAND already enforced the task-id shape
  const expected = taskId === null ? 'untagged' : `tagged ${taskId}`;
  for (const line of stdout.split(/\r?\n/)) {
    const c = CONFIRM_LINE.exec(line);
    if (c !== null && c[1] === expected) return { sessionId, taskId };
  }
  return null;
}
