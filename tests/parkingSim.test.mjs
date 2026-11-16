// parkingSim.js（駐車シミュレーターの純粋幾何）の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/parkingSim.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const GLB = P.getVehiclePreset('glb2020');

// 間口 6000、奥行 15000 の長方形。上辺（z=0）が道路（道路は z<0 側）
const site = [{ x: 0, z: 0 }, { x: 6000, z: 0 }, { x: 6000, z: 15000 }, { x: 0, z: 15000 }];

test('後輪車軸の最小半径はカタログの最小回転半径より小さい', () => {
  const r = P.rearAxleMinRadiusMM(GLB);
  assert.ok(r < GLB.minTurnRadiusMM);
  near(r, Math.sqrt(5500 ** 2 - 2830 ** 2) - 1605 / 2, 1e-9);
});

test('stepPose: 直進と、半径 R で 90° 回る円弧', () => {
  const p = P.stepPose({ x: 0, z: 0, th: 0 }, 0, 1000);
  near(p.x, 1000); near(p.z, 0);
  const R = 4000;
  const q = P.stepPose({ x: 0, z: 0, th: 0 }, 1 / R, (Math.PI / 2) * R);
  near(q.x, R, 1e-6); near(q.z, R, 1e-6); near(q.th, Math.PI / 2);
  // 後退は前進の逆
  const back = P.stepPose(q, 1 / R, -(Math.PI / 2) * R);
  near(back.x, 0, 1e-6); near(back.z, 0, 1e-6); near(back.th, 0);
});

test('carCorners: 全長・全幅どおりの長方形', () => {
  const c = P.carCorners({ x: 0, z: 0, th: 0 }, GLB);
  near(Math.hypot(c[0].x - c[3].x, c[0].z - c[3].z), GLB.lengthMM);
  near(Math.hypot(c[0].x - c[1].x, c[0].z - c[1].z), GLB.widthMM);
  near(c[0].x, GLB.wheelbaseMM + GLB.frontOverhangMM);
  near(c[3].x, -GLB.rearOverhangMM);
});

test('segmentClosest: 交差は 0、平行は間隔', () => {
  near(P.segmentClosest({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: -5 }, { x: 5, z: 5 }).d, 0);
  near(P.segmentClosest({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 3 }, { x: 10, z: 3 }).d, 3);
});

test('roadGeometry: 道路側の法線は敷地の外を向く', () => {
  const g = P.roadGeometry(site, 0, 8000);
  near(g.out.x, 0); near(g.out.z, -1);
  near(g.farStart.z, -8000);
  const l = g.toLocal({ x: 2000, z: -3000 });
  near(l.s, 2000); near(l.n, 3000);
});

test('carClearance: 道路の中の車は向かい側までの距離、はみ出すと 0', () => {
  const geo = P.roadGeometry(site, 0, 8000);
  const obs = P.buildObstacles({ boundary: site, geo, roadEdgeIndex: 0 });
  // 道路に沿って走る車（中心が境界から 3000）
  const pose = { x: 3000, z: -3000, th: 0 }; // 前端が間口の外（隣地の道路沿い）に出る位置
  const cl = P.carClearance(P.carCorners(pose, GLB), obs);
  near(cl.d, Math.min(3000 - GLB.widthMM / 2, 8000 - 3000 - GLB.widthMM / 2), 1e-6);
  const out = P.carClearance(P.carCorners({ x: 1000, z: -7500, th: 0 }, GLB), obs);
  assert.equal(out.d, 0);
});

test('前面道路の辺そのものは障害物にしない（敷地へ入れる）', () => {
  const geo = P.roadGeometry(site, 0, 8000);
  const obs = P.buildObstacles({ boundary: site, geo, roadEdgeIndex: 0 });
  // 敷地の中央に頭を道路へ向けて止めた車：境界をまたいでいても当たらない
  const pose = { x: 3000, z: 3000, th: -Math.PI / 2 };
  const cl = P.carClearance(P.carCorners(pose, GLB), obs);
  assert.ok(cl.d > 1000, `d=${cl.d}`);
});

test('driveWithCollision: 壁の手前で止まる', () => {
  const geo = P.roadGeometry(site, 0, 8000);
  const obs = P.buildObstacles({ boundary: site, geo, roadEdgeIndex: 0 });
  // 敷地の中を奥へバック（頭は道路向き）。奥の境界 z=15000 で止まる
  const start = { x: 3000, z: 2000, th: -Math.PI / 2 };
  const r = P.driveWithCollision(start, GLB, 0, -20000, obs);
  assert.ok(r.hit, 'ぶつかる');
  const last = r.poses[r.poses.length - 1];
  const rearZ = last.z + GLB.rearOverhangMM;
  assert.ok(rearZ < 15000 && rearZ > 15000 - P.SIM_STEP_MM - 1, `rearZ=${rearZ}`);
});

test('guardrailRelation: 間口の外は正、敷地の前にかかると負', () => {
  const geo = P.roadGeometry(site, 0, 8000);
  const outside = P.guardrailRelation({ a: { x: 7700, z: -1600 }, b: { x: 20000, z: -1600 } }, geo);
  near(outside.gapMM, 1700); assert.equal(outside.side, 'end'); near(outside.offsetMM, 1600);
  const over = P.guardrailRelation({ a: { x: 5500, z: -1600 }, b: { x: 20000, z: -1600 } }, geo);
  near(over.gapMM, -500);
  const west = P.guardrailRelation({ a: { x: -9000, z: -1600 }, b: { x: -1000, z: -1600 } }, geo);
  near(west.gapMM, 1000); assert.equal(west.side, 'start');
});

test('countDirectionChanges: 前進→後退は切り返しなし、その後の切り替えから数える', () => {
  assert.deepEqual(P.countDirectionChanges([1, 1, -1, -1]), { changes: 1, kirikaeshi: 0 });
  assert.deepEqual(P.countDirectionChanges([1, -1, 1, -1]), { changes: 3, kirikaeshi: 2 });
  assert.deepEqual(P.countDirectionChanges([]), { changes: 0, kirikaeshi: 0 });
});

test('normalizeRoad: 範囲外の辺は null、幅の既定値', () => {
  assert.equal(P.normalizeRoad({ edgeIndex: 9 }, site), null);
  const r = P.normalizeRoad({ edgeIndex: 0 }, site);
  assert.equal(r.widthMM, P.DEFAULT_ROAD_WIDTH_MM);
  assert.deepEqual(r.guardrails, []);
});
