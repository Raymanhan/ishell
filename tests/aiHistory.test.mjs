import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversation, defaultAiConfig, restoreConversation, serverHistory, conversationTitle, applyAiEvent } from '../src/features/ai/types.ts';

test('new conversations have independent identities and histories are isolated by server', () => {
  const a = createConversation(defaultAiConfig, 'a');
  const b = createConversation(defaultAiConfig, 'a');
  const c = createConversation(defaultAiConfig, 'b');
  assert.notEqual(a.id, b.id);
  for (const item of [a, c]) item.entries.push({ id: 'user', kind: 'user', text: '  检查\n Docker  ' });
  assert.deepEqual(serverHistory({ [a.id]: a, [b.id]: b, [c.id]: c }, 'a').map(item => item.id), [a.id]);
  assert.equal(conversationTitle(a), '检查 Docker');
  b.entries.push({ id: 'user', kind: 'user', text: '第二个任务' });
  b.updatedAt = a.updatedAt + 1;
  assert.deepEqual(serverHistory({ [a.id]: a, [b.id]: b }, 'a').map(item => item.id), [b.id, a.id]);
  assert.equal(a.entries.length, 1);
});

test('restoring an interrupted task preserves messages and results without resuming tools or approvals', () => {
  const saved = createConversation(defaultAiConfig, 'server');
  Object.assign(saved, { requestId: 'request', sessionId: 'old-session', compacting: true, stopping: true, model: 'custom', effort: 'max', permission: 'ask', contextTokens: 150000 });
  saved.entries.push({ id: 'tool', kind: 'tool', running: true, approvalPending: true, approvalBusy: true, approvalId: 'old-approval', result: { stdout: '真实结果' } });
  saved.messages.push({ role: 'user', content: '检查环境' });
  const restored = restoreConversation(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.requestId, null);
  assert.equal(restored.sessionId, null);
  assert.equal(restored.compacting, false);
  assert.equal(restored.entries[0].running, false);
  assert.equal(restored.entries[0].approvalPending, false);
  assert.equal(restored.entries[0].approvalId, undefined);
  assert.equal(restored.entries[0].result.stdout, '真实结果');
  assert.equal(restored.entries.at(-1).kind, 'notice');
  assert.equal(restored.model, 'custom');
  assert.equal(restored.permission, 'ask');
  assert.deepEqual(restored.messages, saved.messages);
  assert.equal(saved.entries[0].running, true);
  assert.equal(restoreConversation(restored).entries.length, restored.entries.length);
});

test('completed history restores without interruption notices and keeps compacted wire context separate', () => {
  const saved = createConversation(defaultAiConfig, 'server');
  saved.entries = applyAiEvent([], { type: 'text', text: '可见历史' }, 'assistant');
  saved.messages = [{ role: 'user', content: '压缩摘要' }];
  const restored = restoreConversation(saved);
  assert.equal(restored.entries.length, 1);
  assert.equal(restored.entries[0].text, '可见历史');
  assert.equal(restored.messages[0].content, '压缩摘要');
});
