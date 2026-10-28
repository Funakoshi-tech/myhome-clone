// 直進階段の既定の大きさと段の数の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { getStairType, straightStairStepCount } from '../js/catalog.js';
import { P_MM } from '../js/model.js';

test('直進階段の既定の大きさは幅 1P × 奥行 3P（縦長）', () => {
  const def = getStairType('straight');
  assert.equal(def.defaultW, P_MM);
  assert.equal(def.defaultD, 3 * P_MM);
});

test('段の数は約 182mm ごと（3P で 15 段）。短すぎ・長すぎは範囲内に収める', () => {
  assert.equal(straightStairStepCount(3 * P_MM), 15);
  assert.equal(straightStairStepCount(4 * P_MM), 20);
  assert.equal(straightStairStepCount(300), 3);
  assert.equal(straightStairStepCount(10000), 20);
});
