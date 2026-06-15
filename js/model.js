// model.js
// データ構造の定義／座標変換／面積・畳の計算（純粋関数中心）。
// 描画には一切依存しない。editor2d / viewer3d は同じ store の同じデータを読むだけ。

// 1P = 910mm（1マス）
export const P_MM = 910;

// ---- ID 生成 ----------------------------------------------------------------
let _seq = 0;
export function uid(prefix = 'id') {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

// ---- スナップ ---------------------------------------------------------------
// snapDivisions = 4 → 910/4 = 227.5mm（0.25P）。2 → 455mm（0.5P）。
export function snapUnit(snapDivisions) {
  return P_MM / snapDivisions;
}
export function snap(valueMM, snapDivisions) {
  const u = snapUnit(snapDivisions);
  return Math.round(valueMM / u) * u;
}
export function snapPoint(pt, snapDivisions) {
  return { x: snap(pt.x, snapDivisions), z: snap(pt.z, snapDivisions) };
}

// ---- 面積・畳 ---------------------------------------------------------------
// シューレース公式。polygon: [{x,z}, ...]（mm）。戻り値は mm²。
export function shoelaceAreaMM2(polygon) {
  if (!polygon || polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

export function mm2ToM2(mm2) {
  return mm2 / 1_000_000;
}

export function polygonAreaM2(polygon) {
  return mm2ToM2(shoelaceAreaMM2(polygon));
}

// 畳数 = 面積(m²) ÷ 基準値（既定 1.62）。
export function tatamiCount(areaM2, tatamiM2 = 1.62) {
  if (!tatamiM2) return 0;
  return areaM2 / tatamiM2;
}

// 「12.4㎡（7.6帖）」形式
export function formatAreaLabel(areaM2, tatamiM2 = 1.62) {
  const m2 = areaM2.toFixed(1);
  const jo = tatamiCount(areaM2, tatamiM2).toFixed(1);
  return `${m2}㎡（${jo}帖）`;
}

// ---- 幾何 -------------------------------------------------------------------
// 矩形ポリゴン（時計回り）を 2点から作る。
export function rectPolygon(x1, z1, x2, z2) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minZ = Math.min(z1, z2);
  const maxZ = Math.max(z1, z2);
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
}

export function polygonCentroid(polygon) {
  if (!polygon || polygon.length === 0) return { x: 0, z: 0 };
  let cx = 0, cz = 0, a = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    const cross = p0.x * p1.z - p1.x * p0.z;
    a += cross;
    cx += (p0.x + p1.x) * cross;
    cz += (p0.z + p1.z) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) {
    // 退化時は単純平均
    const n = polygon.length;
    return {
      x: polygon.reduce((s, p) => s + p.x, 0) / n,
      z: polygon.reduce((s, p) => s + p.z, 0) / n,
    };
  }
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

export function polygonBounds(polygon) {
  const xs = polygon.map((p) => p.x);
  const zs = polygon.map((p) => p.z);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

// 点がポリゴン内部にあるか（レイキャスト）
export function pointInPolygon(pt, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    const intersect = (zi > pt.z) !== (zj > pt.z)
      && pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// 軸並行の矩形（中心・サイズ・回転角）への内外判定（家具ヒット用）
export function pointInOrientedRect(pt, cx, cz, w, d, rotationDeg) {
  const rad = (-rotationDeg * Math.PI) / 180;
  const dx = pt.x - cx;
  const dz = pt.z - cz;
  const lx = dx * Math.cos(rad) - dz * Math.sin(rad);
  const lz = dx * Math.sin(rad) + dz * Math.cos(rad);
  return Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2;
}

// ---- 壁の自動生成 -----------------------------------------------------------
// 部屋ポリゴンの外周に沿って壁セグメントを生成する（MVP）。
export function wallsFromPolygon(polygon, { thicknessMM = 120, heightMM = 2400 } = {}) {
  const walls = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    walls.push({
      id: uid('w'),
      start: { x: a.x, z: a.z },
      end: { x: b.x, z: b.z },
      thicknessMM,
      heightMM,
    });
  }
  return walls;
}

// フロアの壁を全部屋ポリゴンから作り直す（MVP: 壁は部屋外周から自動生成）。
export function rebuildFloorWalls(floor) {
  const walls = [];
  for (const room of floor.rooms) {
    const segs = wallsFromPolygon(room.polygon, {
      thicknessMM: 120,
      heightMM: floor.ceilingHeightMM,
    });
    for (const s of segs) walls.push(s);
  }
  floor.walls = walls;
}

// ポリゴン全体を平行移動
export function translatePolygon(polygon, dx, dz) {
  return polygon.map((p) => ({ x: p.x + dx, z: p.z + dz }));
}

// ---- 既定データ -------------------------------------------------------------
export function defaultFloor(id, level) {
  return {
    id,
    level,
    ceilingHeightMM: 2400,
    rooms: [],
    walls: [],
    openings: [], // フェーズAでは空（スキーマのみ）
    furniture: [],
  };
}

export function createEmptyPlan(name = '新しいプラン') {
  return {
    meta: {
      name,
      schemaVersion: 1,
      unitMM: 910,
      snapDivisions: 4,
      tatamiM2: 1.62,
    },
    site: {
      boundary: [],
      azimuth: 0,
      backgroundImage: null,
    },
    floors: [
      defaultFloor('1F', 0),
      defaultFloor('2F', 1),
      defaultFloor('3F', 2),
    ],
    exterior: [], // フェーズAでは空（スキーマのみ）
  };
}

// floor を id で取得（無ければ作る）
export function getFloor(plan, floorId) {
  let f = plan.floors.find((fl) => fl.id === floorId);
  if (!f) {
    const level = { '1F': 0, '2F': 1, '3F': 2 }[floorId] ?? plan.floors.length;
    f = defaultFloor(floorId, level);
    plan.floors.push(f);
  }
  return f;
}

// 後付けのスキーマ補完（古いJSONを読み込んだとき用）
export function normalizePlan(plan) {
  const base = createEmptyPlan(plan?.meta?.name || 'プラン');
  const out = {
    meta: { ...base.meta, ...(plan.meta || {}) },
    site: { ...base.site, ...(plan.site || {}) },
    floors: Array.isArray(plan.floors) && plan.floors.length ? plan.floors : base.floors,
    exterior: Array.isArray(plan.exterior) ? plan.exterior : [],
  };
  out.floors = out.floors.map((f) => ({
    id: f.id,
    level: f.level ?? 0,
    ceilingHeightMM: f.ceilingHeightMM ?? 2400,
    rooms: Array.isArray(f.rooms) ? f.rooms : [],
    walls: Array.isArray(f.walls) ? f.walls : [],
    openings: Array.isArray(f.openings) ? f.openings : [],
    furniture: Array.isArray(f.furniture) ? f.furniture : [],
  }));
  return out;
}
