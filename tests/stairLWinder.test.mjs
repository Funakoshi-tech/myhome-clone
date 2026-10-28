// L字階段（上で回る・下で回る）の出入口（横の辺の一部）と左右反転の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import { getStairType, stairCanMirror } from '../js/catalog.js';

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

// ---- L字階段（下で回る）: 登り口は横の辺の下端、出口は上の辺 ----

const lWinderBottom = (extra = {}) => lWinder({ type: 'l_winder_bottom', ...extra });

/** 階段の右（+X）に廊下 H、上（−Z）に部屋 N。階段は部屋の外 */
function floorWithBottom(stair) {
  const plan = M.createEmptyPlan('t');
  const floor = plan.floors[0];
  floor.rooms.push(rect('H', 'rouka', 910, 0, 2730, 2730), rect('N', 'yoshitsu', 0, -1820, 2730, 0));
  floor.stairs = [stair];
  M.rebuildFloorWalls(floor, plan);
  return floor;
}

test('下で回る: 既定は 1P × 3P、左右反転できる', () => {
  const def = getStairType('l_winder_bottom');
  assert.equal(def.defaultW, M.P_MM);
  assert.equal(def.defaultD, 3 * M.P_MM);
  assert.ok(stairCanMirror('l_winder_bottom') && stairCanMirror('l_winder') && !stairCanMirror('straight'));
});

test('下で回る: 登り口は +X 辺の下端 1P、出口は上の辺。左右反転で −X 辺の下端', () => {
  const [entry, exit] = M.stairOpenEdgeSegments(lWinderBottom());
  assert.ok(Math.abs(entry.start.x - 910) < 1 && Math.abs(entry.end.x - 910) < 1);
  assert.deepEqual([entry.start.z, entry.end.z].map(Math.round).sort((a, b) => a - b), [1820, 2730]);
  assert.ok(Math.abs(exit.start.z) < 1 && Math.abs(exit.end.z) < 1);

  const left = M.stairOpenEdgeSegments(lWinderBottom({ mirror: true }))[0];
  assert.ok(Math.abs(left.start.x) < 1 && Math.abs(left.end.x) < 1);
  assert.deepEqual([left.start.z, left.end.z].map(Math.round).sort((a, b) => a - b), [1820, 2730]);
});

test('下で回る: 自動間口は登り口側の部屋の壁の下端 1P と、出口側の部屋の壁', () => {
  const floor = floorWithBottom(lWinderBottom());
  const ops = floor.openings.filter((op) => op.autoStairId);
  const byRoom = Object.fromEntries(ops.map((op) => [floor.walls.find((w) => w.id === op.wallId).roomId, op]));
  assert.deepEqual(Object.keys(byRoom).sort(), ['H', 'N']);
  assert.ok(Math.abs(byRoom.H.widthMM - 910) < 1, `幅 ${byRoom.H.widthMM}`);
  const c = openingCenter(floor, byRoom.H);
  assert.ok(Math.abs(c.x - 910) < 1 && Math.abs(c.z - 2275) < 1, `中心 ${JSON.stringify(c)}`);

  const mirrored = floorWithBottom(lWinderBottom({ mirror: true }));
  const rooms = mirrored.openings.filter((op) => op.autoStairId)
    .map((op) => mirrored.walls.find((w) => w.id === op.wallId).roomId);
  assert.deepEqual(rooms, ['N'], '左から入る形では廊下 H 側に間口は無い');
});
