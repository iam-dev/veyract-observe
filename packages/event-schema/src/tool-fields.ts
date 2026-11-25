/**
 * TOOL_FIELDS (P1-07): the ONLY `tool_input` keys the projection ever reads, per built-in tool.
 * A tool that is not in this map (every MCP tool, every unknown or future tool) has no
 * `tool_input` key read at all. Keys marked sensitive-local are read only at that level.
 */
export interface ToolFieldSpec {
  /** Key holding the target path: path category at all levels, repo-relative path at sensitive-local only (R2-01). */
  readonly path?: 'file_path' | 'notebook_path' | 'path';
  /** Bash command: category at all levels, restricted form at `detailed`+, redacted text at sensitive-local. */
  readonly command?: 'command';
  /** TodoWrite `todos[].content` / `todos[].status`: sensitive-local only. */
  readonly todos?: 'todos';
  /**
   * Task / Agent: requested subagent type, classified like an agent type, at all levels. It goes to
   * `subagentType`; `agentType` / `agentId` always describe the caller (top-level fields).
   */
  readonly subagentType?: 'subagent_type';
  /** Task / Agent description: sensitive-local only. */
  readonly description?: 'description';
}

const FILE: ToolFieldSpec = Object.freeze({ path: 'file_path' });
const DIR: ToolFieldSpec = Object.freeze({ path: 'path' });
const SUBAGENT: ToolFieldSpec = Object.freeze({ subagentType: 'subagent_type', description: 'description' });

export const TOOL_FIELDS: ReadonlyMap<string, ToolFieldSpec> = new Map<string, ToolFieldSpec>([
  ['Read', FILE],
  ['Edit', FILE],
  ['MultiEdit', FILE],
  ['Write', FILE],
  ['NotebookEdit', Object.freeze({ path: 'notebook_path' })],
  ['Glob', DIR],
  ['Grep', DIR],
  ['LS', DIR],
  ['Bash', Object.freeze({ command: 'command' })],
  ['TodoWrite', Object.freeze({ todos: 'todos' })],
  ['Task', SUBAGENT],
  ['Agent', SUBAGENT],
]);
