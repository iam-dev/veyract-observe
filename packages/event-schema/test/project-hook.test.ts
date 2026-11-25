import {
  projectHookPayload, relativePath, restrictedForm, BUILTIN_TOOLS, KNOWN_AGENT_TYPES,
  type DetailLevel, type HashFn, type ProjectionContext,
} from '../src/index.js';
import {
  syntheticPayloads, recordingPlanter, REPO_ROOT, SESSION_ID, PROMPT_ID, AGENT_ID, TOOL_USE_ID,
} from './synthetic.js';

const hash: HashFn = (k, v) => `${k}:${v.length}`;
const CAPTURED_AT = '2026-11-25T10:00:00.000Z';
const LEVELS: readonly DetailLevel[] = ['metadata', 'detailed', 'sensitive-local'];
const ctx = (level: DetailLevel): ProjectionContext => ({ level, capturedAt: CAPTURED_AT, repoRoot: REPO_ROOT, hash });

function okResult(raw: unknown, level: DetailLevel) {
  const r = projectHookPayload(raw, ctx(level));
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
}

/** Every [path, string] leaf in a value. */
function stringLeaves(v: unknown, path: string[] = []): Array<[string[], string]> {
  if (typeof v === 'string') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => stringLeaves(x, [...path, String(i)]));
  if (typeof v === 'object' && v !== null) return Object.entries(v).flatMap(([k, x]) => stringLeaves(x, [...path, k]));
  return [];
}

// ---------------------------------------------------------------------------------------------
// Layer 1: forbidden-content planting
// ---------------------------------------------------------------------------------------------
describe('layer 1: forbidden-content planting', () => {
  const { plant, planted } = recordingPlanter();
  const payloads = syntheticPayloads(plant);

  test('covers every supported hook event and the required tools', () => {
    const events = new Set(payloads.map((p) => p.payload.hook_event_name));
    expect([...events].sort()).toEqual([
      'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart',
      'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit',
    ]);
    for (const t of ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'TodoWrite', 'Agent', 'mcp__synthetic__lookup']) {
      expect(payloads.some((p) => p.name === `PostToolUse:${t}`)).toBe(true);
      expect(payloads.some((p) => p.name === `PreToolUse:${t}`)).toBe(true);
    }
    for (const label of [
      'prompt', 'command-arg', 'input.content', 'input.old_string', 'input.new_string', 'response.originalFile',
      'response.stdout', 'error', 'last_assistant_message', 'permission_suggestions.path', 'transcript_path',
      'cwd', 'bg.description', 'todo-content', 'agent-description', 'future_field', 'tool_input.extra',
      'tool_response.future', 'agent_transcript_path', 'mcp.file_path', 'mcp.command',
    ]) expect(planted.has(label), label).toBe(true);
  });

  for (const level of ['metadata', 'detailed'] as const) {
    test(`no planted value survives at ${level}`, () => {
      for (const { name, payload } of payloads) {
        const json = JSON.stringify(okResult(payload, level));
        expect(json.includes('PLANTED'), `${name}: ${json}`).toBe(false);
      }
    });
  }

  test('at sensitive-local only command, todo subjects and subagent descriptions survive, only under sensitive', () => {
    const allowed = new Set([...planted.get('command-arg')!, ...planted.get('todo-content')!, ...planted.get('agent-description')!]);
    let seen = 0;
    for (const { name, payload } of payloads) {
      const r = okResult(payload, 'sensitive-local');
      expect(JSON.stringify(r.capture).includes('PLANTED'), name).toBe(false);
      for (const [, s] of stringLeaves(r.sensitive)) {
        for (const m of s.match(/PLANTED\d+x[A-Za-z0-9]+/g) ?? []) {
          expect(allowed.has(m), `${name}: ${m}`).toBe(true);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Layer 2: residual-field accounting
// ---------------------------------------------------------------------------------------------
describe('layer 2: residual-field accounting', () => {
  const NAME = 'PLANTEDNAME';
  const base = { session_id: SESSION_ID, tool_use_id: TOOL_USE_ID };
  const fileEvents = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].flatMap((ev) =>
    (['Read', 'Edit', 'Write'] as const).map((tool) => ({
      ...base, hook_event_name: ev, tool_name: tool, duration_ms: 1,
      tool_input: { file_path: `${REPO_ROOT}/src/${NAME}.ts` },
    })),
  );

  test('a planted file name appears at detailed only at capture.detail.path', () => {
    for (const p of fileEvents) {
      const r = okResult(p, 'detailed');
      const hits = stringLeaves(r).filter(([, s]) => s.includes(NAME));
      expect(hits.map(([path]) => path.join('.'))).toEqual(['capture.detail.path']);
      expect(r.capture.detail?.path).toBe(`src/${NAME}.ts`);
    }
  });

  test('a planted file name appears nowhere at metadata', () => {
    for (const p of fileEvents) expect(JSON.stringify(okResult(p, 'metadata'))).not.toContain(NAME);
  });

  const TOOL = 'PLANTEDTOOLNAME';
  const MCP = 'mcp__PLANTEDSERVER__fetch';
  const AGENT = 'PLANTEDAGENTTYPE';
  const nameCases = [
    { ...base, hook_event_name: 'PreToolUse', tool_name: TOOL, tool_input: {} },
    { ...base, hook_event_name: 'PostToolUse', tool_name: MCP, tool_input: {}, duration_ms: 1 },
    { ...base, hook_event_name: 'PermissionRequest', tool_name: TOOL, tool_input: {} },
    { ...base, hook_event_name: 'SubagentStart', agent_id: AGENT_ID, agent_type: AGENT },
    { ...base, hook_event_name: 'SubagentStop', agent_id: AGENT_ID, agent_type: AGENT },
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: AGENT_ID, agent_type: AGENT, tool_input: {} },
    { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: AGENT } },
  ];

  test('unknown tool names and custom agent types appear at metadata only as pseudonyms', () => {
    for (const p of nameCases) {
      const r = okResult(p, 'metadata');
      expect(JSON.stringify(r)).not.toContain('PLANTED');
      const { tool, agentType, subagentType } = r.capture;
      if (p.tool_name === TOOL) expect(tool).toEqual({ name: 'other', pseudonym: `tool:${TOOL.length}` });
      if (p.tool_name === MCP) expect(tool).toEqual({ name: 'mcp', pseudonym: `tool:${MCP.length}` });
      if (p.hook_event_name.startsWith('Subagent') || p.agent_type === AGENT) {
        expect(agentType).toEqual({ name: 'other', pseudonym: `agent-type:${AGENT.length}` });
      }
      if (p.tool_name === 'Agent') {
        expect(agentType).toBeUndefined();
        expect(subagentType).toEqual({ name: 'other', pseudonym: `agent-type:${AGENT.length}` });
      }
    }
  });

  test('at detailed the validated original name is kept without pseudonym', () => {
    expect(okResult(nameCases[0], 'detailed').capture.tool).toEqual({ name: TOOL });
    expect(okResult(nameCases[3], 'detailed').capture.agentType).toEqual({ name: AGENT });
    expect(okResult(nameCases[6], 'detailed').capture.subagentType).toEqual({ name: AGENT });
  });
});

// ---------------------------------------------------------------------------------------------
// Layer 3: output schema check
// ---------------------------------------------------------------------------------------------
const PSEUDONYM = /^(tool|agent-type):\d+$/;
const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v);

function namedRule(known: ReadonlySet<string>, kind: 'tool' | 'agent-type') {
  return (v: unknown, level: DetailLevel): string | null => {
    if (typeof v !== 'object' || v === null) return 'not an object';
    const keys = Object.keys(v);
    const { name, pseudonym } = v as { name?: unknown; pseudonym?: unknown };
    if (typeof name !== 'string') return 'name not a string';
    if (keys.some((k) => k !== 'name' && k !== 'pseudonym')) return `extra key in ${keys.join(',')}`;
    if (known.has(name)) return pseudonym === undefined ? null : 'pseudonym on a known name';
    if (level === 'metadata') {
      if (!(name === 'other' || (kind === 'tool' && name === 'mcp'))) return `unknown name at metadata: ${name}`;
      return typeof pseudonym === 'string' && PSEUDONYM.test(pseudonym) && pseudonym.startsWith(`${kind}:`) ? null : 'bad pseudonym';
    }
    return NAME_PATTERN.test(name) && pseudonym === undefined ? null : 'bad validated name';
  };
}

type Rule = (v: unknown, level: DetailLevel) => string | null;
const bool = (v: unknown) => (typeof v === 'boolean' ? null : 'not boolean');
const nonNegInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? null : 'not a non-negative integer');
const re = (r: RegExp): Rule => (v) => (typeof v === 'string' && r.test(v) ? null : 'pattern mismatch');
const enumRule = (...xs: string[]): Rule => (v) => (oneOf(...xs)(v) ? null : `not in enum: ${String(v)}`);

const CAPTURE_RULES: Record<string, Rule> = {
  schemaVersion: (v) => (v === 1 ? null : 'schemaVersion'),
  eventType: enumRule('session.started', 'session.ended', 'prompt.submitted', 'tool.requested', 'tool.completed',
    'tool.failed', 'permission.requested', 'subagent.started', 'subagent.stopped', 'agent.stopped'),
  hookEvent: enumRule('SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop'),
  sessionId: re(UUID),
  capturedAt: (v) => (v === CAPTURED_AT ? null : 'capturedAt not from context'),
  detailLevel: (v, level) => (v === level ? null : 'detailLevel'),
  promptId: re(UUID),
  tool: namedRule(BUILTIN_TOOLS, 'tool'),
  toolUseId: re(/^[A-Za-z0-9_-]{1,64}$/),
  durationMs: nonNegInt,
  success: bool,
  isInterrupt: bool,
  source: enumRule('startup', 'resume', 'clear', 'compact', 'other'),
  reason: enumRule('clear', 'logout', 'prompt_input_exit', 'other'),
  agentId: re(/^[A-Za-z0-9]{1,64}$/),
  agentType: namedRule(KNOWN_AGENT_TYPES, 'agent-type'),
  subagentType: namedRule(KNOWN_AGENT_TYPES, 'agent-type'),
  promptLength: nonNegInt,
  pathCategory: enumRule('source', 'test', 'config', 'docs', 'outside', 'none'),
  commandCategory: enumRule('git', 'test', 'package', 'build', 'file', 'search', 'network', 'container', 'observe', 'other'),
  detail: (v, level) => {
    if (level === 'metadata') return 'detail at metadata';
    if (typeof v !== 'object' || v === null) return 'detail not an object';
    const d = v as Record<string, unknown>;
    if (Object.keys(d).length === 0) return 'empty detail';
    for (const [k, x] of Object.entries(d)) {
      if (k === 'path') {
        if (typeof x !== 'string' || relativePath(`${REPO_ROOT}/${x}`, REPO_ROOT) !== x) return 'path not a relativePath result';
      } else if (k === 'command') {
        if (typeof x !== 'string' || restrictedForm(x) !== x) return 'command not a restricted form';
      } else return `unknown detail key ${k}`;
    }
    return null;
  },
};

export function schemaViolations(capture: unknown, level: DetailLevel): string[] {
  if (typeof capture !== 'object' || capture === null) return ['capture not an object'];
  const out: string[] = [];
  for (const [k, v] of Object.entries(capture)) {
    const rule = Object.hasOwn(CAPTURE_RULES, k) ? CAPTURE_RULES[k] : undefined;
    if (rule === undefined) { out.push(`unknown key ${k}`); continue; }
    const err = rule(v, level);
    if (err !== null) out.push(`${k}: ${err}`);
  }
  return out;
}

describe('layer 3: output schema check', () => {
  const { plant } = recordingPlanter();
  const payloads = syntheticPayloads(plant);

  test('the checker rejects bad shapes', () => {
    expect(schemaViolations({ schemaVersion: 1, prompt: 'x' }, 'metadata')).toContain('unknown key prompt');
    expect(schemaViolations({ tool: { name: 'mcp__x' } }, 'metadata')).toHaveLength(1);
    expect(schemaViolations({ detail: { path: 'a/../b' } }, 'detailed')).toHaveLength(1);
    expect(schemaViolations({ detail: { command: 'git commit -m x' } }, 'detailed')).toHaveLength(1);
    expect(schemaViolations({ detail: { path: 'src/a.ts' } }, 'metadata')).toHaveLength(1);
  });

  for (const level of LEVELS) {
    test(`every capture string matches its rule at ${level}`, () => {
      for (const { name, payload } of payloads) {
        expect(schemaViolations(okResult(payload, level).capture, level), name).toEqual([]);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------------------------
describe('behaviour', () => {
  const base = { session_id: SESSION_ID, prompt_id: PROMPT_ID, tool_use_id: TOOL_USE_ID };
  const bash = (command: unknown, ev = 'PreToolUse') => ({ ...base, hook_event_name: ev, tool_name: 'Bash', tool_input: { command } });

  test('full PostToolUse projection at metadata', () => {
    const r = okResult({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', duration_ms: 12,
      tool_input: { file_path: `${REPO_ROOT}/src/a.ts` }, tool_response: {} }, 'metadata');
    expect(r).toEqual({
      ok: true,
      capture: {
        schemaVersion: 1, eventType: 'tool.completed', hookEvent: 'PostToolUse', sessionId: SESSION_ID,
        capturedAt: CAPTURED_AT, detailLevel: 'metadata', promptId: PROMPT_ID, tool: { name: 'Edit' },
        toolUseId: TOOL_USE_ID, durationMs: 12, success: true, pathCategory: 'source',
      },
    });
  });

  test('PostToolUseFailure carries success false and isInterrupt', () => {
    const r = okResult({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', duration_ms: 3,
      is_interrupt: true, error: 'boom', tool_input: { command: 'npm test' } }, 'metadata');
    expect(r.capture).toMatchObject({ eventType: 'tool.failed', success: false, isInterrupt: true, durationMs: 3, commandCategory: 'package' });
    expect(r.capture).not.toHaveProperty('detail');
  });

  test('metadata has no detail; detailed has path and restricted form', () => {
    expect(okResult(bash('git commit -m wip'), 'metadata').capture).not.toHaveProperty('detail');
    expect(okResult(bash('git commit -m wip'), 'detailed').capture.detail).toEqual({ command: 'git commit' });
    expect(okResult(bash('curl https://example.com/x'), 'detailed').capture).not.toHaveProperty('detail');
    expect(okResult(bash('curl https://example.com/x'), 'detailed').capture.commandCategory).toBe('network');
    const read = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${REPO_ROOT}/tests/a.test.ts` } };
    expect(okResult(read, 'detailed').capture).toMatchObject({ pathCategory: 'test', detail: { path: 'tests/a.test.ts' } });
    expect(okResult(read, 'metadata').capture).not.toHaveProperty('detail');
  });

  test('paths outside the repo keep only their category', () => {
    const p = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/synthetic/x.ts' } };
    const r = okResult(p, 'detailed');
    expect(r.capture.pathCategory).toBe('outside');
    expect(r.capture).not.toHaveProperty('detail');
    const noRoot = projectHookPayload(p, { ...ctx('detailed'), repoRoot: null });
    expect(noRoot.ok && noRoot.capture.pathCategory).toBe('outside');
  });

  test('path fields per tool: notebook_path, optional Glob path', () => {
    const nb = { ...base, hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: `${REPO_ROOT}/docs/n.ipynb`, file_path: `${REPO_ROOT}/src/x.ts` } };
    expect(okResult(nb, 'detailed').capture).toMatchObject({ pathCategory: 'docs', detail: { path: 'docs/n.ipynb' } });
    const glob = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } };
    expect(okResult(glob, 'detailed').capture.pathCategory).toBe('none');
    expect(okResult(glob, 'detailed').capture).not.toHaveProperty('detail');
  });

  test('a path with control characters is not kept as detail.path', () => {
    const p = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${REPO_ROOT}/src/a\nb.ts` } };
    expect(okResult(p, 'detailed').capture).not.toHaveProperty('detail');
  });

  const CUT = '…[truncated]';
  test('sensitive-local free text is only under sensitive, redacted and truncated', () => {
    const secret = ['gh', 'p_', 'A'.repeat(36)].join('');
    const r = okResult(bash(`git push https://example.com ${secret} ${'x'.repeat(1000)}`), 'sensitive-local');
    expect(r.capture.detail).toEqual({ command: 'git push' });
    expect(r.sensitive?.command).toContain('[REDACTED:github-token]');
    expect(r.sensitive?.command).not.toContain(secret);
    expect(r.sensitive!.command!.length).toBeLessThanOrEqual(500 + CUT.length);
    expect(r.sensitive!.command!.endsWith(CUT)).toBe(true);
    expect(JSON.stringify(r.capture)).not.toContain('xxxx');

    const todos = Array.from({ length: 60 }, (_, i) => ({ content: `step ${i} ${'y'.repeat(300)}`, status: i === 0 ? 'weird' : 'completed', activeForm: 'z' }));
    const t = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos } }, 'sensitive-local');
    expect(t.sensitive?.todoSubjects).toHaveLength(50);
    expect(t.sensitive?.todoSubjects?.[0]).toEqual({ subject: `step 0 ${'y'.repeat(193)}${CUT}`, status: 'other' });
    expect(t.sensitive?.todoSubjects?.[1]?.status).toBe('completed');
    expect(t.sensitive?.todoSubjects?.every((s) => s.subject.length <= 200 + CUT.length)).toBe(true);

    const a = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Task',
      tool_input: { description: 'd'.repeat(300), prompt: 'never', subagent_type: 'Plan' } }, 'sensitive-local');
    expect(a.sensitive).toEqual({ subagentDescription: 'd'.repeat(200) + CUT });
    expect(a.capture.subagentType).toEqual({ name: 'Plan' });
    expect(a.capture).not.toHaveProperty('agentType');
    expect(JSON.stringify(a)).not.toContain('never');
  });

  test('sensitive is absent at lower levels and when empty', () => {
    expect(okResult(bash('ls'), 'detailed')).not.toHaveProperty('sensitive');
    expect(okResult(bash('ls'), 'metadata')).not.toHaveProperty('sensitive');
    const read = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${REPO_ROOT}/a.ts` } };
    expect(okResult(read, 'sensitive-local')).not.toHaveProperty('sensitive');
    const badTodos = { ...base, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [null, 3, { status: 'pending' }] } };
    expect(okResult(badTodos, 'sensitive-local')).not.toHaveProperty('sensitive');
  });

  test('agentId / agentType describe the caller; Task / Agent add subagentType', () => {
    const fromExplore = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', agent_id: AGENT_ID,
      agent_type: 'Explore', tool_input: { subagent_type: 'Plan', description: 'd' } }, 'metadata');
    expect(fromExplore.capture).toMatchObject({ agentId: AGENT_ID, agentType: { name: 'Explore' }, subagentType: { name: 'Plan' } });
    const custom = okResult({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Task', agent_id: AGENT_ID,
      agent_type: 'Explore', tool_input: { subagent_type: 'my-reviewer' } }, 'metadata');
    expect(custom.capture.subagentType).toEqual({ name: 'other', pseudonym: 'agent-type:11' });
    const missing = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', agent_id: AGENT_ID,
      agent_type: 'Explore', tool_input: { description: 'd' } }, 'detailed');
    expect(missing.capture.agentType).toEqual({ name: 'Explore' });
    expect(missing.capture).not.toHaveProperty('subagentType');
    const notAgentTool = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read',
      tool_input: { file_path: `${REPO_ROOT}/a.ts`, subagent_type: 'Plan' } }, 'detailed');
    expect(notAgentTool.capture).not.toHaveProperty('subagentType');
  });

  test("repoRoot '/' (or another root without a segment) never yields detail.path", () => {
    for (const repoRoot of ['/', '//', '/./']) {
      for (const level of ['detailed', 'sensitive-local'] as const) {
        const r = projectHookPayload({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read',
          tool_input: { file_path: '/srv/data/secret.txt' } }, { ...ctx(level), repoRoot });
        expect(r.ok && r.capture.pathCategory).toBe('outside');
        expect(r.ok && r.capture).not.toHaveProperty('detail');
        expect(JSON.stringify(r)).not.toContain('secret');
      }
    }
  });

  test('paths with C1, separator or bidi control characters are not kept as detail.path', () => {
    for (const ch of ['\u202e', '\u0085', '\u009b', '\u2028', '\u2029', '\u200e', '\u200f', '\u202a', '\u2066', '\u2069']) {
      const p = { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${REPO_ROOT}/src/a${ch}st.ts` } };
      const r = okResult(p, 'detailed');
      expect(r.capture, JSON.stringify(ch)).not.toHaveProperty('detail');
      expect(r.capture.pathCategory).toBe('source');
    }
  });

  test('the TodoWrite scan stops after 1,000 items', () => {
    const todos = Array.from({ length: 100_000 }, (_, i) => (i < 1_000 ? null : { content: 'late', status: 'pending' }));
    const t0 = performance.now();
    const r = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos } }, 'sensitive-local');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(r).not.toHaveProperty('sensitive');
    const full = Array.from({ length: 100_000 }, () => ({ content: 's', status: 'pending' }));
    const t1 = performance.now();
    const f = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: full } }, 'sensitive-local');
    expect(performance.now() - t1).toBeLessThan(200);
    expect(f.sensitive?.todoSubjects?.length).toBeLessThanOrEqual(50);
  });

  test('no content digest: the hash only ever sees tool names and agent types from the payload', () => {
    const { plant } = recordingPlanter();
    const extra = [
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'NotARealTool', agent_id: AGENT_ID, agent_type: 'custom-caller',
        tool_input: { command: 'cmd', file_path: `${REPO_ROOT}/x.ts` } },
      { ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'custom-sub', description: 'd', prompt: 'p' } },
      { ...base, hook_event_name: 'SubagentStart', agent_id: AGENT_ID, agent_type: 'custom-start' },
    ];
    const all = [...syntheticPayloads(plant).map((p) => p.payload), ...extra] as Array<Record<string, unknown>>;
    let calls = 0;
    for (const payload of all) {
      const input = payload.tool_input as Record<string, unknown> | undefined;
      const allowed = new Set([payload.tool_name, payload.agent_type, input?.subagent_type].filter((v) => typeof v === 'string'));
      const seen: string[] = [];
      const spy: HashFn = (k, v) => { seen.push(v); calls++; return hash(k, v); };
      for (const level of LEVELS) projectHookPayload(payload, { ...ctx(level), hash: spy });
      for (const v of seen) expect(allowed.has(v), `${String(payload.hook_event_name)}: ${v}`).toBe(true);
    }
    expect(calls).toBeGreaterThan(0);
  });

  test('UserPromptSubmit keeps only the prompt length', () => {
    const r = okResult({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hello there' }, 'sensitive-local');
    expect(r.capture.promptLength).toBe(11);
    expect(JSON.stringify(r)).not.toContain('hello');
    expect(okResult({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 5 }, 'metadata').capture).not.toHaveProperty('promptLength');
  });

  test('session lifecycle reasons; odd source → other', () => {
    expect(okResult({ ...base, hook_event_name: 'SessionStart', source: 'resume' }, 'metadata').capture.source).toBe('resume');
    expect(okResult({ ...base, hook_event_name: 'SessionStart', source: 'PLANTEDodd' }, 'metadata').capture.source).toBe('other');
    expect(okResult({ ...base, hook_event_name: 'SessionEnd', reason: 'logout' }, 'metadata').capture).toMatchObject({ eventType: 'session.ended', reason: 'logout' });
    expect(okResult({ ...base, hook_event_name: 'SessionEnd' }, 'metadata').capture).not.toHaveProperty('reason');
  });

  test('Stop, PermissionRequest and Subagent events keep only their listed fields', () => {
    expect(okResult({ ...base, hook_event_name: 'Stop', last_assistant_message: 'm' }, 'detailed').capture).toEqual({
      schemaVersion: 1, eventType: 'agent.stopped', hookEvent: 'Stop', sessionId: SESSION_ID, capturedAt: CAPTURED_AT,
      detailLevel: 'detailed', promptId: PROMPT_ID,
    });
    const perm = okResult({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push' } }, 'sensitive-local');
    expect(perm).toEqual({ ok: true, capture: {
      schemaVersion: 1, eventType: 'permission.requested', hookEvent: 'PermissionRequest', sessionId: SESSION_ID,
      capturedAt: CAPTURED_AT, detailLevel: 'sensitive-local', promptId: PROMPT_ID, tool: { name: 'Bash' },
    } });
    expect(okResult({ ...base, hook_event_name: 'SubagentStop', agent_id: AGENT_ID, agent_type: 'Explore' }, 'metadata').capture)
      .toMatchObject({ eventType: 'subagent.stopped', agentId: AGENT_ID, agentType: { name: 'Explore' } });
  });

  test('invalid optional fields are omitted', () => {
    const r = okResult({ session_id: SESSION_ID, hook_event_name: 'PostToolUse', tool_name: 'Read', prompt_id: 'x',
      tool_use_id: 'bad id!', duration_ms: -1, agent_id: 'no-dashes', agent_type: 'bad type!', tool_input: 'str' }, 'detailed');
    expect(r.capture).toEqual({
      schemaVersion: 1, eventType: 'tool.completed', hookEvent: 'PostToolUse', sessionId: SESSION_ID, capturedAt: CAPTURED_AT,
      detailLevel: 'detailed', tool: { name: 'Read' }, success: true, pathCategory: 'none',
    });
  });

  test('rejections', () => {
    const rej = (raw: unknown) => {
      const r = projectHookPayload(raw, ctx('metadata'));
      return r.ok ? 'ok' : r.reason;
    };
    for (const m of ['nope', null, undefined, 42, [], [{ hook_event_name: 'Stop' }], {}, { hook_event_name: 7 }]) expect(rej(m)).toBe('malformed');
    expect(rej({ session_id: SESSION_ID, hook_event_name: 'Notification' })).toBe('unsupported-event');
    for (const ev of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(rej({ session_id: SESSION_ID, hook_event_name: ev })).toBe('unsupported-event');
    expect(rej({ session_id: 'not-a-uuid', hook_event_name: 'Stop' })).toBe('invalid-field');
    expect(rej({ hook_event_name: 'Stop' })).toBe('invalid-field');
    expect(rej({ session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'bad tool!' })).toBe('invalid-field');
    expect(rej({ session_id: SESSION_ID, hook_event_name: 'PostToolUse' })).toBe('invalid-field');
    expect(rej({ session_id: SESSION_ID, hook_event_name: 'PermissionRequest', tool_name: 3 })).toBe('invalid-field');
  });

  test('reads own data properties only: inherited fields and getters are ignored', () => {
    const proto = { session_id: SESSION_ID, hook_event_name: 'Stop' };
    expect(projectHookPayload(Object.create(proto), ctx('metadata'))).toEqual({ ok: false, reason: 'malformed' });
    const withGetter = { hook_event_name: 'Stop' } as Record<string, unknown>;
    Object.defineProperty(withGetter, 'session_id', { enumerable: true, get() { throw new Error('getter invoked'); } });
    expect(projectHookPayload(withGetter, ctx('metadata'))).toEqual({ ok: false, reason: 'invalid-field' });
    const input = Object.create({ command: 'git push' }) as Record<string, unknown>;
    const r = okResult({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input }, 'sensitive-local');
    expect(r.capture).not.toHaveProperty('commandCategory');
    expect(r).not.toHaveProperty('sensitive');
  });

  test('never throws on hostile shapes', () => {
    const odd: unknown[] = [
      { session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: null },
      { session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: [1, 2] },
      { session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: { x: 1 } } },
      { session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: 'x' } },
      { session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: new Array(5) } },
      { session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x'.repeat(200_000) } },
      { session_id: SESSION_ID, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x'.repeat(200_000) } },
      JSON.parse('{"session_id":"' + SESSION_ID + '","hook_event_name":"PreToolUse","tool_name":"Bash","__proto__":{"x":1},"tool_input":{"__proto__":{"command":"git push"},"constructor":1}}'),
    ];
    for (const level of LEVELS) for (const o of odd) expect(() => projectHookPayload(o, ctx(level))).not.toThrow();
    const big = okResult(odd[6], 'sensitive-local');
    expect(big.sensitive?.command).toBe('[OMITTED:oversized]');
  });
});
