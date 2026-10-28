// L字階段（回り段）の出入口（出口は横の辺の上端だけ）と左右反転の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import { getStairType } from '../js/catalog.js';

const rect = (id, type, x1, z1, x2, z2) => ({ id, type, name: id, polygon: M.rectPolygon(x1, z1, x2, z2), labelVisible: true });
// x 0..910 / z 0..2730。登り口は +Z（z=2730）、回り段の正方形は z 0..910
const lWinder = (extra = {}) => ({ id: 's1', type: 'l_winder', widthMM: 910, depthMM: 2730, x: 455, z: 1365, rotationDeg: 0, ...extra });

/** 階段の右（+X）に廊下 H、下（+Z）に玄関 E。階段は部屋の外 */
function floorWith(stair) {
  const plan = M.createEmptyPlan('t');
  const floor = plan.floors[0];
  floor.rooms.push(rect('H', 'rouka', 910, 0, 2730, 2730), rect('E', 'genkan', 0, 2730, 910, 3640));
  floor.stairs = [stair];
  M.rebuildFloorWalls(floor, plan);
  return floor;
}

/** 間口の中心（世界座標） */
function openingCenter(floor, op) {
  const w = floor.walls.find((wl) => wl.id === op.wallId);
  const len = Math.hypot(w.end.x - w.start.x, w.end.z - w.start.z);
  const t = op.offsetMM / len;
  return { x: w.start.x + (w.end.x - w.start.x) * t, z: w.start.z + (w.end.z - w.start.z) * t };
}

test('既定の大きさは 1P × 3P', () => {
  const def = getStairType('l_winder');
  assert.equal(def.defaultW, M.P_MM);
  assert.equal(def.defaultD, 3 * M.P_MM);
});

test('出口は +X 辺の上端（回り段の正方形）だけ。左右反転で −X 辺の上端', () => {
  const right = M.stairOpenEdgeSegments(lWinder());
  assert.equal(right.length, 2);
  const exit = right[1];
  assert.ok(Math.abs(exit.start.x - 910) < 1 && Math.abs(exit.end.x - 910) < 1);
  assert.deepEqual([exit.start.z, exit.end.z].map(Math.round).sort((a, b) => a - b), [0, 910]);

  const left = M.stairOpenEdgeSegments(lWinder({ mirror: true }))[1];
  assert.ok(Math.abs(left.start.x) < 1 && Math.abs(left.end.x) < 1);
  assert.deepEqual([left.start.z, left.end.z].map(Math.round).sort((a, b) => a - b), [0, 910]);
});

test('自動間口: 出口側の部屋の壁には上端 1P だけ、登り口側の部屋の壁にも開く', () => {
  const floor = floorWith(lWinder());
  const ops = floor.openings.filter((op) => op.autoStairId);
  assert.equal(ops.length, 2);
  const byRoom = Object.fromEntries(ops.map((op) => [floor.walls.find((w) => w.id === op.wallId).roomId, op]));
  assert.ok(Math.abs(byRoom.H.widthMM - 910) < 1, `幅 ${byRoom.H.widthMM}`);
  const c = openingCenter(floor, byRoom.H);
  assert.ok(Math.abs(c.x - 910) < 1 && Math.abs(c.z - 455) < 1, `中心 ${JSON.stringify(c)}`);
  assert.ok(byRoom.E, '登り口（玄関側）の間口');
});

test('左右反転すると出口は −X 側。そこに部屋が無ければ廊下側の間口は無くなる', () => {
  const floor = floorWith(lWinder({ mirror: true }));
  const rooms = floor.openings.filter((op) => op.autoStairId)
    .map((op) => floor.walls.find((w) => w.id === op.wallId).roomId);
  assert.deepEqual(rooms, ['E']);
});
