// 全階表示から内観に入るときの「家に入る階」の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { findEntranceFloorId } from '../js/interiorNav.js';

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
