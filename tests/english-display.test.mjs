import test from 'node:test';
import assert from 'node:assert/strict';
import { unitLabel, storageLabel } from '../lib/english-display.mjs';

test('English labels preserve legacy unit and storage keys', () => {
  assert.equal(unitLabel('袋', 1), 'bag');
  assert.equal(unitLabel('袋', 0.5), 'bags');
  assert.equal(unitLabel('个', 2), 'items');
  assert.equal(unitLabel('ml', 300), 'mL');
  assert.equal(unitLabel('g', 25), 'g');
  assert.equal(unitLabel('custom'), 'custom');
  assert.equal(storageLabel('冷冻'), 'Frozen');
  assert.equal(storageLabel('冷藏'), 'Refrigerated');
  assert.equal(storageLabel(''), 'Not specified');
});
