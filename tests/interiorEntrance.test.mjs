// 全階表示から内観に入るときの「家に入る階」の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntranceFloorId, yawToward } from '../js/interiorNav.js';

const sq = [{ x: 0, z: 0 }, { x: 1000, z: 0 }, { x: 1000, z: 1000 }, { x: 0, z: 1000 }];
const floor = (id, ...types) => ({ id, rooms: types.map((type, i) => ({ id: `${id}-${i}`, type, polygon: sq })) });

test('玄関のある階から入る（2F に玄関があれば 2F）', () => {
  const plan = { floors: [floor('1F', 'ldk'), floor('2F', 'genkan', 'bedroom')] };
  assert.equal(findEntranceFloorId(plan), '2F');
});

test('玄関がなければポーチのある階、どちらもなければいちばん下の階', () => {
  assert.equal(findEntranceFloorId({ floors: [floor('1F', 'ldk'), floor('2F', 'porch')] }), '2F');
  assert.equal(findEntranceFloorId({ floors: [floor('1F', 'ldk'), floor('2F', 'bedroom')] }), '1F');
  assert.equal(findEntranceFloorId({ floors: [] }), null);
});

test('yawToward で向いた方向に相手がいる（前は (-sin yaw, -cos yaw)）', () => {
  const from = { x: 1000, z: 1000 };
  for (const to of [{ x: 3000, z: 1000 }, { x: -2000, z: 1000 }, { x: 1000, z: 4000 }, { x: 1000, z: -500 }, { x: 2500, z: 2500 }]) {
    const yaw = yawToward(from, to);
    const len = Math.hypot(to.x - from.x, to.z - from.z);
    assert.ok(Math.abs(-Math.sin(yaw) - (to.x - from.x) / len) < 1e-9);
    assert.ok(Math.abs(-Math.cos(yaw) - (to.z - from.z) / len) < 1e-9);
  }
});
