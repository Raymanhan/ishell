import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseReleaseNotes } from '../src/features/updater/releaseNotes.ts';

test('parses only the changelog section, joins wrapped notes and expands grouped versions', () => {
  const notes = parseReleaseNotes('# Example\n- `v9.9.9` not a release\n## 最近更新\n\n- `v1.1.9` old\n- `v1.1.20` new with `code`\n  continuation\n- `v0.1.7` / `v0.1.6` shared\n\n## 许可证\n- `v8.8.8` not a release');
  assert.deepEqual(notes.map(note => note.version), ['1.1.20', '1.1.9', '0.1.7', '0.1.6']);
  assert.equal(notes[0].notes, 'new with `code` continuation');
  assert.equal(notes[2].notes, 'shared');
});

test('handles English sections, CRLF, duplicates, and documents without changelogs', () => {
  assert.deepEqual(parseReleaseNotes('## Recent Changes\r\n- `v2.0.0` first\r\n- `v2.0.0` duplicate'), [{ version: '2.0.0', notes: 'first' }]);
  assert.deepEqual(parseReleaseNotes('## Other\n- `v1.2.3` other'), []);
});

test('every release includes current-version notes in both app history and updater source', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const chinese = parseReleaseNotes(readFileSync(new URL('../README.zh-CN.md', import.meta.url), 'utf8'));
  const english = parseReleaseNotes(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
  assert.equal(chinese[0]?.version, version, 'Add notes for the new version to README.zh-CN.md');
  assert.equal(english[0]?.version, version, 'Add notes for the new version to README.md');
  assert.ok(chinese[0].notes.length > 10);
  assert.ok(english[0].notes.length > 10);
});
