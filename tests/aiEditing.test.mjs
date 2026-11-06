import assert from 'node:assert/strict';
import test from 'node:test';
import { editableUserEntries, rewindTo } from '../src/features/ai/types.ts';
import { toolTitle } from '../src/features/ai/toolStatus.ts';
import { isImeKey } from '../src/features/ai/ime.ts';

const user = (id, text) => ({ id, kind: 'user', text });
const reply = (id) => ({ id, kind: 'assistant', text: 'ok' });
const ask = (content) => ({ role: 'user', content });
const answer = { role: 'assistant', content: 'ok' };
const call = { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'shell', arguments: '{}' } }] };
const result = { role: 'tool', tool_call_id: 't', content: '{}' };

test('editing a message rewinds the chat and the model context to just before it', () => {
  const conversation = {
    entries: [user('a', '检查磁盘'), reply('r1'), user('b', '清理日志'), { id: 't', kind: 'tool', name: 'shell' }, reply('r2'), user('c', '检查磁盘')],
    messages: [ask('检查磁盘'), answer, ask('清理日志'), call, result, answer, ask('检查磁盘')],
  };
  assert.deepEqual(rewindTo(conversation, 'b'), {
    entries: conversation.entries.slice(0, 2),
    messages: conversation.messages.slice(0, 2),
  });
  // Repeated text is matched by position, not by the first equal message.
  assert.deepEqual(rewindTo(conversation, 'c').messages, conversation.messages.slice(0, 6));
  assert.deepEqual(rewindTo(conversation, 'a'), { entries: [], messages: [] });
  assert.equal(rewindTo(conversation, 'r1'), null);
  assert.deepEqual([...editableUserEntries(conversation)].sort(), ['a', 'b', 'c']);
});

test('/compact bubbles are skipped, and messages folded into a summary cannot be rewound', () => {
  const conversation = {
    entries: [user('a', '部署网站'), reply('r1'), user('k', '/compact 保留端口'), { id: 'n', kind: 'notice', text: '已压缩' }, user('b', '继续')],
    messages: [ask('[已压缩的历史上下文，仅供参考，后续用户消息优先]\n摘要'), ask('继续')],
  };
  assert.equal(rewindTo(conversation, 'a'), null);
  assert.equal(rewindTo(conversation, 'k'), null);
  assert.deepEqual(rewindTo(conversation, 'b').messages, conversation.messages.slice(0, 1));
  assert.deepEqual([...editableUserEntries(conversation)], ['b']);
});

test('a mismatch between the chat and the context refuses to rewind', () => {
  const conversation = { entries: [user('a', '旧文本')], messages: [ask('别的文本')] };
  assert.equal(rewindTo(conversation, 'a'), null);
  assert.equal(editableUserEntries(conversation).size, 0);
});

test('tool cards are titled by the model description, else by the command itself', () => {
  assert.deepEqual(
    toolTitle({ id: '1', kind: 'tool', name: 'shell', arguments: { description: '  检查\n磁盘占用 ', command: 'df -h' } }),
    { title: '检查 磁盘占用', literal: false },
  );
  assert.deepEqual(
    toolTitle({ id: '2', kind: 'tool', name: 'shell', arguments: { command: '\n  df -h /\n du -sh /var' } }),
    { title: 'df -h /', literal: true },
  );
  assert.equal(toolTitle({ id: '3', kind: 'tool', name: 'read_file', arguments: { path: '/etc/hosts' } }).title, '读取 /etc/hosts');
  assert.equal(toolTitle({ id: '4', kind: 'tool', name: 'run_code', arguments: { language: 'python' } }).title, '运行 python 代码');
  assert.equal(toolTitle({ id: '5', kind: 'tool', name: 'shell' }).title, '执行命令');
});

test('Enter that commits an input method candidate is not treated as submit', () => {
  assert.equal(isImeKey({ isComposing: true, keyCode: 13 }), true);
  // macOS WebKit: compositionend already fired, but the key is still IME 229.
  assert.equal(isImeKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isImeKey({ isComposing: false, keyCode: 13 }, true), true);
  assert.equal(isImeKey({ isComposing: false, keyCode: 13 }), false);
});
