// 屋根の設定と、寄棟の幾何（roofSettings.js / roofModel.js）の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/model.js';
import * as R from '../js/roofModel.js';
import * as S from '../js/roofSettings.js';

const rect = (id, type, x1, z1, x2, z2) => ({ id, type, name: id, polygon: M.rectPolygon(x1, z1, x2, z2), labelVisible: true });
const floorOf = (rooms, extra = {}) => ({ id: 'F', level: 0, ceilingHeightMM: 2400, rooms, stairs: [], ...extra });
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const T = 0.4; // 4 寸勾配

/** 疑似乱数（再現性のため固定シード） */
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

/** 直交する多角形の縁までの L∞ 距離（点は多角形の内側） */
function distInf(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const xa = Math.min(a.x, b.x), xb = Math.max(a.x, b.x);
    const za = Math.min(a.z, b.z), zb = Math.max(a.z, b.z);
    const dx = p.x < xa ? xa - p.x : p.x > xb ? p.x - xb : 0;
    const dz = p.z < za ? za - p.z : p.z > zb ? p.z - zb : 0;
    best = Math.min(best, Math.max(dx, dz));
  }
  return best;
}

// ---- 設定 ----

test('屋根設定: 既定値・範囲・不正値の正規化と勾配の換算', () => {
  assert.deepEqual(S.normalizeRoofSettings(undefined), S.DEFAULT_ROOF);
  assert.deepEqual(S.normalizeRoofSettings({ type: 'hip', pitchSun: 5, overhangMM: 600 }), { type: 'hip', pitchSun: 5, overhangMM: 600 });
  const bad = S.normalizeRoofSettings({ type: 'gable??', pitchSun: 99, overhangMM: -50 });
  assert.equal(bad.type, 'flat');
  assert.equal(bad.pitchSun, S.MAX_PITCH_SUN);
  assert.equal(bad.overhangMM, 0);
  assert.equal(S.normalizeRoofSettings({ pitchSun: 'x' }).pitchSun, S.DEFAULT_ROOF.pitchSun);
  assert.equal(S.normalizeRoofSettings({ pitchSun: 3.7 }).pitchSun, 3.5); // 0.5 寸刻み
  near(S.pitchTan(4), 0.4);
  near(S.pitchDeg(4), 21.8, 0.05);
});

// ---- 領域 ----

test('単純な長方形の部屋: 領域 1 つ・最大の長方形 1 つ・寄棟で覆える', () => {
  const res = R.computeRoofRegions(floorOf([rect('A', 'yoshitsu', 0, 0, 8000, 4000)]), null);
  assert.equal(res.supported, true);
  assert.equal(res.regions.length, 1);
  assert.ok(res.regions[0].visibleCells > 0);
  assert.deepEqual(res.regions[0].rects, [{ x0: 0, x1: 8000, z0: 0, z1: 4000 }]);
  assert.ok(res.hipRoomIds.has('A'));
});

test('バルコニー・吹抜け・ポーチは屋根領域に含めない', () => {
  const floor = floorOf([
    rect('A', 'yoshitsu', 0, 0, 8000, 4000),
    rect('B', 'balcony', 0, 4000, 8000, 5000),
    rect('P', 'porch', 8000, 0, 9000, 4000),
  ]);
  const res = R.computeRoofRegions(floor, null);
  assert.equal(res.regions.length, 1);
  assert.deepEqual(res.regions[0].rects, [{ x0: 0, x1: 8000, z0: 0, z1: 4000 }]);
});

test('L 字は最大の長方形 2 つに分かれる（1 つの領域）', () => {
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 10000, 4000), rect('B', 'yoshitsu', 0, 4000, 4000, 10000)]);
  const res = R.computeRoofRegions(floor, null);
  assert.equal(res.regions.length, 1);
  assert.equal(res.regions[0].rects.length, 2);
  assert.ok(res.hipRoomIds.has('A') && res.hipRoomIds.has('B'));
});

test('離れた 2 つの部屋は別々の領域', () => {
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 4000, 4000), rect('B', 'yoshitsu', 6000, 0, 10000, 4000)]);
  assert.equal(R.computeRoofRegions(floor, null).regions.length, 2);
});

test('上階に一部が覆われた部屋: 部屋全体の寄棟から上階の部分をくり抜き、覆われていない部分に屋根が付く', () => {
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 8000, 4000)]);
  const upper = floorOf([rect('U', 'yoshitsu', 0, 0, 8000, 2000)]);
  const roof = R.computeHipRoof(floor, upper, { pitchSun: 4, overhangMM: 0 });
  assert.ok(roof);
  assert.ok(roof.hipRoomIds.has('A'));
  // 部屋全体（8000 × 4000）の寄棟の棟は z = 2000。上階がある z < 2000 はくり抜かれ、z ≥ 2000 は屋根が残る
  assert.equal(R.roofHeightAt(roof.faces, 4000, 1000), null);
  near(R.roofHeightAt(roof.faces, 4000, 3000), 400); // 棟（800）から軒（0）へ下る途中
  near(R.roofHeightAt(roof.faces, 4000, 3900), 40);
});

test('階段状に重なった家: 各階の上が空いている部分に屋根が付き、上階が屋根を貫く', () => {
  // 1F（0..8000 × 0..6000）の上に 2F（0..8000 × 0..3000）。1F の南半分（z 3000..6000）は上が空き
  const f1 = floorOf([rect('A', 'yoshitsu', 0, 0, 8000, 6000)]);
  const f2 = floorOf([rect('B', 'yoshitsu', 0, 0, 8000, 3000)]);
  const roof1 = R.computeHipRoof(f1, f2, { pitchSun: 4, overhangMM: 450 });
  assert.ok(roof1);
  assert.equal(R.roofHeightAt(roof1.faces, 4000, 1500), null);   // 2F の下（くり抜き）
  assert.ok(R.roofHeightAt(roof1.faces, 4000, 4500) !== null);    // 上が空いた部分には屋根
  // 最上階（上階なし）は全体が屋根
  const roof2 = R.computeHipRoof(f2, null, { pitchSun: 4, overhangMM: 450 });
  assert.ok(R.roofHeightAt(roof2.faces, 4000, 1500) !== null);
});

test('上階が全面を覆う階には屋根が要らない。上階のバルコニーは構造とみなさない', () => {
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 8000, 4000)]);
  const covered = floorOf([rect('U', 'yoshitsu', 0, 0, 8000, 4000)]);
  assert.equal(R.computeHipRoof(floor, covered, { pitchSun: 4, overhangMM: 0 }), null);
  const roof = R.computeHipRoof(floor, floorOf([rect('U', 'balcony', 0, 0, 8000, 4000)]), { pitchSun: 4, overhangMM: 0 });
  assert.ok(roof);
  assert.ok(R.roofHeightAt(roof.faces, 4000, 2000) !== null);
});

test('斜めの壁を含む平面は対象外（従来の平らな屋根に任せる）', () => {
  const tri = { id: 'T', type: 'yoshitsu', name: 'T', labelVisible: true, polygon: [{ x: 0, z: 0 }, { x: 5000, z: 0 }, { x: 0, z: 5000 }] };
  const res = R.computeRoofRegions(floorOf([tri]), null);
  assert.equal(res.supported, false);
  assert.equal(R.computeHipRoof(floorOf([tri]), null, { pitchSun: 4, overhangMM: 450 }), null);
});

// ---- 屋根の形 ----

test('長方形の寄棟: 4 面（三角 2・台形 2）。棟の高さ = 勾配 × 短辺の半分、壁の位置は高さ 0', () => {
  const faces = R.buildHipRoofFaces([{ x0: 0, x1: 8000, z0: 0, z1: 4000 }], { pitchSun: 4, overhangMM: 0 });
  assert.equal(faces.length, 4);
  const counts = faces.map((f) => f.pts.length).sort();
  assert.deepEqual(counts, [3, 3, 4, 4]);
  near(R.roofHeightAt(faces, 4000, 2000), 800);   // 棟（長辺に沿う）
  near(R.roofHeightAt(faces, 2000, 2000), 800);   // 棟の端（短辺/2 = 2000 の位置）
  near(R.roofHeightAt(faces, 1000, 2000), 400);   // 隅棟の途中
  near(R.roofHeightAt(faces, 4000, 0), 0);        // 壁の位置
  near(R.roofHeightAt(faces, 4000, 1000), 400);   // 軒側の面
});

test('正方形は棟のない方形（4 つの三角形が 1 点に集まる）', () => {
  const faces = R.buildHipRoofFaces([{ x0: 0, x1: 4000, z0: 0, z1: 4000 }], { pitchSun: 4, overhangMM: 0 });
  assert.equal(faces.length, 4);
  assert.ok(faces.every((f) => f.pts.length === 3));
  near(R.roofHeightAt(faces, 2000, 2000), 800);
});

test('軒の出: 棟の高さは変わらず、軒先は壁の位置より勾配 × 軒の出だけ下がる。面積は拡げた長方形と一致', () => {
  const faces = R.buildHipRoofFaces([{ x0: 0, x1: 8000, z0: 0, z1: 4000 }], { pitchSun: 4, overhangMM: 450 });
  near(R.roofHeightAt(faces, 4000, 2000), 800);
  near(R.roofHeightAt(faces, 4000, 0), 0);
  near(R.roofHeightAt(faces, 4000, -450 + 1e-4), -180, 0.01);
  const area = faces.reduce((s, f) => {
    let a = 0;
    for (let i = 0; i < f.pts.length; i++) { const p = f.pts[i], q = f.pts[(i + 1) % f.pts.length]; a += p.x * q.z - q.x * p.z; }
    return s + Math.abs(a) / 2;
  }, 0);
  near(area, (8000 + 900) * (4000 + 900), 1);
});

test('L 字・T 字・コの字の寄棟の高さは「勾配 × 縁までの L∞ 距離」に一致する（谷を含む正しい寄棟）', () => {
  const shapes = {
    L: { rooms: [[0, 0, 10000, 4000], [0, 4000, 4000, 10000]], poly: [[0, 0], [10000, 0], [10000, 4000], [4000, 4000], [4000, 10000], [0, 10000]] },
    T: { rooms: [[0, 0, 12000, 4000], [4000, 4000, 8000, 10000]], poly: [[0, 0], [12000, 0], [12000, 4000], [8000, 4000], [8000, 10000], [4000, 10000], [4000, 4000], [0, 4000]] },
    U: { rooms: [[0, 0, 4000, 10000], [4000, 6000, 8000, 10000], [8000, 0, 12000, 10000]], poly: [[0, 0], [4000, 0], [4000, 6000], [8000, 6000], [8000, 0], [12000, 0], [12000, 10000], [0, 10000]] },
  };
  for (const [name, sh] of Object.entries(shapes)) {
    const floor = floorOf(sh.rooms.map((r, i) => rect(`r${i}`, 'yoshitsu', ...r)));
    const roof = R.computeHipRoof(floor, null, { pitchSun: 4, overhangMM: 0 });
    assert.ok(roof, name);
    const poly = sh.poly.map(([x, z]) => ({ x, z }));
    const rand = rng(7);
    let checked = 0;
    for (let n = 0; n < 4000; n++) {
      const p = { x: rand() * 12000, z: rand() * 10000 };
      if (!M.pointInPolygon(p, poly)) continue;
      const h = R.roofHeightAt(roof.faces, p.x, p.z);
      assert.notEqual(h, null, `${name}: (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) に屋根がない`);
      near(h, T * distInf(p, poly), 1e-3);
      checked++;
    }
    assert.ok(checked > 1000, `${name} の検証点数`);
  }
});

test('複数の長方形を合成しても、屋根の面が重ならない（どの点も面は高々 1 枚）', () => {
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 12000, 4000), rect('B', 'yoshitsu', 4000, 4000, 8000, 10000)]);
  const roof = R.computeHipRoof(floor, null, { pitchSun: 4, overhangMM: 450 });
  const rand = rng(11);
  for (let n = 0; n < 4000; n++) {
    const x = -600 + rand() * 13200;
    const z = -600 + rand() * 11200;
    const hits = roof.faces.filter((f) => {
      // 内部（境界から 1mm 以上離れた点）だけを数える
      let inside = true;
      for (let i = 0; i < f.pts.length; i++) {
        const p = f.pts[i], q = f.pts[(i + 1) % f.pts.length];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const cross = ((q.x - p.x) * (z - p.z) - (q.z - p.z) * (x - p.x)) / len;
        // 面は反時計回りか時計回りか不定なので、符号がそろうかで判定
        f._s = f._s ?? [];
        f._s[i] = cross;
      }
      const pos = f._s.every((c) => c > 1e-3);
      const neg = f._s.every((c) => c < -1e-3);
      inside = pos || neg;
      f._s = undefined;
      return inside;
    });
    assert.ok(hits.length <= 1, `(${x.toFixed(0)}, ${z.toFixed(0)}) に面が ${hits.length} 枚`);
  }
});

test('上階の構造の隅に軒が触れても、屋根が上階の構造の中に入り込まない', () => {
  // A（0..4000 × 0..4000）と、対角に接する上階の U（4000..8000 × 4000..8000）
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 4000, 4000)]);
  const upper = floorOf([rect('U', 'yoshitsu', 4000, 4000, 8000, 8000)]);
  const roof = R.computeHipRoof(floor, upper, { pitchSun: 4, overhangMM: 450 });
  assert.ok(roof);
  for (const f of roof.faces) {
    for (const p of f.pts) assert.ok(!(p.x > 4000 + 1 && p.z > 4000 + 1), `面の頂点 (${p.x}, ${p.z}) が上階の構造の中`);
  }
});

test('faceVertices3D: 頂点の高さが平面式どおり', () => {
  const faces = R.buildHipRoofFaces([{ x0: 0, x1: 8000, z0: 0, z1: 4000 }], { pitchSun: 4, overhangMM: 450 });
  for (const f of faces) {
    for (const v of R.faceVertices3D(f)) near(v.y, f.plane.a * v.x + f.plane.b * v.z + f.plane.c, 1e-9);
  }
});

// ---- 保存（屋根の設定は建物全体で 1 つ。plan.roofSettings） ----

test('屋根の設定は plan.roofSettings に 1 つだけ持ち、normalizePlan で範囲外の値も丸められる', () => {
  const plan = M.createEmptyPlan('t');
  assert.deepEqual(M.normalizePlan(plan).roofSettings, S.DEFAULT_ROOF); // 新規プランは既定（陸屋根）
  plan.roofSettings = { type: 'hip', pitchSun: 99, overhangMM: 600 };
  const loaded = M.normalizePlan(JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(loaded.roofSettings, { type: 'hip', pitchSun: S.MAX_PITCH_SUN, overhangMM: 600 });
  // 2 回読み込んでも変わらない（冪等）
  assert.deepEqual(M.normalizePlan(JSON.parse(JSON.stringify(loaded))).roofSettings, loaded.roofSettings);
});

test('旧データ（バージョンごとの floor.roof）は、最初に見つかった設定を plan.roofSettings として引き継ぐ', () => {
  const plan = M.createEmptyPlan('t');
  delete plan.roofSettings; // 移行前のプランを模す（plan.roofSettings が無い）
  plan.floors[0].roof = { type: 'hip', pitchSun: 5, overhangMM: 300 }; // 1F だけに設定が残っている状態
  const loaded = M.normalizePlan(JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(loaded.roofSettings, { type: 'hip', pitchSun: 5, overhangMM: 300 });
  // 他の階の floor.roof が未設定でも、全階が同じ plan.roofSettings を使う（floorRoofStatus 相当）ので階ごとの食い違いは起きない
  for (const f of loaded.floors) assert.equal('roof' in f, false);
});

// ---- 部分対応: 斜めの壁を持つ部屋が混在していても、他の部屋には寄棟を作る ----

test('斜めの壁の部屋が 1 つ混ざっていても、他の部屋には寄棟が付く（除いた部屋は平らなまま）', () => {
  const tri = { id: 'T', type: 'yoshitsu', name: 'T', labelVisible: true, polygon: [{ x: 8000, z: 0 }, { x: 12000, z: 0 }, { x: 8000, z: 4000 }] };
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 8000, 4000), tri]);
  const res = R.computeRoofRegions(floor, null);
  assert.equal(res.supported, true);
  assert.equal(res.excludedCount, 1);
  assert.ok(res.hipRoomIds.has('A'));
  assert.ok(!res.hipRoomIds.has('T'));
  const roof = R.computeHipRoof(floor, null, { pitchSun: 4, overhangMM: 0 });
  assert.ok(roof);
  near(R.roofHeightAt(roof.faces, 4000, 2000), 800); // A の棟。斜めの部屋があっても A は通常どおり寄棟になる
});

test('部屋がすべて斜めの壁のみのときは、従来どおり階全体が非対応（reason: non-rectilinear）', () => {
  const tri = { id: 'T', type: 'yoshitsu', name: 'T', labelVisible: true, polygon: [{ x: 0, z: 0 }, { x: 5000, z: 0 }, { x: 0, z: 5000 }] };
  const res = R.computeRoofRegions(floorOf([tri]), null);
  assert.equal(res.supported, false);
  assert.equal(res.reason, 'non-rectilinear');
  assert.equal(res.excludedCount, 1);
});

test('上の階の構造が斜めのときは、現在の階が全て直交していても非対応（reason: non-rectilinear-upper）', () => {
  const floor = floorOf([rect('A', 'yoshitsu', 0, 0, 8000, 4000)]);
  const upperTri = { id: 'U', type: 'yoshitsu', name: 'U', labelVisible: true, polygon: [{ x: 0, z: 0 }, { x: 4000, z: 0 }, { x: 0, z: 4000 }] };
  const res = R.computeRoofRegions(floor, floorOf([upperTri]));
  assert.equal(res.supported, false);
  assert.equal(res.reason, 'non-rectilinear-upper');
  assert.equal(res.excludedCount, 0);
  assert.equal(R.computeHipRoof(floor, floorOf([upperTri]), { pitchSun: 4, overhangMM: 450 }), null);
});
