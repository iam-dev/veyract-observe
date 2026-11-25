import * as v from '../src/validate.js';

test('validators', () => {
  expect(v.sessionId('3f2a0c1e-1111-4222-8333-444455556666')).toBeDefined(); expect(v.sessionId('../etc')).toBeUndefined();
  expect(v.durationMs(12)).toBe(12); expect(v.durationMs(-1)).toBeUndefined(); expect(v.durationMs(1.5)).toBeUndefined();
  expect(v.taskId('VO-12')).toBe('VO-12'); expect(v.taskId('vo-12')).toBeUndefined();
});
test('other identifiers and non-strings', () => {
  expect(v.promptId('3f2a0c1e-1111-4222-8333-444455556666')).toBeDefined(); expect(v.promptId(5)).toBeUndefined();
  expect(v.toolUseId('abc_DEF-1')).toBe('abc_DEF-1'); expect(v.toolUseId('a b')).toBeUndefined(); expect(v.toolUseId('a'.repeat(65))).toBeUndefined();
  expect(v.agentId('abc123')).toBe('abc123'); expect(v.agentId('a-b')).toBeUndefined();
  expect(v.durationMs(86_400_000)).toBe(86_400_000); expect(v.durationMs(86_400_001)).toBeUndefined(); expect(v.durationMs('3')).toBeUndefined();
  expect(v.taskId(undefined)).toBeUndefined();
});
