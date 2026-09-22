// roofModel.js — 屋根（寄棟）の純粋幾何。DOM / Three.js 非依存。単位は mm。
//
// 考え方:
//   1. 階の部屋（バルコニー・吹抜け・ポーチを除く）全体の形を「屋根領域」とする。部屋・上階の壁が軸並行
//      （直交する壁だけ）のときは、壁の座標で格子に分けて領域を作る。
//   2. 領域を「最大の長方形」に分け、各長方形に 4 面の寄棟屋根を作る（壁の位置が高さ 0、軒先は下がる）。
//   3. 複数の長方形の屋根は「各点で高いほうを残す」ことで合成する。これは、直交する壁だけの領域では
//      「屋根の高さ = 勾配 × 領域の縁までの距離（L∞ 距離）」と一致し、L 字・T 字でも谷を含む正しい寄棟になる。
//   4. 上の階の構造がある部分は屋根から「くり抜く」（上の階が屋根を貫く形になる）。上階に一部だけ覆われた
//      部屋にも、階段状に重なった家の下の階にも、上が空いている部分には屋根が付く。
// 屋根の高さは壁の上端（天井高の位置）を 0 とした相対値（y）で返す。

import * as M from './model.js';
import { pitchTan } from './roofSettings.js';

const EPS = 1e-6;
const AREA_EPS = 1; // mm²。これ未満の面積の欠片は捨てる
const MAX_GRID = 50; // 格子の分割数の上限（複雑すぎる平面は対象外にして重さを防ぐ）

// ---- 凸多角形の切り取り ------------------------------------------------------

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.z - q.x * p.z;
  }
  return Math.abs(s) / 2;
}

/**
 * 連続する（ほぼ）同じ位置の頂点を 1 つにする。切り取りで頂点が辺上に重なると同じ点が 2 回出るため。
 * 一直線上の頂点は残す（隣の面と頂点を共有させ、継ぎ目にすき間ができるのを防ぐ）。
 */
function dedupePoly(poly) {
  const tol = 1e-4;
  const pts = [];
  for (const p of poly) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) > tol) pts.push(p);
  }
  while (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) <= tol) pts.pop();
  return pts;
}

/** 凸多角形を半平面 a*x + b*z + c <= 0 で切る（Sutherland–Hodgman） */
function clipHalfPlane(poly, a, b, c) {
  const out = [];
  const val = (p) => a * p.x + b * p.z + c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const vp = val(p);
    const vq = val(q);
    const pin = vp <= EPS;
    const qin = vq <= EPS;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = vp / (vp - vq);
      out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
    }
  }
  return dedupePoly(out);
}

/** 凸多角形から、制約 {a*x + b*z + c <= 0} すべてを満たす領域 C を引く。結果は凸多角形の集まり */
function subtractConstraints(poly, constraints) {
  const pieces = [];
  let rem = poly;
  for (const { a, b, c } of constraints) {
    const outside = clipHalfPlane(rem, -a, -b, -c);
    if (polyArea(outside) > AREA_EPS) pieces.push(outside);
    rem = clipHalfPlane(rem, a, b, c);
    if (polyArea(rem) <= AREA_EPS) break;
  }
  return pieces;
}

/** 軸並行の長方形 {x0,x1,z0,z1} に「含まれる」ことを表す制約 */
function rectConstraints(r) {
  return [
    { a: -1, b: 0, c: r.x0 },
    { a: 1, b: 0, c: -r.x1 },
    { a: 0, b: -1, c: r.z0 },
    { a: 0, b: 1, c: -r.z1 },
  ];
}

function rectPolygon(r) {
  return [
    { x: r.x0, z: r.z0 }, { x: r.x1, z: r.z0 },
    { x: r.x1, z: r.z1 }, { x: r.x0, z: r.z1 },
  ];
}

// ---- 寄棟の屋根面 ------------------------------------------------------------

/** 長方形の 4 つの屋根面の平面式 h = a*x + b*z + c（壁の位置が h = 0。壁から離れるほど上がる） */
function rectPlanes(r, t) {
  return [
    { a: t, b: 0, c: -t * r.x0 },   // 西面
    { a: -t, b: 0, c: t * r.x1 },   // 東面
    { a: 0, b: t, c: -t * r.z0 },   // 北面
    { a: 0, b: -t, c: t * r.z1 },   // 南面
  ];
}

/** 軒の出 o を含めた長方形 */
function expandRect(r, o) {
  return { x0: r.x0 - o, x1: r.x1 + o, z0: r.z0 - o, z1: r.z1 + o };
}

/** 1 つの長方形の寄棟（軒の出込み）を、凸多角形の面 4 枚（退化するものは除く）に分ける */
export function hipFacesForRect(r, pitchTanValue, overhangMM = 0) {
  const planes = rectPlanes(r, pitchTanValue);
  const footprint = rectPolygon(expandRect(r, overhangMM));
  const faces = [];
  planes.forEach((pk, k) => {
    let poly = footprint;
    planes.forEach((pm, m) => {
      if (m !== k) poly = clipHalfPlane(poly, pk.a - pm.a, pk.b - pm.b, pk.c - pm.c); // h_k <= h_m の側
    });
    if (poly.length >= 3 && polyArea(poly) > AREA_EPS) faces.push({ pts: poly, plane: pk });
  });
  return faces;
}

/**
 * 複数の長方形の寄棟を、各点で高いほうを残して 1 つの屋根にする。
 * 戻り値は { pts: [{x,z}], plane: {a,b,c} } の配列（各面は凸多角形、y = a*x + b*z + c）。
 * exclusionRects（上階の構造の位置など）は屋根から除く。
 */
export function buildHipRoofFaces(rects, { pitchSun, overhangMM }, exclusionRects = []) {
  const t = pitchTan(pitchSun);
  const o = Math.max(0, overhangMM || 0);
  const items = rects.map((r, idx) => ({
    idx,
    faces: hipFacesForRect(r, t, o),
    planes: rectPlanes(r, t),
    footprintConstraints: rectConstraints(expandRect(r, o)),
  }));
  const tieEps = 1e-4;
  const result = [];
  for (const A of items) {
    for (const F of A.faces) {
      let pieces = [F.pts];
      for (const B of items) {
        if (B === A || !pieces.length) continue;
        // B の屋根が F の面以上に高い領域を除く。同じ高さ（同一平面）は番号の大きい長方形に譲って重複を防ぐ
        const tie = A.idx < B.idx ? -tieEps : tieEps;
        const constraints = [...B.footprintConstraints];
        for (const pm of B.planes) {
          constraints.push({
            a: -(pm.a - F.plane.a),
            b: -(pm.b - F.plane.b),
            c: -(pm.c - F.plane.c) + tie,
          });
        }
        pieces = pieces.flatMap((p) => subtractConstraints(p, constraints));
      }
      for (const X of exclusionRects) {
        if (!pieces.length) break;
        const cs = rectConstraints(X);
        pieces = pieces.flatMap((p) => subtractConstraints(p, cs));
      }
      for (const pts of pieces) result.push({ pts, plane: F.plane });
    }
  }
  return result;
}

/** 面の頂点を 3 次元（y は壁の上端からの高さ）にする */
export function faceVertices3D(face) {
  const { a, b, c } = face.plane;
  return face.pts.map((p) => ({ x: p.x, y: a * p.x + b * p.z + c, z: p.z }));
}

function pointInConvex(pts, x, z, tol = 1e-6) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = (q.x - p.x) * (z - p.z) - (q.z - p.z) * (x - p.x);
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 1e-9) continue; // 長さのない辺は向きが定まらない
    const d = cross / len;
    if (Math.abs(d) <= tol) continue;
    const s = d > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 点 (x, z) の屋根の高さ（壁の上端からの mm）。屋根の外なら null（テスト・デバッグ用） */
export function roofHeightAt(faces, x, z) {
  for (const f of faces) {
    if (pointInConvex(f.pts, x, z)) return f.plane.a * x + f.plane.b * z + f.plane.c;
  }
  return null;
}

// ---- 屋根領域 -----------------------------------------------------------------

function isAxisAligned(poly, tol = 1) {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (Math.abs(q.x - p.x) > tol && Math.abs(q.z - p.z) > tol) return false;
  }
  return true;
}

function uniqueSorted(values) {
  return [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b);
}

/**
 * 階の「屋根領域」を求める。
 * 領域 = 部屋（バルコニー・吹抜け・ポーチを除く）の形。上階の構造（部屋・階段。バルコニー等は構造とみなさない）に
 * 覆われた部分は、寄棟の形には含めたまま、屋根の面から「くり抜く」（upperRects）。
 * 戻り値: {
 *   supported,                // 直交する壁だけの平面か（false のとき regions は空）
 *   regions: [{ rects, visibleCells }],  // つながりごと。rects: 最大の長方形、visibleCells: 上階に覆われていないセル数
 *   hipRoomIds,               // 寄棟で覆う部屋（対応できる階では、屋根の対象の部屋すべて）
 *   upperRects,               // 上階の構造の位置（屋根から除く範囲）
 * }
 */
export function computeRoofRegions(floor, upperFloor) {
  const empty = { supported: true, regions: [], hipRoomIds: new Set(), upperRects: [] };
  const roofRooms = (floor?.rooms || []).filter(
    (r) => r.polygon?.length >= 3 && !M.NO_AUTO_ROOF_TYPES.has(r.type),
  );
  if (!roofRooms.length) return empty;

  const upperPolys = [];
  if (upperFloor) {
    for (const ur of upperFloor.rooms || []) {
      if (!M.UPPER_OPEN_ROOF_TYPES.has(ur.type) && ur.polygon?.length >= 3) upperPolys.push(ur.polygon);
    }
    for (const s of upperFloor.stairs || []) upperPolys.push(M.stairFootprintCorners(s));
  }

  const allPolys = [...roofRooms.map((r) => r.polygon), ...upperPolys];
  if (!allPolys.every((p) => isAxisAligned(p))) return { ...empty, supported: false, reason: 'non-rectilinear' };

  const xs = uniqueSorted(allPolys.flat().map((p) => p.x));
  const zs = uniqueSorted(allPolys.flat().map((p) => p.z));
  if (xs.length > MAX_GRID || zs.length > MAX_GRID) return { ...empty, supported: false, reason: 'too-complex' };
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  if (nx < 1 || nz < 1) return empty;

  // 各セルの判定（中心点で、階の部屋・上階の構造のどちらに入るか）
  const inRoom = Array.from({ length: nx }, () => new Array(nz).fill(false));
  const inUpper = Array.from({ length: nx }, () => new Array(nz).fill(false));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const c = { x: (xs[i] + xs[i + 1]) / 2, z: (zs[j] + zs[j + 1]) / 2 };
      inRoom[i][j] = roofRooms.some((r) => M.pointInPolygon(c, r.polygon));
      inUpper[i][j] = upperPolys.some((p) => M.pointInPolygon(c, p));
    }
  }

  // つながり（4 近傍）ごとに領域へ
  const regionOf = Array.from({ length: nx }, () => new Array(nz).fill(-1));
  const regions = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!inRoom[i][j] || regionOf[i][j] !== -1) continue;
      const id = regions.length;
      const stack = [[i, j]];
      regionOf[i][j] = id;
      let visibleCells = 0;
      while (stack.length) {
        const [ci, cj] = stack.pop();
        if (!inUpper[ci][cj]) visibleCells++;
        for (const [di, dj] of dirs) {
          const ni = ci + di;
          const nj = cj + dj;
          if (ni >= 0 && nj >= 0 && ni < nx && nj < nz && inRoom[ni][nj] && regionOf[ni][nj] === -1) {
            regionOf[ni][nj] = id;
            stack.push([ni, nj]);
          }
        }
      }
      regions.push({ id, rects: [], visibleCells });
    }
  }

  // 領域ごとの最大の長方形（これ以上どの方向にも広げられない長方形）。全面が上階に覆われた領域は屋根が要らないので省く
  for (const region of regions) {
    if (region.visibleCells === 0) continue;
    const prefix = Array.from({ length: nx + 1 }, () => new Array(nz + 1).fill(0));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        prefix[i + 1][j + 1] = prefix[i][j + 1] + prefix[i + 1][j] - prefix[i][j]
          + (regionOf[i][j] === region.id ? 1 : 0);
      }
    }
    const full = (i1, i2, j1, j2) => {
      if (i1 < 0 || j1 < 0 || i2 >= nx || j2 >= nz) return false;
      const cnt = prefix[i2 + 1][j2 + 1] - prefix[i1][j2 + 1] - prefix[i2 + 1][j1] + prefix[i1][j1];
      return cnt === (i2 - i1 + 1) * (j2 - j1 + 1);
    };
    for (let i1 = 0; i1 < nx; i1++) {
      for (let i2 = i1; i2 < nx; i2++) {
        for (let j1 = 0; j1 < nz; j1++) {
          for (let j2 = j1; j2 < nz; j2++) {
            if (!full(i1, i2, j1, j2)) continue;
            if (full(i1 - 1, i2, j1, j2) || full(i1, i2 + 1, j1, j2)
              || full(i1, i2, j1 - 1, j2) || full(i1, i2, j1, j2 + 1)) continue;
            region.rects.push({ x0: xs[i1], x1: xs[i2 + 1], z0: zs[j1], z1: zs[j2 + 1] });
          }
        }
      }
    }
  }

  // 上階の構造の範囲（行ごとの連続区間）。屋根からくり抜く範囲で、軒が上階の構造の中へ入り込むのも防ぐ
  const upperRects = [];
  for (let j = 0; j < nz; j++) {
    let start = -1;
    for (let i = 0; i <= nx; i++) {
      const on = i < nx && inUpper[i][j];
      if (on && start === -1) start = i;
      if (!on && start !== -1) {
        upperRects.push({ x0: xs[start], x1: xs[i], z0: zs[j], z1: zs[j + 1] });
        start = -1;
      }
    }
  }

  return { supported: true, regions, hipRoomIds: new Set(roofRooms.map((r) => r.id)), upperRects };
}

const hipRoofCache = new Map();

/**
 * 階の寄棟屋根をまとめて求める。屋根が付く部分（上階に覆われていない部分）がなければ null。
 * 戻り値: { faces, hipRoomIds, regions }（faces は buildHipRoofFaces の結果）
 * 同じ入力は再計算しない（3D の再構築・日射計算で何度も呼ばれるため）。
 */
export function computeHipRoof(floor, upperFloor, settings) {
  const key = JSON.stringify([
    (floor?.rooms || []).map((r) => [r.id, r.type, r.polygon]),
    upperFloor
      ? [(upperFloor.rooms || []).map((r) => [r.type, r.polygon]), (upperFloor.stairs || []).map((s) => M.stairFootprintCorners(s))]
      : null,
    settings.pitchSun, settings.overhangMM,
  ]);
  if (hipRoofCache.has(key)) return hipRoofCache.get(key);
  const res = computeRoofRegions(floor, upperFloor);
  let result = null;
  if (res.supported) {
    const rects = res.regions.flatMap((r) => r.rects);
    if (rects.length) {
      result = {
        faces: buildHipRoofFaces(rects, settings, res.upperRects),
        hipRoomIds: res.hipRoomIds,
        regions: res.regions,
      };
    }
  }
  if (hipRoofCache.size > 30) hipRoofCache.clear();
  hipRoofCache.set(key, result);
  return result;
}
