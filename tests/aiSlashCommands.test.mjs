import assert from 'node:assert/strict';
import test from 'node:test';
import { localSlashCommand, matchSlashCommands } from '../src/features/ai/slashCommands.ts';

const names = (draft) => matchSlashCommands(draft)?.map((command) => command.name) ?? null;

test('typing / lists every command, and the list narrows as the name is typed', () => {
  assert.deepEqual(names('/'), ['compact', 'new', 'history', 'settings']);
  assert.deepEqual(names('/comp'), ['compact']);
  assert.deepEqual(names('/his'), ['history']);
  // Prefix matches come before names that only contain the text.
  assert.deepEqual(names('/s'), ['settings', 'history']);
  assert.deepEqual(names('/zzz'), []);
});

test('the menu is only for a bare command being typed', () => {
  assert.equal(names('/compact keep nginx'), null);
  assert.equal(names('check /var/log'), null);
  assert.equal(names(''), null);
});

test('commands the panel runs itself are recognised only in full', () => {
  assert.equal(localSlashCommand(' /new '), 'new');
  assert.equal(localSlashCommand('/History'), 'history');
  assert.equal(localSlashCommand('/settings now'), null);
  assert.equal(localSlashCommand('/compact'), null);
  assert.equal(localSlashCommand('/ne'), null);
});
