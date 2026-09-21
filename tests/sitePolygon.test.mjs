// sitePolygon.js（敷地の純粋幾何）の単体テスト。実行: npm test（Node 標準の node:test。追加依存なし）

import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/sitePolygon.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const rect = [{ x: 0, z: 0 }, { x: 12000, z: 0 }, { x: 12000, z: 15000 }, { x: 0, z: 15000 }];
const lShape = [
  { x: 0, z: 0 }, { x: 2000, z: 0 }, { x: 2000, z: 1000 },
  { x: 1000, z: 1000 }, { x: 1000, z: 2000 }, { x: 0, z: 2000 },
];

test('辺の長さ・周長・面積ラベル', () => {
  assert.deepEqual(S.edgeLengths(rect), [12000, 15000, 12000, 15000]);
  near(S.perimeterM(rect), 54);
  assert.equal(S.siteAreaLabel(rect), '180.00㎡（54.4坪）');
});

test('内角: 長方形は 90°、L 字の凹角は 270°（回り方向に依存しない）', () => {
  for (const poly of [rect, [...rect].reverse()]) {
    for (let i = 0; i < 4; i++) near(S.interiorAngleDeg(poly, i), 90);
  }
  near(S.interiorAngleDeg(lShape, 3), 270);
  for (const i of [0, 1, 2, 4, 5]) near(S.interiorAngleDeg(lShape, i), 90);
  near(S.interiorAngleDeg([...lShape].reverse(), 2), 270);
});

test('setEdgeLength: 終点が辺に沿って動く。元の配列は変更しない', () => {
  const before = JSON.stringify(rect);
  const r = S.setEdgeLength(rect, 0, 12345);
  assert.equal(JSON.stringify(rect), before);
  assert.deepEqual(r[1], { x: 12345, z: 0 });
  assert.deepEqual(r[0], rect[0]);
  assert.deepEqual(r[2], rect[2]);
});

test('setEdgeLength: 最終辺は始点側（頂点 0）が動く', () => {
  const r = S.setEdgeLength(rect, 3, 14000);
  assert.deepEqual(r[0], { x: 0, z: 1000 });
  near(S.edgeLengthMM(r, 3), 14000, 1);
});

test('setEdgeLength: 下限あり・斜めの辺でも指定した長さになる', () => {
  near(S.edgeLengthMM(S.setEdgeLength(rect, 0, 5), 0), S.MIN_SITE_EDGE_MM);
  const tri = [{ x: 0, z: 0 }, { x: 3000, z: 4000 }, { x: 0, z: 4000 }];
  near(S.edgeLengthMM(S.setEdgeLength(tri, 0, 10000), 0), 10000, 1);
});

test('頂点の挿入は辺上（1mm 丸め）、削除は 3 頂点まで', () => {
  const ins = S.insertVertex(rect, 0, { x: 5003, z: 800 });
  assert.equal(ins.length, 5);
  assert.deepEqual(ins[1], { x: 5003, z: 0 });
  near(S.interiorAngleDeg(ins, 1), 180);
  assert.equal(S.removeVertex(ins, 1).length, 4);
  const tri = S.removeVertex(rect, 1);
  assert.equal(tri.length, 3);
  assert.equal(S.removeVertex(tri, 1).length, 3);
});

test('自己交差の検出', () => {
  assert.equal(S.hasSelfIntersection(rect), false);
  assert.equal(S.hasSelfIntersection(lShape), false);
  assert.equal(S.hasSelfIntersection([{ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 }]), true);
});

test('スナップと角度拘束（射影）', () => {
  assert.deepEqual(S.snapToMM({ x: 1234, z: -1236 }), { x: 1230, z: -1240 });
  assert.deepEqual(S.constrainAngle({ x: 0, z: 0 }, { x: 1000, z: 130 }), { x: 1000, z: 0 });
  const d = S.constrainAngle({ x: 0, z: 0 }, { x: 1000, z: 900 });
  near(d.x, d.z, S.SITE_SNAP_MM);
});

test('isValidSite / cloneBoundary', () => {
  assert.equal(S.isValidSite(rect), true);
  assert.equal(S.isValidSite(rect.slice(0, 2)), false);
  assert.equal(S.isValidSite(undefined), false);
  const c = S.cloneBoundary([{ x: 1, z: 2, userAdded: true }]);
  assert.deepEqual(c, [{ x: 1, z: 2 }]);
});
