import { relativePath, pathCategory } from '../src/index.js';

test('relativePath', () => {
  expect(relativePath('/r/src/a.ts', '/r')).toBe('src/a.ts');
  expect(relativePath('/r/../etc/passwd', '/r')).toBeNull();
  expect(relativePath('/other/a.ts', '/r')).toBeNull();
  expect(relativePath('src/a.ts', '/r')).toBeNull();
  expect(relativePath('/r/' + 'a/'.repeat(300) + 'x', '/r')).toBeNull();
  expect(relativePath('C:\\r\\a.ts', '/r')).toBeNull();
  expect(relativePath('/r/a.ts', null)).toBeNull();
});
test('pathCategory', () => {
  expect(pathCategory('/r/src/a.ts', '/r')).toBe('source');
  expect(pathCategory('/r/tests/a.test.ts', '/r')).toBe('test');
  expect(pathCategory('/r/src/a.spec.ts', '/r')).toBe('test');
  expect(pathCategory('/r/package.json', '/r')).toBe('config');
  expect(pathCategory('/r/.env', '/r')).toBe('config');
  expect(pathCategory('/r/.github/workflows/ci.yml', '/r')).toBe('config');
  expect(pathCategory('/r/docs/x.md', '/r')).toBe('docs');
  expect(pathCategory('/elsewhere/x', '/r')).toBe('outside');
  expect(pathCategory(undefined, '/r')).toBe('none');
});

test('a root without a non-empty segment is not usable', () => {
  for (const root of ['/', '//', '/./', '/../']) {
    expect(relativePath('/srv/data/secret.txt', root)).toBeNull();
    expect(pathCategory('/srv/data/secret.txt', root)).toBe('outside');
    expect(pathCategory(undefined, root)).toBe('none');
  }
  expect(relativePath('/r/a.ts', '/r/')).toBe('a.ts');
  expect(relativePath('/r/a.ts', '//r/./')).toBe('a.ts');
});
