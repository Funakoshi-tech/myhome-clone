// バルコニーの手すり壁（屋外側 1500mm）と、壁の描画用合成（wallsToRender）の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';

const rect = (id, type, x1, z1, x2, z2) => ({ id, type, name: id, polygon: M.rectPolygon(x1, z1, x2, z2), labelVisible: true });

/** 居室 R（0..7280 × 0..5460）の南側に、深さ 910 のバルコニー B を付けた 1 フロア */
function planWithBalcony({ balconyFirst = false } = {}) {
  const plan = M.createEmptyPlan('t');
  const floor = plan.floors[1];
  const room = rect('R', 'yoshitsu', 0, 0, 7280, 5460);
  const balcony = rect('B', 'balcony', 0, 5460, 7280, 6370);
  floor.rooms.push(...(balconyFirst ? [balcony, room] : [room, balcony]));
  M.rebuildFloorWalls(floor, plan);
  return { plan, floor };
}

const heightOf = (floor, id) => floor.walls.find((w) => w.id === id).heightMM;

test('バルコニーの屋外側の 3 辺は手すり壁の高さ、居室と共有する辺と居室の壁は天井高', () => {
  const { floor } = planWithBalcony();
  const ceiling = floor.ceilingHeightMM;
  assert.equal(M.BALCONY_PARAPET_MM, 1500);
  // B の辺: 0=北（居室と共有）, 1=東, 2=南, 3=西
  assert.equal(heightOf(floor, 'w_B_0'), ceiling);
  for (const i of [1, 2, 3]) assert.equal(heightOf(floor, `w_B_${i}`), 1500);
  for (let i = 0; i < 4; i++) assert.equal(heightOf(floor, `w_R_${i}`), ceiling);
});

test('部屋の並び順に依存しない（バルコニーが先に描かれていても同じ結果）', () => {
  const { floor } = planWithBalcony({ balconyFirst: true });
  assert.equal(heightOf(floor, 'w_B_0'), floor.ceilingHeightMM);
  for (const i of [1, 2, 3]) assert.equal(heightOf(floor, `w_B_${i}`), 1500);
});

test('天井高が手すり壁より低いときは天井高を超えない', () => {
  const { plan, floor } = planWithBalcony();
  floor.ceilingHeightMM = 1200;
  M.rebuildFloorWalls(floor, plan);
  for (const w of floor.walls) assert.equal(w.heightMM, 1200);
});

test('壁を再生成しても高さが保たれ、居室を消すとバルコニーの共有辺も手すり壁になる', () => {
  const { plan, floor } = planWithBalcony();
  M.rebuildFloorWalls(floor, plan);
  assert.equal(heightOf(floor, 'w_B_0'), floor.ceilingHeightMM);
  floor.rooms = floor.rooms.filter((r) => r.id !== 'R');
  M.rebuildFloorWalls(floor, plan);
  for (let i = 0; i < 4; i++) assert.equal(heightOf(floor, `w_B_${i}`), 1500);
});

test('保存済みプランの読み込み（normalizePlan）で古い壁の高さも更新される', () => {
  const { plan, floor } = planWithBalcony();
  for (const w of floor.walls) w.heightMM = floor.ceilingHeightMM; // 旧データ: 全周が天井高
  const loaded = M.normalizePlan(JSON.parse(JSON.stringify(plan)));
  const f = loaded.floors[1];
  for (const i of [1, 2, 3]) assert.equal(f.walls.find((w) => w.id === `w_B_${i}`).heightMM, 1500);
  assert.equal(f.walls.find((w) => w.id === 'w_B_0').heightMM, f.ceilingHeightMM);
});

test('wallsToRender: 同一直線上でも高さが違う壁は合成せず、居室の壁は居室の壁のまま', () => {
  const { floor } = planWithBalcony();
  const render = M.wallsToRender(floor);
  // 西側の直線 x=0: 居室の壁（天井高, z 0..5460）とバルコニーの手すり壁（1500, z 5460..6370）は別々
  const west = render.filter(({ wall }) => wall.start.x === 0 && wall.end.x === 0);
  assert.equal(west.length, 2);
  const tall = west.find(({ wall }) => wall.heightMM === floor.ceilingHeightMM);
  const low = west.find(({ wall }) => wall.heightMM === 1500);
  assert.ok(tall && low);
  assert.equal(M.inferWallRoomId(tall.wall), 'R');
  assert.equal(M.inferWallRoomId(low.wall), 'B');
});

test('wallsToRender: 居室とバルコニーの共有壁は 1 本に合成され、部屋は居室が優先される', () => {
  for (const balconyFirst of [false, true]) {
    const { floor } = planWithBalcony({ balconyFirst });
    const render = M.wallsToRender(floor);
    const shared = render.filter(({ wall }) =>
      wall.start.z === 5460 && wall.end.z === 5460 && wall.heightMM === floor.ceilingHeightMM);
    assert.equal(shared.length, 1, `balconyFirst=${balconyFirst}`);
    assert.equal(M.inferWallRoomId(shared[0].wall), 'R', `balconyFirst=${balconyFirst}`);
  }
});

// ---- バルコニーごとの手すり壁の高さ（room.parapetHeightMM） ----

test('手すり壁の高さは部屋ごとに指定でき、未指定は既定値（1500）', () => {
  const ceiling = 2400;
  assert.equal(M.balconyParapetMM({}, ceiling), 1500);
  assert.equal(M.balconyParapetMM(undefined, ceiling), 1500);
  assert.equal(M.balconyParapetMM({ parapetHeightMM: 1100 }, ceiling), 1100);
  assert.equal(M.balconyParapetMM({ parapetHeightMM: '1200' }, ceiling), 1200); // 文字列でも数値に
});

test('手すり壁の高さは 300mm 〜 天井高に収まり、不正な値は既定値になる', () => {
  const ceiling = 2400;
  assert.equal(M.balconyParapetMM({ parapetHeightMM: 50 }, ceiling), M.MIN_BALCONY_PARAPET_MM);
  assert.equal(M.balconyParapetMM({ parapetHeightMM: 9999 }, ceiling), ceiling);
  for (const bad of [0, -100, NaN, 'abc', null]) {
    assert.equal(M.balconyParapetMM({ parapetHeightMM: bad }, ceiling), 1500, String(bad));
  }
});

test('壁の高さに反映され、変えた部屋だけが変わる（居室と共有する辺は天井高のまま）', () => {
  const plan = M.createEmptyPlan('t');
  const floor = plan.floors[1];
  floor.rooms.push(
    rect('R', 'yoshitsu', 0, 0, 7280, 5460),
    rect('B1', 'balcony', 0, 5460, 3640, 6370),
    rect('B2', 'balcony', 3640, 5460, 7280, 6370),
  );
  floor.rooms.find((r) => r.id === 'B1').parapetHeightMM = 1100;
  M.rebuildFloorWalls(floor, plan);
  // B1: 共有辺（北）は天井高、屋外側の 3 辺は 1100。B2 は既定の 1500。
  assert.equal(heightOf(floor, 'w_B1_0'), floor.ceilingHeightMM);
  for (const i of [1, 2, 3]) assert.equal(heightOf(floor, `w_B1_${i}`), 1100);
  for (const i of [1, 2, 3]) assert.equal(heightOf(floor, `w_B2_${i}`), 1500);
});

test('保存済みプラン（room.parapetHeightMM 付き）の読み込みで指定が保たれる', () => {
  const { plan, floor } = planWithBalcony();
  floor.rooms.find((r) => r.id === 'B').parapetHeightMM = 1000;
  M.rebuildFloorWalls(floor, plan);
  const loaded = M.normalizePlan(JSON.parse(JSON.stringify(plan)));
  const f = loaded.floors[1];
  for (const i of [1, 2, 3]) assert.equal(f.walls.find((w) => w.id === `w_B_${i}`).heightMM, 1000);
});

test('居室の壁の一部にだけ接するバルコニー（2 つ並び）でも、居室側の辺は天井高・屋外側は手すり壁', () => {
  const plan = M.createEmptyPlan('t');
  const floor = plan.floors[1];
  floor.rooms.push(
    rect('R', 'yoshitsu', 0, 0, 7280, 5460),
    rect('B1', 'balcony', 0, 5460, 3640, 6370),
    rect('B2', 'balcony', 3640, 5460, 7280, 6370),
  );
  M.rebuildFloorWalls(floor, plan);
  for (const id of ['B1', 'B2']) {
    assert.equal(heightOf(floor, `w_${id}_0`), floor.ceilingHeightMM, `${id} の居室側の辺`);
    for (const i of [1, 2, 3]) assert.equal(heightOf(floor, `w_${id}_${i}`), 1500, `${id} の辺${i}`);
  }
});

test('斜めの辺や、居室の壁と平行でない壁を「共有」と誤認しない', () => {
  const plan = M.createEmptyPlan('t');
  const floor = plan.floors[1];
  // 居室の角に、辺の中点だけが居室の壁の端に触れる位置でバルコニーを置く（共有ではない）
  floor.rooms.push(rect('R', 'yoshitsu', 0, 0, 3640, 3640), rect('B', 'balcony', 3640, 3640, 5460, 4550));
  M.rebuildFloorWalls(floor, plan);
  for (let i = 0; i < 4; i++) assert.equal(heightOf(floor, `w_B_${i}`), 1500, `辺${i}`);
});
