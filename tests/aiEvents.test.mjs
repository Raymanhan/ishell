import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAiEvent } from '../src/features/ai/types.ts';

test('streamed assistant text and reasoning stay in their own round', () => {
  let entries = applyAiEvent([], { type: 'thinking', text: '先检查' }, 'round-1');
  entries = applyAiEvent(entries, { type: 'text', text: '环境' }, 'round-1');
  entries = applyAiEvent(entries, { type: 'text', text: '正常' }, 'round-1');
  entries = applyAiEvent(entries, { type: 'text', text: '已部署' }, 'round-2');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].thinking, '先检查');
  assert.equal(entries[0].text, '环境正常');
  assert.equal(entries[1].text, '已部署');
});

test('progress replaces output in one card and preserves failure details', () => {
  let entries = applyAiEvent([], { type: 'tool_start', id: 'tool-1', name: 'shell', arguments: { command: 'false' } }, 'round');
  entries = applyAiEvent(entries, { type: 'tool_output', id: 'tool-1', result: { stdout: 'partial' } }, 'round');
  entries = applyAiEvent(entries, { type: 'tool_end', id: 'tool-1', result: { stdout: 'all', stderr: 'failed', exitCode: 1 } }, 'round');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].running, false);
  assert.equal(entries[0].result.stdout, 'all');
  assert.equal(entries[0].result.stderr, 'failed');
  assert.equal(entries[0].result.exitCode, 1);
  assert.equal(entries[0].arguments.command, 'false');
});

test('approval waits in the tool card until a matching result arrives', () => {
  let entries = applyAiEvent([], { type: 'tool_start', id: 'write-1', name: 'write_file', arguments: { path: '/etc/app.conf', content: 'new' } }, 'round');
  entries = applyAiEvent(entries, { type: 'approval', id: 'write-1', approvalId: 'approval-1', risk: { level: 'high', label: '高风险', reason: '覆盖系统配置' } }, 'round');
  assert.equal(entries[0].approvalPending, true);
  assert.equal(entries[0].running, false);
  assert.equal(entries[0].approvalId, 'approval-1');
  assert.equal(entries[0].risk.level, 'high');
  entries = applyAiEvent(entries, { type: 'tool_end', id: 'write-1', result: { status: 'done', error: '用户拒绝', exitCode: null } }, 'round');
  assert.equal(entries[0].approvalPending, false);
  assert.equal(entries[0].running, false);
  assert.equal(entries[0].result.error, '用户拒绝');
});
