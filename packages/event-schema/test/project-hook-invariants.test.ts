import { projectHookPayload, type DetailLevel, type HashFn, type ProjectionContext } from '../src/index.js';
import { syntheticPayloads, recordingPlanter, REPO_ROOT, SESSION_ID, TOOL_USE_ID } from './synthetic.js';

const hash: HashFn = (k, v) => `${k}:${v.length}`;
const LEVELS: readonly DetailLevel[] = ['metadata', 'detailed', 'sensitive-local'];
const ctx = (level: DetailLevel): ProjectionContext => ({ level, capturedAt: '2026-11-25T10:00:00.000Z', repoRoot: REPO_ROOT, hash });

/** mulberry32: tiny deterministic PRNG, so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Keys the mapping table reads, restated independently of the implementation.
 * Mutations never touch these; everything else must be invisible to the projection.
 */
const COMMON = ['session_id', 'hook_event_name', 'prompt_id'];
const TOOL_EVENT = [...COMMON, 'tool_name', 'tool_use_id', 'agent_id', 'agent_type', 'tool_input'];
const READ_TOP: Record<string, readonly string[]> = {
  SessionStart: [...COMMON, 'source'],
  SessionEnd: [...COMMON, 'reason'],
  UserPromptSubmit: [...COMMON, 'prompt'],
  PreToolUse: TOOL_EVENT,
  PostToolUse: [...TOOL_EVENT, 'duration_ms'],
  PostToolUseFailure: [...TOOL_EVENT, 'duration_ms', 'is_interrupt'],
  PermissionRequest: [...COMMON, 'tool_name'],
  SubagentStart: [...COMMON, 'agent_id', 'agent_type'],
  SubagentStop: [...COMMON, 'agent_id', 'agent_type'],
  Stop: COMMON,
};
/** tool_input keys read per tool (TOOL_FIELDS restated). Tools not listed: none. */
const READ_INPUT: Record<string, readonly string[]> = {
  Read: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'], Write: ['file_path'],
  NotebookEdit: ['notebook_path'], Glob: ['path'], Grep: ['path'], LS: ['path'], Bash: ['command'],
  TodoWrite: ['todos'], Task: ['subagent_type', 'description'], Agent: ['subagent_type', 'description'],
};

const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'prototype', 'hasOwnProperty', 'valueOf'];
const TEMPTING = ['file_path', 'path', 'notebook_path', 'command', 'todos', 'description', 'subagent_type', 'content', 'prompt'];

function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function randomValue(rnd: () => number, depth = 0): unknown {
  const k = Math.floor(rnd() * 9);
  switch (k) {
    case 0: return `MUT${Math.floor(rnd() * 1e9)}`;
    case 1: return Math.floor(rnd() * 1e6) - 5e5;
    case 2: return rnd() < 0.5;
    case 3: return null;
    case 4: return depth < 2 ? [randomValue(rnd, depth + 1), randomValue(rnd, depth + 1)] : 'MUTleaf';
    case 5: return depth < 2 ? { file_path: `${REPO_ROOT}/MUT.ts`, command: 'git push', nested: randomValue(rnd, depth + 1) } : 0;
    case 6: return `${REPO_ROOT}/src/MUT${Math.floor(rnd() * 1000)}.ts`;
    case 7: return 'git commit -m MUT';
    default: return { todos: [{ content: 'MUT', status: 'pending' }] };
  }
}

function randomKey(rnd: () => number, existing: readonly string[], forbidden: readonly string[]): string | undefined {
  const pool = [...existing.filter((k) => !forbidden.includes(k)), ...PROTO_KEYS, ...TEMPTING.filter((k) => !forbidden.includes(k)), `mut_${Math.floor(rnd() * 1e6)}`];
  const choice = pool[Math.floor(rnd() * pool.length)];
  return choice !== undefined && !forbidden.includes(choice) ? choice : undefined;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function mutate(payload: Record<string, unknown>, rnd: () => number): Record<string, unknown> {
  const p = clone(payload);
  const event = String(p.hook_event_name);
  const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  const topRead = READ_TOP[event] ?? [];
  const inputRead = event === 'PermissionRequest' ? [] : READ_INPUT[tool] ?? [];
  const steps = 1 + Math.floor(rnd() * 3);
  for (let s = 0; s < steps; s++) {
    const where = rnd();
    if (where < 0.4) {
      const key = randomKey(rnd, Object.keys(p), topRead);
      if (key !== undefined) setOwn(p, key, randomValue(rnd));
    } else if (where < 0.75) {
      if (typeof p.tool_input === 'object' && p.tool_input !== null && !Array.isArray(p.tool_input)) {
        const inp = p.tool_input as Record<string, unknown>;
        const key = randomKey(rnd, Object.keys(inp), inputRead);
        if (key !== undefined) setOwn(inp, key, randomValue(rnd));
      } else if (!topRead.includes('tool_input')) {
        setOwn(p, 'tool_input', randomValue(rnd));
      }
    } else {
      if (typeof p.tool_response !== 'object' || p.tool_response === null || Array.isArray(p.tool_response)) setOwn(p, 'tool_response', {});
      const resp = p.tool_response as Record<string, unknown>;
      const key = randomKey(rnd, Object.keys(resp), []);
      if (key !== undefined) setOwn(resp, key, randomValue(rnd));
    }
  }
  return p;
}

describe('layer 4: invariants', () => {
  const { plant } = recordingPlanter();
  const payloads = syntheticPayloads(plant);

  test('500 seeded mutations of unread keys leave every projection deep-equal', () => {
    const rnd = mulberry32(0x5eed2026);
    let compared = 0;
    for (let i = 0; i < 500; i++) {
      const base = payloads[Math.floor(rnd() * payloads.length)]!;
      const mutated = mutate(base.payload, rnd);
      for (const level of LEVELS) {
        const want = projectHookPayload(base.payload, ctx(level));
        const got = projectHookPayload(mutated, ctx(level));
        expect(got, `#${i} ${base.name} @${level}`).toEqual(want);
        expect(JSON.stringify(got)).not.toContain('MUT');
        compared++;
      }
    }
    expect(compared).toBe(1500);
  });

  test('unknown and MCP tools never yield detail, commandCategory, pathCategory or sensitive fields', () => {
    const input = {
      file_path: `${REPO_ROOT}/src/a.ts`, path: `${REPO_ROOT}/src`, notebook_path: `${REPO_ROOT}/n.ipynb`,
      command: 'git commit -m x', todos: [{ content: 'c', status: 'pending' }], description: 'd', subagent_type: 'Plan',
    };
    const rnd = mulberry32(7);
    for (const tool of ['mcp__synthetic__lookup', 'mcp__a__b', 'SomeFutureTool', 'bash', 'read', 'Read2']) {
      for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
        for (let i = 0; i < 5; i++) {
          const inp = mutate({ hook_event_name: ev, tool_input: clone(input) }, rnd).tool_input;
          const raw = { session_id: SESSION_ID, hook_event_name: ev, tool_name: tool, tool_use_id: TOOL_USE_ID, tool_input: inp, duration_ms: 1 };
          for (const level of LEVELS) {
            const r = projectHookPayload(raw, ctx(level));
            expect(r.ok).toBe(true);
            if (!r.ok) continue;
            expect(r).not.toHaveProperty('sensitive');
            for (const k of ['detail', 'commandCategory', 'pathCategory', 'agentType', 'subagentType']) expect(r.capture, `${tool} ${ev} ${level}`).not.toHaveProperty(k);
          }
        }
      }
    }
  });
});
