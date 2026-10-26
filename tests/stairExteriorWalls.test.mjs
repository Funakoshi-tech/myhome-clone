// 階段の外に面する辺の外壁（stairExteriorWallSpans）と、自動間口が外壁に開かないことの単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const rect = (id, type, x1, z1, x2, z2) => ({ id, type, name: id, polygon: M.rectPolygon(x1, z1, x2, z2), labelVisible: true });
const stair = (x, z, extra = {}) => ({ id: 's1', type: 'straight', widthMM: 910, depthMM: 2730, x, z, rotationDeg: 0, ...extra });

function floorWith(rooms, stairs) {
  const plan = M.createEmptyPlan('t');
  const floor = plan.floors[0];
  floor.rooms.push(...rooms);
  floor.stairs = stairs;
  M.rebuildFloorWalls(floor, plan);
  return { plan, floor };
}

const autoOps = (floor) => floor.openings.filter((op) => op.autoStairId);
const wallOf = (floor, op) => floor.walls.find((w) => w.id === op.wallId);

test('部屋の外に置いた階段: 部屋に接する辺以外の 3 辺に外壁が付く', () => {
  // 居室 R（0..3640 × 0..3640）の東隣、x 3640..4550 / z 0..2730 に階段
  const { floor } = floorWith([rect('R', 'yoshitsu', 0, 0, 3640, 3640)], [stair(4095, 1365)]);
  const spans = M.stairExteriorWallSpans(floor.stairs[0], floor);
  assert.deepEqual(spans.map((s) => s.edge).sort(), [0, 1, 2]);
  for (const s of spans) {
    assert.equal(s.t0, 0);
    assert.equal(s.t1, 1);
  }
});

test('部屋の中で外周の壁に沿う階段: 部屋の壁が外壁を担うので追加しない', () => {
  const { floor } = floorWith(
    [rect('R', 'yoshitsu', 0, 0, 3640, 2730), rect('H', 'rouka', 0, 2730, 3640, 4550)],
    [stair(1820, 1365)],
  );
  assert.deepEqual(M.stairExteriorWallSpans(floor.stairs[0], floor), []);
});

test('部屋の外周から一部はみ出した辺は、はみ出した区間だけ外壁になる', () => {
  // 居室 R（0..3640 × 0..1820）の東隣。階段の −X 辺（x 3640, z 0..2730）のうち z 1820..2730 は外
  const { floor } = floorWith([rect('R', 'yoshitsu', 0, 0, 3640, 1820)], [stair(4095, 1365)]);
  const west = M.stairExteriorWallSpans(floor.stairs[0], floor).filter((s) => s.edge === 3);
  assert.equal(west.length, 1);
  // −X 辺は +Z → −Z の向き（corners[3] → corners[0]）なので、外の区間は辺の始点側
  assert.equal(west[0].t0, 0);
  assert.ok(Math.abs(west[0].t1 - 910 / 2730) < 0.03, `t1=${west[0].t1}`);
});

test('バルコニーに面する辺は外壁になる', () => {
  const { floor } = floorWith(
    [rect('R', 'yoshitsu', 0, 0, 3640, 3640), rect('B', 'balcony', 4550, 0, 5460, 3640)],
    [stair(4095, 1365)],
  );
  const edges = M.stairExteriorWallSpans(floor.stairs[0], floor).map((s) => s.edge).sort();
  assert.deepEqual(edges, [0, 1, 2]);
});

test('自動間口は外壁に開かず、室内の壁にだけ開く', () => {
  // 階段の −Z 辺（降り口）は建物の外周 z=0、+Z 辺（登り口）は廊下との間の壁 z=2730
  const { floor } = floorWith(
    [rect('R', 'yoshitsu', 0, 0, 3640, 2730), rect('H', 'rouka', 0, 2730, 3640, 4550)],
    [stair(1820, 1365)],
  );
  const ops = autoOps(floor);
  assert.ok(ops.length > 0);
  for (const op of ops) {
    const w = wallOf(floor, op);
    assert.ok(!M.isExteriorWall(w, floor, null), `外壁 ${w.id} に間口が開いている`);
    assert.ok(Math.abs(w.start.z - 2730) < 1 && Math.abs(w.end.z - 2730) < 1);
  }
});

test('部屋の外に置いた階段から部屋へ入る壁（部屋の外周）には自動間口が開く', () => {
  // L 字の居室の切り欠き（x 5460..6370, z 0..2730）に階段。登り口 +Z は R1b の外周の壁 z=2730
  const { floor } = floorWith(
    [rect('R1', 'yoshitsu', 0, 0, 5460, 5460), rect('R1b', 'yoshitsu', 5460, 2730, 7280, 5460)],
    [stair(5915, 1365)],
  );
  const ops = autoOps(floor);
  assert.equal(ops.length, 1);
  const w = wallOf(floor, ops[0]);
  assert.equal(w.roomId, 'R1b');
  assert.ok(M.isExteriorWall(w, floor, null), '壁自体は建物の外周');
  // 外に面する −Z・+X 辺に外壁、部屋に接する −X・+Z 辺には付かない
  assert.deepEqual(M.stairExteriorWallSpans(floor.stairs[0], floor).map((s) => s.edge).sort(), [0, 1]);
});

test('上の階に階段が無いとき、上がってきた階段の上の外に面する辺を、上の階の部屋に対して外壁にする', () => {
  const plan = M.createEmptyPlan('t');
  const [f1, f2] = plan.floors;
  // 1F: L 字の切り欠きに階段。2F: 同じ L 字で、階段の場所は部屋なし（階段なし）
  for (const f of [f1, f2]) {
    f.rooms.push(rect(`${f.id}a`, 'yoshitsu', 0, 0, 5460, 5460), rect(`${f.id}b`, 'yoshitsu', 5460, 2730, 7280, 5460));
  }
  f1.stairs = [stair(5915, 1365)];
  for (const f of [f1, f2]) M.rebuildFloorWalls(f, plan);
  const ending = M.stairsEndingOnFloor(plan, f2);
  assert.deepEqual(ending.map((s) => s.id), ['s1']);
  // 2F では −X は部屋 2Fa、+Z は部屋 2Fb の壁が受け持つので、外に面する −Z・+X に外壁
  assert.deepEqual(M.stairExteriorWallSpans(ending[0], f2).map((s) => s.edge).sort(), [0, 1]);
  assert.deepEqual(M.stairsEndingOnFloor(plan, f1), [], '最下階には下から上がってくる階段が無い');
});

test('上の階の同じ場所に階段があるときは、上の階の外壁はその階段に任せる', () => {
  const plan = M.createEmptyPlan('t');
  const [f1, f2] = plan.floors;
  f1.stairs = [stair(5915, 1365)];
  f2.stairs = [stair(5915, 1365, { id: 's2' })];
  assert.deepEqual(M.stairsEndingOnFloor(plan, f2), []);
  // 一部だけ重なる場合も上の階の階段に任せる
  f2.stairs = [stair(5915, 2000, { id: 's2' })];
  assert.deepEqual(M.stairsEndingOnFloor(plan, f2), []);
  // 離れた場所の階段なら、上がってきた階段の上は外壁で囲う
  f2.stairs = [stair(1000, 1365, { id: 's2' })];
  assert.deepEqual(M.stairsEndingOnFloor(plan, f2).map((s) => s.id), ['s1']);
});

test('上の階で部屋が階段の上を覆っていれば、追加の外壁は無い', () => {
  const plan = M.createEmptyPlan('t');
  const [f1, f2] = plan.floors;
  f1.rooms.push(rect('a', 'yoshitsu', 0, 0, 5460, 5460));
  f1.stairs = [stair(5915, 1365)];
  f2.rooms.push(rect('b', 'yoshitsu', 0, 0, 7280, 5460));
  for (const f of [f1, f2]) M.rebuildFloorWalls(f, plan);
  const ending = M.stairsEndingOnFloor(plan, f2);
  assert.equal(ending.length, 1);
  assert.deepEqual(M.stairExteriorWallSpans(ending[0], f2), []);
});

test('読み込み時: 旧データで外壁に開いた自動間口を取り除く', () => {
  const { plan, floor } = floorWith(
    [rect('R', 'yoshitsu', 0, 0, 3640, 2730), rect('H', 'rouka', 0, 2730, 3640, 4550)],
    [stair(1820, 1365)],
  );
  const north = floor.walls.find((w) => w.roomId === 'R' && w.start.z === 0 && w.end.z === 0);
  floor.openings.push({
    id: 'legacy', type: 'maguchi', wallId: north.id, wallEdgeKey: M.wallEdgeKeyFromWall(north),
    offsetMM: 1820, widthMM: 910, sillMM: 0, heightMM: 2400, autoStairId: 's1',
  });
  const out = M.normalizePlan(JSON.parse(JSON.stringify(plan)));
  const f = out.floors[0];
  assert.ok(!f.openings.some((op) => op.id === 'legacy'));
  assert.ok(autoOps(f).length > 0, '室内側の自動間口は残る');
});
