import { classifyTool, classifyAgentType, sessionSource, sessionEndReason, type HashFn } from '../src/index.js';

const H: HashFn = (k, v) => `${k}:${v.length}`;
test('sources and reasons: known kept, unknown → other', () => {
  expect(sessionSource('resume')).toBe('resume'); expect(sessionSource('customer_acme')).toBe('other'); expect(sessionSource(3)).toBeUndefined();
  expect(sessionEndReason('logout')).toBe('logout'); expect(sessionEndReason('../../etc')).toBe('other');
});
test('tools: built-in readable, MCP and unknown pseudonymised at metadata', () => {
  expect(classifyTool('Bash', 'metadata', H)).toEqual({ name: 'Bash' });
  expect(classifyTool('mcp__synthetic__fetch', 'metadata', H)).toEqual({ name: 'mcp', pseudonym: 'tool:21' });
  expect(classifyTool('mcp__synthetic__fetch', 'detailed', H)).toEqual({ name: 'mcp__synthetic__fetch' });
  expect(classifyTool('deploy_prod_db', 'metadata', H)).toEqual({ name: 'other', pseudonym: 'tool:14' });
  expect(classifyTool('deploy_prod_db', 'detailed', H)).toEqual({ name: 'deploy_prod_db' });
  expect(classifyTool('bad name', 'detailed', H)).toBeUndefined();
});
test('agent types', () => {
  expect(classifyAgentType('Explore', 'metadata', H)).toEqual({ name: 'Explore' });
  expect(classifyAgentType('acme-reviewer', 'metadata', H)).toEqual({ name: 'other', pseudonym: 'agent-type:13' });
  expect(classifyAgentType('acme reviewer', 'metadata', H)).toBeUndefined();
});
