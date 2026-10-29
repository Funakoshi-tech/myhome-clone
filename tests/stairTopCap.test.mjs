// 上がってきた階段の上（その階に部屋も階段も無い所）の天井・屋根（stairTopCapRooms）の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import * as R from '../js/roofModel.js';

const rect = (id, type, x1, z1, x2, z2) => ({ id, type, name: id, polygon: M.rectPolygon(x1, z1, x2, z2), labelVisible: true });
const stair = (x, z, extra = {}) => ({ id: 's1', type: 'straight', widthMM: 910, depthMM: 2730, x, z, rotationDeg: 0, ...extra });
const inRects = (rects, p) => rects.some((r) => p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1);

/** 1F・2F とも L 字（切り欠き x 5460..6370 / z 0..2730）。1F の切り欠きに階段、2F には階段なし */
function lPlan() {
  const plan = M.createEmptyPlan('t');
  const [f1, f2] = plan.floors;
  for (const f of [f1, f2]) {
    f.rooms.push(rect(`${f.id}a`, 'yoshitsu', 0, 0, 5460, 5460), rect(`${f.id}b`, 'yoshitsu', 5460, 2730, 7280, 5460));
  }
  f1.stairs = [stair(5915, 1365)];
  for (const f of [f1, f2]) M.rebuildFloorWalls(f, plan);
  return { plan, f1, f2 };
}

test('階段の上がった先に部屋も階段も無ければ、その階に天井・屋根用の仮の部屋ができる', () => {
  const { plan, f1, f2 } = lPlan();
  const caps = M.stairTopCapRooms(plan, f2);
  assert.equal(caps.length, 1);
  assert.ok(caps[0].stairCap);
  assert.deepEqual(caps[0].polygon, M.stairFootprintCorners(f1.stairs[0]));
  assert.deepEqual(M.stairTopCapRooms(plan, f1), [], '最下階には上がってくる階段が無い');
  // 仮の部屋は階のデータには入らない（面積・壁に影響しない）
  assert.equal(f2.rooms.length, 2);
});

test('最上階の寄棟: 階段の上も屋根の範囲に入る', () => {
  const { plan, f2 } = lPlan();
  const top = { x: 5915, z: 1365 };
  const without = R.computeRoofRegions(f2, null);
  assert.ok(!inRects(without.regions.flatMap((g) => g.rects), top), '従来は階段の上に屋根が無かった');
  const res = R.computeRoofRegions(M.floorWithStairCaps(plan, f2), null);
  assert.ok(res.supported);
  assert.ok(inRects(res.regions.flatMap((g) => g.rects), top));
});

test('上の階に部屋や階段があれば仮の部屋は作らない', () => {
  const { plan, f2 } = lPlan();
  f2.rooms.push(rect('hall', 'rouka', 5460, 0, 7280, 2730));
  assert.deepEqual(M.stairTopCapRooms(plan, f2), []);
  f2.rooms.pop();
  f2.stairs = [stair(5915, 1365, { id: 's2' })];
  assert.deepEqual(M.stairTopCapRooms(plan, f2), []);
});

test('下の階の寄棟は、上の階へ抜ける階段の上には掛けない', () => {
  // 1F の部屋の中に階段（x 0..910 / z 0..2730）。2F は階段の上を覆わない
  const plan = M.createEmptyPlan('t');
  const [f1, f2] = plan.floors;
  f1.rooms.push(rect('a', 'yoshitsu', 0, 0, 5460, 5460));
  f1.stairs = [stair(455, 1365)];
  f2.rooms.push(rect('b', 'yoshitsu', 910, 0, 5460, 5460));
  // 寄棟は部屋全体で作り、上の構造（upperRects）の部分をくり抜く。階段の上がくり抜く側に入ること
  const res = R.computeRoofRegions(f1, f2);
  assert.ok(inRects(res.upperRects, { x: 455, z: 1365 }));
  assert.ok(!inRects(res.upperRects, { x: 455, z: 4000 }), '階段の外は今までどおり屋根');
});
