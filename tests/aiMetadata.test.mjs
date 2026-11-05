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
