import { recognizeTaskTag, TASK_TAG_CONFIRM } from '../src/index.js';

const SID = '3f2a0c1e-1111-4222-8333-444455556666';
const ok = (cmd: string, stdout: string, ev = 'PostToolUse') => ({ hook_event_name: ev, session_id: SID, tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout, stderr: '' } });

test('standalone command with matching confirmation tags', () => {
  expect(recognizeTaskTag(ok('veyract observe task VO-12', 'veyract-observe: tagged VO-12 #a1b2c3d4'))).toEqual({ sessionId: SID, taskId: 'VO-12' });
  expect(recognizeTaskTag(ok('veyract observe task --none', 'veyract-observe: untagged #a1b2c3d4'))).toEqual({ sessionId: SID, taskId: null });
});
test.each([
  ['echo "veyract observe task VO-12"', 'veyract observe task VO-12'],
  ['false && veyract observe task VO-12 || true', ''],
  ['cd x && veyract observe task VO-12', 'veyract-observe: tagged VO-12 #a1b2c3d4'],
  ['veyract observe task VO-12', ''],
  ['veyract observe task VO-12', 'veyract-observe: tagged VO-13 #a1b2c3d4'],
  ['veyract observe task vo-12', 'veyract-observe: tagged VO-12 #a1b2c3d4'],
  ['veyract observe task --none', 'veyract-observe: tagged VO-12 #a1b2c3d4'],
  ['veyract observe task VO-12', 'veyract-observe: untagged #a1b2c3d4'],
])('does not tag: %s', (cmd, stdout) => { expect(recognizeTaskTag(ok(cmd, stdout))).toBeNull(); });
test('PreToolUse and failures never tag', () => {
  expect(recognizeTaskTag(ok('veyract observe task VO-12', 'veyract-observe: tagged VO-12 #a1b2c3d4', 'PreToolUse'))).toBeNull();
  expect(recognizeTaskTag(ok('veyract observe task VO-12', 'veyract-observe: tagged VO-12 #a1b2c3d4', 'PostToolUseFailure'))).toBeNull();
});
test('confirmation line may follow other output lines', () => {
  expect(recognizeTaskTag(ok('veyract observe task VO-12', 'note\nveyract-observe: tagged VO-12 #a1b2c3d4\n'))).toEqual({ sessionId: SID, taskId: 'VO-12' });
});
test('extra whitespace around the standalone command is accepted', () => {
  expect(recognizeTaskTag(ok('  veyract observe task VO-12  \n', 'veyract-observe: tagged VO-12 #a1b2c3d4'))).toEqual({ sessionId: SID, taskId: 'VO-12' });
});
test.each([null, undefined, 'str', 7, [], [ok('veyract observe task VO-12', 'veyract-observe: tagged VO-12 #a1b2c3d4')], {}])('odd input returns null: %j', (v) => {
  expect(recognizeTaskTag(v)).toBeNull();
});
test('tool_input as string, non-string fields and inherited keys return null', () => {
  const base = ok('veyract observe task VO-12', 'veyract-observe: tagged VO-12 #a1b2c3d4');
  expect(recognizeTaskTag({ ...base, tool_input: 'veyract observe task VO-12' })).toBeNull();
  expect(recognizeTaskTag({ ...base, tool_input: { command: 5 } })).toBeNull();
  expect(recognizeTaskTag({ ...base, tool_response: { stdout: 5 } })).toBeNull();
  expect(recognizeTaskTag({ ...base, tool_response: 'x' })).toBeNull();
  expect(recognizeTaskTag({ ...base, session_id: 'not-a-uuid' })).toBeNull();
  expect(recognizeTaskTag({ ...base, tool_name: 'Edit' })).toBeNull();
  const inherited = Object.create(base);
  expect(recognizeTaskTag(inherited)).toBeNull();
});
test('TASK_TAG_CONFIRM is exported', () => {
  expect(TASK_TAG_CONFIRM.test('veyract-observe: untagged #a1b2c3d4')).toBe(true);
});
