import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, defaultAiConfig, modelSelection } from '../src/features/ai/types.ts';
import { readAiPreferences, rememberAiPreferences } from '../src/features/ai/preferences.ts';
import { toolStatus } from '../src/features/ai/toolStatus.ts';

function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('a selection made before sending survives a fresh session; sensitive conversation content is excluded', () => {
  const local = storage();
  const conversation = Object.assign(createConversation(defaultAiConfig, 'server-a'), {
    model: 'private-model', effort: 'max-custom', manualModel: true, manualEffort: true, permission: 'ask', draft: 'private draft',
    messages: [{ role: 'user', content: 'private message' }],
  });
  assert.equal(conversation.entries.length, 0);
  rememberAiPreferences(local, 'https://api.example/v1/', conversation);
  const restored = { ...createConversation(defaultAiConfig, 'server-a'), ...readAiPreferences(local, 'https://api.example/v1', 'server-a') };
  assert.equal(restored.model, 'private-model');
  assert.equal(restored.effort, 'max-custom');
  assert.equal(restored.manualModel, true);
  assert.equal(restored.manualEffort, true);
  assert.equal(restored.permission, 'ask');
  assert.equal(restored.entries.length, 0);
  assert.equal(restored.draft, '');
  assert.ok(![...local.data.values()].join('').includes('private draft'));
  assert.ok(![...local.data.values()].join('').includes('private message'));
});

test('model choices follow the API service while permissions stay with their server', () => {
  const local = storage();
  const a = Object.assign(createConversation(defaultAiConfig, 'a'), { model: 'first', effort: 'high', permission: 'full' });
  const b = Object.assign(createConversation(defaultAiConfig, 'b'), { model: 'second', effort: 'low', permission: 'ask' });
  rememberAiPreferences(local, 'https://one/v1', a);
  assert.equal(readAiPreferences(local, 'https://one/v1', 'b').permission, undefined);
  rememberAiPreferences(local, 'https://one/v1', b);
  assert.equal(readAiPreferences(local, 'https://one/v1', 'a').model, 'second');
  assert.equal(readAiPreferences(local, 'https://one/v1', 'a').permission, 'full');
  assert.equal(readAiPreferences(local, 'https://one/v1', 'b').permission, 'ask');
  assert.deepEqual(readAiPreferences(local, 'https://two/v1', 'a'), {});
});

test('damaged cache falls back safely and outdated automatic selections still obey current metadata', () => {
  const local = storage();
  const conversation = Object.assign(createConversation(defaultAiConfig, 'a'), { model: 'removed', effort: 'high' });
  rememberAiPreferences(local, 'https://one/v1', conversation);
  const cached = readAiPreferences(local, 'https://one/v1', 'a');
  const selection = modelSelection([{ id: 'current', name: 'current', reasoningEfforts: [], defaultReasoningEffort: null }], cached.model, cached.effort);
  assert.equal(selection.model, 'current');
  assert.equal(selection.effort, 'default');
  const key = [...local.data.keys()][0];
  local.setItem(key, 'invalid JSON');
  assert.deepEqual(readAiPreferences(local, 'https://one/v1', 'a'), {});
  local.setItem(key, JSON.stringify({ 'https://one/v1': { selection: { model: 123 }, permissions: { a: 'invalid' } } }));
  assert.deepEqual(readAiPreferences(local, 'https://one/v1', 'a'), {});
});

test('zero exits are human-readable, but errors and missing results never look successful', () => {
  const entry = { id: 'tool', kind: 'tool', name: 'shell', result: { status: 'done', exitCode: 0 } };
  assert.deepEqual(toolStatus(entry), { kind: 'success', label: '执行成功' });
  assert.equal(toolStatus({ ...entry, name: 'write_file' }).label, '写入成功');
  assert.equal(toolStatus({ ...entry, result: { exitCode: 0, error: 'verification failed' } }).kind, 'error');
  assert.equal(toolStatus({ ...entry, result: { exitCode: 1 } }).label, '执行失败');
  assert.equal(toolStatus({ ...entry, result: undefined }).kind, 'neutral');
  assert.equal(toolStatus({ ...entry, approved: false }).label, '已拒绝');
  assert.equal(toolStatus({ ...entry, result: { error: '已停止执行', exitCode: -15 } }).label, '已停止');
  assert.equal(toolStatus({ ...entry, result: { error: '工具状态无法获取，无法确认远端是否已停止' } }).kind, 'error');
});
