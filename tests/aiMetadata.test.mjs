import assert from 'node:assert/strict';
import test from 'node:test';
import { modelSelection } from '../src/features/ai/types.ts';

const models = [
  { id: 'custom', name: 'Custom', reasoningEfforts: [{ value: 'minimal', label: '轻量', description: '' }, { value: 'max-v2', label: '深度', description: '' }], defaultReasoningEffort: 'minimal' },
  { id: 'plain', name: 'Plain', reasoningEfforts: [], defaultReasoningEffort: null },
];

test('reasoning choices contain only values returned by model metadata', () => {
  const selection = modelSelection(models, 'custom', 'max-v2');
  assert.deepEqual(selection.efforts.map(e => e.value), ['default', 'minimal', 'max-v2']);
  assert.equal(selection.effort, 'max-v2');
  assert.equal(selection.efforts[2].label, '深度');
  assert.equal(modelSelection(models, 'custom', 'high').effort, 'minimal');
});

test('a model without declared levels exposes default only, and removed IDs are not offered', () => {
  assert.deepEqual(modelSelection(models, 'plain', 'max-v2').efforts.map(e => e.value), ['default']);
  assert.equal(modelSelection(models, 'plain', 'max-v2').effort, 'default');
  assert.equal(modelSelection(models, 'removed', 'default', 'plain').model, 'plain');
  assert.equal(modelSelection([], 'old-manual-id', 'high').model, '');
});

test('manual models survive discovery failures and custom levels are kept only when explicitly entered', async () => {
  const { mergeModelSources } = await import('../src/features/ai/types.ts');
  const merged = mergeModelSources(models, ['private-model', 'custom']);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(m=>m.id==='custom').reasoningEfforts.length, 2);
  assert.equal(merged.find(m=>m.id==='custom').manual, true);
  assert.equal(merged.find(m=>m.id==='private-model').manual, true);
  const manual = modelSelection([], 'private-model', 'max-custom', '', true, true);
  assert.equal(manual.model, 'private-model');
  assert.equal(manual.effort, 'max-custom');
  assert.equal(manual.manualModel, true);
  assert.equal(manual.manualEffort, true);
  assert.equal(modelSelection(models, 'custom', 'max-custom').effort, 'minimal');
});

test('compaction threshold follows the declared context window like the backend budget', async () => {
  const { compactionThreshold, historyWriteDelay } = await import('../src/features/ai/types.ts');
  // Same samples as context::tests in src-tauri/src/ai/context.rs.
  assert.equal(compactionThreshold(undefined), 200000);
  assert.equal(compactionThreshold(null), 200000);
  assert.equal(compactionThreshold(1000000), 750000);
  assert.equal(compactionThreshold(128000), 96000);
  assert.equal(compactionThreshold(2000), 8000);
  assert.ok(historyWriteDelay(true) > historyWriteDelay(false));
});

test('/compact is recognized with optional focus text and nothing else is', async () => {
  const { parseCompactCommand } = await import('../src/features/ai/types.ts');
  assert.equal(parseCompactCommand('/compact'), '');
  assert.equal(parseCompactCommand('  /compact  '), '');
  assert.equal(parseCompactCommand('/compact 保留 nginx 配置\n和端口'), '保留 nginx 配置\n和端口');
  assert.equal(parseCompactCommand('/COMPACT keep logs'), 'keep logs');
  assert.equal(parseCompactCommand('/compactness'), null);
  assert.equal(parseCompactCommand('please /compact'), null);
  assert.equal(parseCompactCommand('检查服务器'), null);
});
