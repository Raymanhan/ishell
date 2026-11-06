import assert from 'node:assert/strict';
import test from 'node:test';
import { revealStep } from '../src/features/ai/useSmoothText.ts';

test('streamed text is revealed gradually and catches up with a burst', () => {
  const text = 'x'.repeat(400);
  let shown = 0;
  const steps = [];
  while (shown < text.length) {
    shown = revealStep(text, shown, true);
    steps.push(shown);
  }
  // Big early steps for a backlog, then progressively smaller ones.
  assert.equal(steps[0], 50);
  assert.ok(steps.length > 10 && steps.length < 60, String(steps.length));
  assert.equal(revealStep('abc', 2, true), 3);
  assert.equal(revealStep('abc', 3, true), 3);
});

test('a finished reply drains faster than one still streaming', () => {
  const text = 'y'.repeat(300);
  assert.ok(revealStep(text, 0, false) > revealStep(text, 0, true));
  assert.equal(revealStep('ab', 0, false), 2);
});

test('the reveal never splits a surrogate pair', () => {
  const text = 'a😀b';
  assert.equal(revealStep(text, 0, true), 1);
  assert.equal(revealStep(text, 1, true), 3);
});
