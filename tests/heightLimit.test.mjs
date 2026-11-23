// heightLimit.js（北側斜線・高度地区）の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../js/heightLimit.js';
import { rotatePointAbout } from '../js/siteOrientation.js';
import { normalizePlan, createEmptyPlan } from '../js/model.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

/** 徳丸6丁目の想定: 第一種中高層 + 17m 第二種高度地区（板橋区） */
const TOKUMARU = { zoneId: 'chuko1', district: { city: 'itabashi', kind: 'type2', maxHeightMM: 17000 } };

/** 10m × 10m の正方形（上の辺 = 辺 0 が北） */
const SQUARE = [{ x: 0, z: 0 }, { x: 10000, z: 0 }, { x: 10000, z: 10000 }, { x: 0, z: 10000 }];

test('手計算ケース: 17m 第二種高度地区、北側が隣地', () => {
  const rules = H.resolveRules(TOKUMARU);
  const cases = [[1000, 6250], [3000, 8750], [3600, 9500], [8000, 15000], [10000, 16200], [12000, 17000], [20000, 17000]];
  for (const [d, h] of cases) near(H.limitAtMM(rules, d), h);
});

test('第一種中高層: 北側斜線（10 + 1.25d）と高度地区の低いほうを採る', () => {
  // 高度地区なし → 北側斜線だけ
  near(H.limitAtMM(H.resolveRules({ zoneId: 'chuko1' }), 2000), 12500);
  // 第 1 種（5 + 0.6d）のほうが低い
  const r = H.resolveRules({ zoneId: 'chuko1', district: { kind: 'type1', maxHeightMM: null } });
  near(H.limitAtMM(r, 10000), 11000);
  // d = 0 でも 5m（第 1 種）と 10m（北側斜線）で、常に第 1 種が低い
  near(H.limitAtMM(r, 0), 5000);
});

test('日影規制の対象区域では中高層の北側斜線が外れる', () => {
  const r = H.resolveRules({ zoneId: 'chuko2', shadowRegulated: true });
  assert.equal(r.north, null);
  assert.equal(H.limitAtMM(r, 1000), Infinity);
  // 高度地区は残る
  near(H.limitAtMM(H.resolveRules({ ...TOKUMARU, shadowRegulated: true }), 1000), 6250);
  // 低層系には日影規制のチェックは効かない
  assert.notEqual(H.resolveRules({ zoneId: 'tei1', shadowRegulated: true }).north, null);
});

test('低層系: 5 + 1.25d と絶対高さ 10m / 12m', () => {
  const r10 = H.resolveRules({ zoneId: 'tei1' });
  near(H.limitAtMM(r10, 2000), 7500);
  near(H.limitAtMM(r10, 10000), 10000);
  const r12 = H.resolveRules({ zoneId: 'denen', lowRiseAbsMaxMM: 12000 });
  near(H.limitAtMM(r12, 10000), 12000);
});

test('北側斜線のない用途地域は高度地区だけで決まる', () => {
  assert.equal(H.limitAtMM(H.resolveRules({ zoneId: 'other' }), 0), Infinity);
  near(H.limitAtMM(H.resolveRules({ ...TOKUMARU, zoneId: 'other' }), 3000), 8750);
});

test('高度地区: 第 2 種・第 3 種は d = 8m の前後で連続する', () => {
  for (const kind of ['type2', 'type3']) {
    const r = H.resolveRules({ zoneId: 'other', district: { kind, maxHeightMM: kind === 'type3' ? 45000 : null } });
    near(H.limitAtMM(r, 7999.999), H.limitAtMM(r, 8000.001), 0.01);
  }
  near(H.limitAtMM(H.resolveRules({ zoneId: 'other', district: { kind: 'type3', maxHeightMM: 45000 } }), 2000), 12500);
});

test('高度地区: 「なし」は絶対高さだけ、「自分で入力」は segments を使う', () => {
  const none = H.resolveRules({ zoneId: 'other', district: { kind: 'none', maxHeightMM: 20000 } });
  near(H.limitAtMM(none, 0), 20000);
  const custom = H.resolveRules({
    zoneId: 'other',
    district: { kind: 'custom', custom: [{ fromMM: 0, baseMM: 7000, slope: 1 }, { fromMM: 5000, baseMM: 12000, slope: 0.5 }] },
  });
  near(H.limitAtMM(custom, 2000), 9000);
  near(H.limitAtMM(custom, 7000), 13000);
  // 不正な custom は「なし」に戻る
  const bad = H.normalizeHeightLimit({ district: { kind: 'custom', custom: [{ fromMM: 1000, baseMM: 5000, slope: 1 }] } });
  assert.equal(bad.district.kind, 'none');
});

test('逆関数: minDistanceForHeightMM(limitAtMM(d)) が d に戻る', () => {
  const rules = H.resolveRules(TOKUMARU);
  for (const d of [0, 1000, 3000, 3600, 8000, 10000]) {
    near(H.minDistanceForHeightMM(rules, H.limitAtMM(rules, d)), d, 1e-6);
  }
  // 絶対高さ 17m で頭打ちになる所: 15 + 0.6(d - 8) = 17 → d = 11.333m
  near(H.minDistanceForHeightMM(rules, 17000), 8000 + 2000 / 0.6, 1e-6);
  assert.equal(H.minDistanceForHeightMM(rules, 17500), Infinity);
  // 立ち上がり 5m 以下はどこでも置ける
  assert.equal(H.minDistanceForHeightMM(rules, 4000), 0);
  // 制限なし
  assert.equal(H.minDistanceForHeightMM(H.resolveRules({ zoneId: 'other' }), 30000), 0);
});

test('northDir: 上 = 北が azimuth 0、時計回り', () => {
  const n0 = H.northDir(0); near(n0.x, 0); near(n0.z, -1);
  const n90 = H.northDir(90); near(n90.x, 1); near(n90.z, 0);
  const n180 = H.northDir(180); near(n180.x, 0); near(n180.z, 1);
});

test('northDistanceMM: 真北方向の距離（方位 0 / 45 度）', () => {
  near(H.northDistanceMM({ x: 5000, z: 3000 }, SQUARE, 0).dMM, 3000);
  assert.equal(H.northDistanceMM({ x: 5000, z: 3000 }, SQUARE, 0).edgeIndex, 0);
  near(H.northDistanceMM({ x: 5000, z: 3000 }, SQUARE, 180).dMM, 7000);
  // 45 度: 中心から右上の角へ
  near(H.northDistanceMM({ x: 5000, z: 5000 }, SQUARE, 45).dMM, 5000 * Math.SQRT2, 1e-6);
});

test('northDistanceMM: 敷地と方位を一緒に回しても同じ点の d は変わらない', () => {
  const pt = { x: 3000, z: 2500 };
  const base = H.northDistanceMM(pt, SQUARE, 0).dMM;
  for (const deg of [30, 90, 180, 245]) {
    const pivot = { x: 5000, z: 5000 };
    const poly = SQUARE.map((p) => rotatePointAbout(p, pivot, deg));
    const p2 = rotatePointAbout(pt, pivot, deg);
    near(H.northDistanceMM(p2, poly, deg).dMM, base, 1e-6);
  }
});

test('northDistanceMM: 北側が道路なら幅員を足す（斜めなら真北方向に直す）', () => {
  const road = { edgeIndex: 0, widthMM: 4000 };
  near(H.northDistanceMM({ x: 5000, z: 3000 }, SQUARE, 0, road).dMM, 7000);
  const cos30 = Math.cos(Math.PI / 6);
  near(H.northDistanceMM({ x: 5000, z: 3000 }, SQUARE, 30, road).dMM, 7000 / cos30, 1e-6);
  // 道路でない辺は隣地として扱う
  near(H.northDistanceMM({ x: 5000, z: 3000 }, SQUARE, 0, { edgeIndex: 2, widthMM: 4000 }).dMM, 3000);
  // makeContext は plan.site.road から幅員と辺を取り出す
  const ctx = H.makeContext({ boundary: SQUARE, azimuth: 0, road: { edgeIndex: 0, widthMM: 4000, guardrails: [] } }, TOKUMARU);
  near(H.heightLimitAtPoint({ x: 5000, z: 3000 }, ctx).dMM, 7000);
});

test('northDistanceMM: 凹形の敷地では最初に当たる境界を使い、敷地の外は null', () => {
  // 上の辺に切り欠きがある敷地
  const notch = [
    { x: 0, z: 0 }, { x: 4000, z: 0 }, { x: 4000, z: 3000 }, { x: 6000, z: 3000 },
    { x: 6000, z: 0 }, { x: 10000, z: 0 }, { x: 10000, z: 10000 }, { x: 0, z: 10000 },
  ];
  near(H.northDistanceMM({ x: 5000, z: 8000 }, notch, 0).dMM, 5000);
  near(H.northDistanceMM({ x: 2000, z: 8000 }, notch, 0).dMM, 8000);
  assert.equal(H.northDistanceMM({ x: 5000, z: 1000 }, notch, 0), null);
  assert.equal(H.northDistanceMM({ x: -1, z: 5000 }, SQUARE, 0), null);
});

test('floorTopMM: GL → 1FL と階高の合計（足りない階は最後の値）', () => {
  near(H.floorTopMM(H.DEFAULT_BUILD.low, 2), 8350);
  near(H.floorTopMM(H.DEFAULT_BUILD.standard, 2), 9300);
  near(H.floorTopMM({ groundToFirstFloorMM: 500, storyHeightsMM: [3000] }, 2), 9500);
});

test('floorClearances: 仮の値・余白 0 で低めと標準の必要距離', () => {
  const plan = createEmptyPlan('t');
  const res = H.floorClearances(plan, TOKUMARU);
  assert.deepEqual(res.map((r) => r.level), [0, 1, 2]);
  const [f1, f2, f3] = res;
  near(f3.low.topMM, 8350); near(f3.low.minDistanceMM, 2680, 1e-6);
  near(f3.standard.topMM, 9300); near(f3.standard.minDistanceMM, 3440, 1e-6);
  near(f2.low.minDistanceMM, 560, 1e-6); near(f2.standard.minDistanceMM, 1120, 1e-6);
  assert.equal(f1.low.minDistanceMM, 0); assert.equal(f1.standard.minDistanceMM, 0);
  // 低めの必要距離は標準以下（赤は黄の内側）
  for (const r of res) assert.ok(r.low.minDistanceMM <= r.standard.minDistanceMM);
  // 余白を足すと必要距離が伸びる
  const withMargin = H.floorClearances(plan, { ...TOKUMARU, marginMM: 300 });
  near(withMargin[2].standard.checkMM, 9600);
  near(withMargin[2].standard.minDistanceMM, 3680, 1e-6);
});

test('floorClearances: 北側道路があれば、敷地の北端からの距離は道路の分を引く', () => {
  const plan = createEmptyPlan('road');
  plan.site.boundary = SQUARE;
  // 幅員 5.9m の北側道路: 3F（標準 3.44m）も含めて敷地の北端から制限なし
  plan.site.road = { edgeIndex: 0, widthMM: 5900 };
  let [, , f3] = H.floorClearances(plan, TOKUMARU);
  near(f3.standard.minDistanceMM, 3440, 1e-6); // 斜線の起点（道路の反対側）からの距離は変わらない
  assert.equal(f3.standard.fromSiteMM, 0);
  assert.equal(f3.low.fromSiteMM, 0);
  // 幅員 2m: 3F は 1.44m / 0.68m
  plan.site.road = { edgeIndex: 0, widthMM: 2000 };
  [, , f3] = H.floorClearances(plan, TOKUMARU);
  near(f3.standard.fromSiteMM, 1440, 1e-6);
  near(f3.low.fromSiteMM, 680, 1e-6);
  // 方位 30°: 道路の幅は真北方向に 2000 ÷ cos30° として引く
  plan.site.azimuth = 30;
  [, , f3] = H.floorClearances(plan, TOKUMARU);
  near(f3.standard.fromSiteMM, 3440 - 2000 / Math.cos(Math.PI / 6), 1e-6);
  // 南側の道路は引かない
  plan.site.azimuth = 0;
  plan.site.road = { edgeIndex: 2, widthMM: 5900 };
  [, , f3] = H.floorClearances(plan, TOKUMARU);
  near(f3.standard.fromSiteMM, 3440, 1e-6);
  // 道路がなければ minDistanceMM と同じ
  plan.site.road = null;
  [, , f3] = H.floorClearances(plan, TOKUMARU);
  near(f3.standard.fromSiteMM, f3.standard.minDistanceMM, 1e-9);
});

test('northRoadOffset: 真北から 60° 以内に向いた道路だけを北側道路とみなす', () => {
  const site = { boundary: SQUARE, azimuth: 0, road: { edgeIndex: 0, widthMM: 4000 } };
  near(H.northRoadOffset(site).offsetMM, 4000);
  near(H.northRoadOffset({ ...site, azimuth: 180, road: { edgeIndex: 2, widthMM: 4000 } }).offsetMM, 4000);
  near(H.northRoadOffset({ ...site, azimuth: 59 }).offsetMM, 4000 / Math.cos(59 * Math.PI / 180), 1e-6);
  assert.equal(H.northRoadOffset({ ...site, azimuth: 61 }), null);
  assert.equal(H.northRoadOffset({ ...site, road: { edgeIndex: 1, widthMM: 4000 } }), null);
  assert.equal(H.northRoadOffset({ ...site, road: null }), null);
});

test('forbiddenRuns: 塗る面積が解析解と 1 格子分の誤差で合い、赤は黄の内側', () => {
  const ctx = H.makeContext({ boundary: SQUARE, azimuth: 0 }, TOKUMARU);
  const step = 100;
  const area = (runs) => runs.reduce((s, r) => s + (r.x1 - r.x0) * r.stepMM, 0);
  const yellow = H.forbiddenRuns(ctx, 9300, step);
  const red = H.forbiddenRuns(ctx, 8350, step);
  assert.ok(Math.abs(area(yellow) - 10000 * 3440) <= 10000 * step);
  assert.ok(Math.abs(area(red) - 10000 * 2680) <= 10000 * step);
  assert.ok(area(red) < area(yellow));
  const yellowRows = new Set(yellow.map((r) => r.z));
  for (const r of red) assert.ok(yellowRows.has(r.z));
  // 高さ 5m 未満は塗らない
  assert.equal(H.forbiddenRuns(ctx, 4000, step).length, 0);
});

test('contourSegments: 境目の線は上限 = h の位置（1 格子以内）', () => {
  const ctx = H.makeContext({ boundary: SQUARE, azimuth: 0 }, TOKUMARU);
  const segs = H.contourSegments(ctx, 9300, 100);
  assert.ok(segs.length > 0);
  for (const seg of segs) for (const p of seg) assert.ok(Math.abs(p.z - 3440) <= 100, `z=${p.z}`);
});

test('normalizeHeightLimit: 旧データは無効の初期値、範囲外は既定値', () => {
  const d = H.normalizeHeightLimit(undefined);
  assert.equal(d.enabled, false);
  assert.equal(d.zoneId, 'chuko1');
  assert.equal(d.district.city, 'itabashi');
  assert.equal(d.district.kind, 'none');
  assert.equal(d.marginMM, 0);
  assert.deepEqual(d.build, H.DEFAULT_BUILD);
  assert.equal(d.show.contour2d, true);

  const n = H.normalizeHeightLimit({
    enabled: true, zoneId: 'xxx', lowRiseAbsMaxMM: 11000,
    district: { city: 'nowhere', kind: 'type2', maxHeightMM: 99999 },
    build: { low: { groundToFirstFloorMM: -5, storyHeightsMM: [100, 'a', 2700] } },
    marginMM: 99999,
  });
  assert.equal(n.enabled, true);
  assert.equal(n.zoneId, 'chuko1');
  assert.equal(n.lowRiseAbsMaxMM, 10000);
  assert.equal(n.district.city, 'itabashi');
  assert.equal(n.district.maxHeightMM, null); // 第 2 種の選択肢にない値 → 先頭（なし）
  assert.equal(n.build.low.groundToFirstFloorMM, 0);
  assert.deepEqual(n.build.low.storyHeightsMM, [H.MIN_STORY_HEIGHT_MM, 2650, 2700]);
  assert.deepEqual(n.build.standard, H.DEFAULT_BUILD.standard);
  assert.equal(n.marginMM, H.MAX_MARGIN_MM);
  // 既定値のオブジェクトを書き換えても DEFAULT_BUILD は変わらない
  d.build.low.storyHeightsMM[0] = 1;
  assert.equal(H.DEFAULT_BUILD.low.storyHeightsMM[0], 2650);
});

test('normalizePlan: heightLimit のない旧プランも壊れずに無効で読み込む', () => {
  const old = createEmptyPlan('old');
  delete old.site.heightLimit;
  const out = normalizePlan(JSON.parse(JSON.stringify(old)));
  assert.equal(out.site.heightLimit.enabled, false);
  assert.deepEqual(out.site.heightLimit.build, H.DEFAULT_BUILD);
  // 保存した設定は保たれる
  const saved = createEmptyPlan('saved');
  saved.site.heightLimit = { ...TOKUMARU, enabled: true, marginMM: 200 };
  const back = normalizePlan(JSON.parse(JSON.stringify(saved)));
  assert.equal(back.site.heightLimit.enabled, true);
  assert.equal(back.site.heightLimit.district.kind, 'type2');
  assert.equal(back.site.heightLimit.district.maxHeightMM, 17000);
  assert.equal(back.site.heightLimit.marginMM, 200);
});
