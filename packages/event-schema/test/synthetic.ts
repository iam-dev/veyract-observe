/**
 * Synthetic Claude Code hook payloads. Field NAMES follow the hook payload shapes of
 * Claude Code 2.1.332; every VALUE is synthetic. Values that would look like real
 * identifiers (tool-use ids) are assembled from fragments so the repo privacy check
 * never sees such a literal.
 */

export const REPO_ROOT = '/repo';
export const SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const PROMPT_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
export const AGENT_ID = 'a1b2c3d4e5f6a7b8c';
export const TOOL_USE_ID = ['tool', 'u_', 'Syn', 'thetic', '0123456789'].join('');

/** Returns a distinct planted value for the given label; every value must be findable in output. */
export type Plant = (label: string) => string;

export interface SyntheticPayload {
  /** e.g. 'PostToolUse:Edit' */
  name: string;
  payload: Record<string, unknown>;
}

function common(plant: Plant, event: string): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    transcript_path: `/tmp/synthetic/${plant('transcript_path')}.jsonl`,
    cwd: `/tmp/synthetic/${plant('cwd')}`,
    hook_event_name: event,
    prompt_id: PROMPT_ID,
    permission_mode: plant('permission_mode'),
    effort: { level: plant('effort.level') },
    future_field: plant('future_field'),
  };
}

interface ToolCase {
  tool: string;
  input: (plant: Plant) => Record<string, unknown>;
  response: (plant: Plant) => Record<string, unknown>;
}

/** Tools covered by layer 1; the MCP tool carries "tempting" keys that must never be read. */
export const TOOL_CASES: readonly ToolCase[] = [
  {
    tool: 'Read',
    input: () => ({ file_path: `${REPO_ROOT}/src/app.ts` }),
    response: (p) => ({ type: 'text', file: { filePath: p('response.file.filePath'), content: p('response.file.content'), numLines: 3 } }),
  },
  {
    tool: 'Edit',
    input: (p) => ({ file_path: `${REPO_ROOT}/src/app.ts`, old_string: p('input.old_string'), new_string: p('input.new_string') }),
    response: (p) => ({
      filePath: p('response.filePath'), oldString: p('response.oldString'), newString: p('response.newString'),
      originalFile: p('response.originalFile'), structuredPatch: [{ lines: [p('response.structuredPatch')] }],
      userModified: false, replaceAll: false,
    }),
  },
  {
    tool: 'Write',
    input: (p) => ({ file_path: `${REPO_ROOT}/test/app.test.ts`, content: p('input.content') }),
    response: (p) => ({
      type: 'create', filePath: p('response.filePath'), content: p('response.content'),
      structuredPatch: [p('response.structuredPatch')], originalFile: p('response.originalFile'), userModified: false,
    }),
  },
  {
    tool: 'Bash',
    input: (p) => ({ command: `git commit -m ${p('command-arg')}`, description: p('input.description') }),
    response: (p) => ({ stdout: p('response.stdout'), stderr: p('response.stderr'), interrupted: false, isImage: false, noOutputExpected: false }),
  },
  {
    tool: 'Glob',
    input: (p) => ({ pattern: p('input.pattern'), path: `${REPO_ROOT}/src` }),
    response: (p) => ({ filenames: [p('response.filenames')], durationMs: 3, numFiles: 1, truncated: false }),
  },
  {
    tool: 'TodoWrite',
    input: (p) => ({
      todos: [
        { content: p('todo-content'), status: 'in_progress', activeForm: p('todo.activeForm') },
        { content: p('todo-content'), status: 'pending', activeForm: p('todo.activeForm') },
      ],
    }),
    response: (p) => ({ oldTodos: [{ content: p('response.oldTodos') }], newTodos: [{ content: p('response.newTodos') }] }),
  },
  {
    tool: 'Agent',
    input: (p) => ({ description: p('agent-description'), prompt: p('input.prompt'), subagent_type: 'general-purpose' }),
    response: (p) => ({
      isAsync: false, status: 'completed', agentId: p('response.agentId'), description: p('response.description'),
      resolvedModel: p('response.resolvedModel'), prompt: p('response.prompt'), outputFile: p('response.outputFile'),
    }),
  },
  {
    tool: 'mcp__synthetic__lookup',
    input: (p) => ({
      file_path: `${REPO_ROOT}/src/${p('mcp.file_path')}.ts`, path: `${REPO_ROOT}/${p('mcp.path')}`,
      notebook_path: `${REPO_ROOT}/${p('mcp.notebook_path')}.ipynb`, command: `git status ${p('mcp.command')}`,
      todos: [{ content: p('mcp.todos'), status: 'pending' }], description: p('mcp.description'),
      subagent_type: p('mcp.subagent_type'), query: p('mcp.query'),
    }),
    response: (p) => ({ content: [{ type: 'text', text: p('mcp.response') }] }),
  },
];

/**
 * One payload per hook event; PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest for
 * every tool case. Every forbidden field carries a planted value.
 */
export function syntheticPayloads(plant: Plant): SyntheticPayload[] {
  const out: SyntheticPayload[] = [];
  const add = (name: string, event: string, extra: Record<string, unknown>): void => {
    out.push({ name, payload: { ...common(plant, event), ...extra } });
  };

  add('SessionStart', 'SessionStart', { source: 'startup', model: plant('model') });
  add('SessionEnd', 'SessionEnd', { reason: 'prompt_input_exit' });
  add('UserPromptSubmit', 'UserPromptSubmit', { prompt: plant('prompt') });
  add('Stop', 'Stop', {
    last_assistant_message: plant('last_assistant_message'),
    background_tasks: [{ id: plant('bg.id'), type: 'agent', status: 'running', description: plant('bg.description'), agent_type: plant('bg.agent_type') }],
    session_crons: [plant('session_crons')],
    stop_hook_active: false,
  });
  add('SubagentStart', 'SubagentStart', { agent_id: AGENT_ID, agent_type: 'Explore' });
  add('SubagentStop', 'SubagentStop', {
    agent_id: AGENT_ID, agent_type: 'Explore',
    agent_transcript_path: `/tmp/synthetic/${plant('agent_transcript_path')}.jsonl`,
    last_assistant_message: plant('last_assistant_message'),
    background_tasks: [{ id: plant('bg.id'), type: 'agent', status: 'done', description: plant('bg.description'), agent_type: 'Plan' }],
    session_crons: [], stop_hook_active: false,
  });

  for (const c of TOOL_CASES) {
    const input = (): Record<string, unknown> => ({ ...c.input(plant), extra: plant('tool_input.extra') });
    const base = { tool_name: c.tool, tool_use_id: TOOL_USE_ID };
    add(`PreToolUse:${c.tool}`, 'PreToolUse', { ...base, tool_input: input() });
    add(`PostToolUse:${c.tool}`, 'PostToolUse', {
      ...base, tool_input: input(), tool_response: { ...c.response(plant), future: plant('tool_response.future') }, duration_ms: 42,
    });
    add(`PostToolUseFailure:${c.tool}`, 'PostToolUseFailure', {
      ...base, tool_input: input(), error: plant('error'), is_interrupt: false, duration_ms: 7,
    });
    add(`PermissionRequest:${c.tool}`, 'PermissionRequest', {
      tool_name: c.tool, tool_input: input(),
      permission_suggestions: [{ type: 'addRules', paths: [plant('permission_suggestions.path')], mode: plant('permission_suggestions.mode') }],
    });
  }
  // A tool call made inside a subagent.
  add('PreToolUse:Read@subagent', 'PreToolUse', {
    tool_name: 'Read', tool_use_id: TOOL_USE_ID, agent_id: AGENT_ID, agent_type: 'Explore',
    tool_input: { file_path: `${REPO_ROOT}/docs/guide.md`, extra: plant('tool_input.extra') },
  });
  return out;
}

/** A planter that records every planted value by label. */
export function recordingPlanter(prefix = 'PLANTED'): { plant: Plant; planted: Map<string, string[]> } {
  const planted = new Map<string, string[]>();
  let n = 0;
  const plant: Plant = (label) => {
    const value = `${prefix}${n++}x${label.replace(/[^A-Za-z0-9]/g, '')}`;
    const list = planted.get(label) ?? [];
    list.push(value);
    planted.set(label, list);
    return value;
  };
  return { plant, planted };
}
