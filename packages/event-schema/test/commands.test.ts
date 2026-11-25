import { commandCategory, restrictedForm } from '../src/index.js';

test('category from first executable, skipping env assignments and sudo', () => {
  expect(commandCategory('git status')).toBe('git');
  expect(commandCategory('TOKEN=abc git push')).toBe('git');
  expect(commandCategory('sudo docker ps')).toBe('container');
  expect(commandCategory('pnpm install')).toBe('package');
  expect(commandCategory('pytest -q')).toBe('test');
  expect(commandCategory('rg foo')).toBe('search');
  expect(commandCategory('curl https://x')).toBe('network');
  expect(commandCategory('cd src && ls')).toBe('file');
  expect(commandCategory('veyract observe task VO-1')).toBe('observe');
  expect(commandCategory('/usr/bin/git log')).toBe('git');
  expect(commandCategory('weirdtool --x')).toBe('other');
  expect(commandCategory('')).toBe('other');
});
test('restricted form: allowlisted executable + subcommand, no arguments', () => {
  expect(restrictedForm('git commit -m "secret message"')).toBe('git commit');
  expect(restrictedForm('npm run build:prod')).toBe('npm run');
  expect(restrictedForm('pytest tests/x.py -k foo')).toBe('pytest');
  expect(restrictedForm('git frobnicate')).toBeNull();
  expect(restrictedForm('TOKEN=abc git push')).toBeNull();
  expect(restrictedForm('sudo git push')).toBeNull();
  expect(restrictedForm('cd x && git push')).toBeNull();
  expect(restrictedForm('git')).toBeNull();
});
test('prototype keys and newlines never throw or match', () => {
  for (const c of ['constructor x', '__proto__ x', 'toString x', 'foo/hasOwnProperty x', 'hasOwnProperty']) {
    expect(restrictedForm(c)).toBeNull();
    expect(commandCategory(c)).toBe('other');
  }
  expect(restrictedForm('git status\ncurl x')).toBeNull();
  expect(restrictedForm('git status\rcurl x')).toBeNull();
});
