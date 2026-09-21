// model.js
// データ構造の定義／座標変換／面積・畳の計算（純粋関数中心）。
// 描画には一切依存しない。editor2d / viewer3d は同じ store の同じデータを読むだけ。

// 1P = 910mm（1マス）
export const P_MM = 910;
export const DEFAULT_CEILING_MM = 2400;
export const DEFAULT_WALL_THICKNESS_MM = 120;

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

// ---- 構造モード・壁厚プリセット --------------------------------------------
export const CONSTRUCTION_METHODS = {
  post_and_beam: {
    id: 'post_and_beam',
    label: '木造軸組',
    exteriorMM: 180,
    interiorMM: 120,
  },
  two_by_six: {
    id: 'two_by_six',
    label: '2×6',
    exteriorMM: 140,
    interiorMM: 89,
  },
};

export function getConstructionMethod(plan) {
  const m = plan?.meta?.constructionMethod;
  return m === 'post_and_beam' ? 'post_and_beam' : 'two_by_six';
}

export function wallThicknessPreset(plan, exterior) {
  const method = getConstructionMethod(plan);
  const preset = CONSTRUCTION_METHODS[method];
  return exterior ? preset.exteriorMM : preset.interiorMM;
}

function _wallEdgeKey(a, b) {
  return wallEdgeKey(a, b);
}

export function pointToSegmentDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}

function _pointToSegmentDist(p, a, b) {
  return pointToSegmentDist(p, a, b);
}

function _segmentsParallel(a1, a2, b1, b2, angEps = 0.05) {
  const dax = a2.x - a1.x, daz = a2.z - a1.z;
  const dbx = b2.x - b1.x, dbz = b2.z - b1.z;
  const la = Math.hypot(dax, daz), lb = Math.hypot(dbx, dbz);
  if (la < 1 || lb < 1) return false;
  const dot = Math.abs((dax / la) * (dbx / lb) + (daz / la) * (dbz / lb));
  return dot > 1 - angEps;
}

function _wallTouchesSiteBoundary(wall, boundary, eps = 25) {
  if (!Array.isArray(boundary) || boundary.length < 2) return false;
  for (let i = 0; i < boundary.length; i++) {
    const ba = boundary[i];
    const bb = boundary[(i + 1) % boundary.length];
    if (!_segmentsParallel(wall.start, wall.end, ba, bb)) continue;
    const mid = {
      x: (wall.start.x + wall.end.x) / 2,
      z: (wall.start.z + wall.end.z) / 2,
    };
    const d1 = _pointToSegmentDist(wall.start, ba, bb);
    const d2 = _pointToSegmentDist(wall.end, ba, bb);
    const dm = _pointToSegmentDist(mid, ba, bb);
    if (Math.min(d1, d2, dm) > eps) continue;
    const len = Math.hypot(bb.x - ba.x, bb.z - ba.z);
    if (len < 1) continue;
    const ux = (bb.x - ba.x) / len, uz = (bb.z - ba.z) / len;
    const t = (p) => p.x * ux + p.z * uz;
    const wLo = Math.min(t(wall.start), t(wall.end));
    const wHi = Math.max(t(wall.start), t(wall.end));
    const bLo = Math.min(t(ba), t(bb));
    const bHi = Math.max(t(ba), t(bb));
    if (Math.max(0, Math.min(wHi, bHi) - Math.max(wLo, bLo)) > eps) return true;
  }
  return false;
}

function _isBuildingPerimeterWall(wall, walls) {
  const key = _wallEdgeKey(wall.start, wall.end);
  let count = 0;
  for (const w of walls) {
    if (_wallEdgeKey(w.start, w.end) === key) count++;
  }
  return count === 1;
}

/** 外壁判定：敷地境界・建物外周・屋外（バルコニー等）に面する壁 */
export function isExteriorWall(wall, floor, plan) {
  if (_wallTouchesSiteBoundary(wall, plan?.site?.boundary)) return true;
  if (_isBuildingPerimeterWall(wall, floor.walls || [])) return true;
  return _wallAdjoinsOutdoorRoom(wall, floor);
}

/** 屋外扱いの部屋（バルコニー・吹抜け・ポーチなど） */
export const OUTDOOR_ROOM_TYPES = new Set(['balcony', 'fukinuke', 'porch']);

/** 床板のみ（壁・天井なし）の部屋種別 */
export const FLOOR_ONLY_ROOM_TYPES = new Set(['porch']);

export function isOutdoorRoom(room) {
  return OUTDOOR_ROOM_TYPES.has(room?.type);
}

export function isFloorOnlyRoom(room) {
  return FLOOR_ONLY_ROOM_TYPES.has(room?.type);
}

/** 室内と屋外が接する共有壁か */
function _wallAdjoinsOutdoorRoom(wall, floor) {
  const key = wallEdgeKeyFromWall(wall);
  const wallRoomId = inferWallRoomId(wall);
  const wallRoom = floor.rooms?.find((r) => r.id === wallRoomId);
  const wallOutdoor = wallRoom ? isOutdoorRoom(wallRoom) : false;
  for (const w of floor.walls || []) {
    if (inferWallRoomId(w) === wallRoomId) continue;
    if (wallEdgeKeyFromWall(w) !== key) continue;
    const other = floor.rooms?.find((r) => r.id === inferWallRoomId(w));
    if (!other) continue;
    if (isOutdoorRoom(other) !== wallOutdoor) return true;
  }
  return false;
}

function _matchWallGeometry(a, b) {
  const same = (p, q) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.z - q.z) < 0.5;
  return (same(a.start, b.start) && same(a.end, b.end))
    || (same(a.start, b.end) && same(a.end, b.start));
}

function _findMatchingOldWall(oldWalls, newWall) {
  const rid = inferWallRoomId(newWall);
  return oldWalls.find((ow) => _matchWallGeometry(ow, newWall) && inferWallRoomId(ow) === rid);
}

/** 全壁の外壁フラグ（wall.id → boolean） */
export function classifyExteriorWalls(floor, plan) {
  const map = new Map();
  for (const wall of floor.walls || []) {
    map.set(wall.id, isExteriorWall(wall, floor, plan));
  }
  return map;
}

/** 構造モードのプリセットを全壁に一括適用 */
export function applyConstructionWallThickness(plan) {
  for (const floor of plan.floors || []) {
    const exterior = classifyExteriorWalls(floor, plan);
    for (const wall of floor.walls || []) {
      wall.thicknessMM = wallThicknessPreset(plan, exterior.get(wall.id));
    }
  }
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

// 「7.6畳（12.4㎡）」形式
export function formatAreaLabel(areaM2, tatamiM2 = 1.62) {
  const m2 = areaM2.toFixed(1);
  const jo = tatamiCount(areaM2, tatamiM2).toFixed(1);
  return `${jo}畳（${m2}㎡）`;
}

// 1坪 = 3.305785… m²（日本の法制）
export const TSUBO_M2 = 3.30578578298473;

export function tsuboCount(areaM2) {
  return areaM2 / TSUBO_M2;
}

/** 階段フットプリント面積（m²） */
export function stairFootprintAreaM2(stair) {
  return mm2ToM2((stair.widthMM || 0) * (stair.depthMM || 0));
}

/** 階段中心が部屋ポリゴン内にあるか */
export function stairInsideRoom(stair, floor) {
  return (floor.rooms || []).some(
    (room) => room.polygon && pointInPolygon({ x: stair.x, z: stair.z }, room.polygon),
  );
}

/** 全フロアの部屋面積合計（延床面積）。部屋に含まれない独立階段のフットプリントも加算。 */
export function planTotalAreaM2(plan, opts = {}) {
  const excludeGarage = opts.excludeGarage === true;
  let total = 0;
  for (const floor of plan.floors) {
    for (const room of floor.rooms) {
      if (excludeGarage && room.type === 'garage') continue;
      total += polygonAreaM2(room.polygon);
    }
    for (const stair of floor.stairs || []) {
      if (!stairInsideRoom(stair, floor)) {
        total += stairFootprintAreaM2(stair);
      }
    }
  }
  return total;
}

/** プラン一覧用の ㎡ / 畳 / 坪 表示 */
export function formatTotalAreaTriple(areaM2, tatamiM2 = 1.62) {
  return {
    m2: areaM2.toFixed(2),
    jo: tatamiCount(areaM2, tatamiM2).toFixed(1),
    tsubo: tsuboCount(areaM2).toFixed(2),
  };
}

/** プラン一覧カード用の統計 */
export function planStats(plan) {
  const tatami = plan.meta.tatamiM2 || 1.62;
  const areaWithGarage = planTotalAreaM2(plan);
  const areaExGarage = planTotalAreaM2(plan, { excludeGarage: true });
  let roomCount = 0;
  let floorsWithRooms = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const floor of plan.floors) {
    if (floor.rooms.length) floorsWithRooms += 1;
    roomCount += floor.rooms.length;
    for (const room of floor.rooms) {
      for (const p of room.polygon) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
  }
  const hasBounds = Number.isFinite(minX);
  const widthM = hasBounds ? (maxX - minX) / 1000 : 0;
  const depthM = hasBounds ? (maxZ - minZ) / 1000 : 0;
  const floorCount = floorsWithRooms || plan.floors.length;
  return {
    areaM2: areaWithGarage,
    areaExGarageM2: areaExGarage,
    tatami,
    roomCount,
    floorCount,
    widthM,
    depthM,
    areasWithGarage: formatTotalAreaTriple(areaWithGarage, tatami),
    areasExGarage: formatTotalAreaTriple(areaExGarage, tatami),
    // 後方互換
    areas: formatTotalAreaTriple(areaWithGarage, tatami),
  };
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

// ---- 屋根自動生成（部屋単位・上階重なり判定）--------------------------------
/** 屋根を付けない部屋種別 */
export const NO_AUTO_ROOF_TYPES = new Set(['balcony', 'fukinuke', 'porch']);
/** 上階で「構造」とみなさない部屋（下階への遮蔽なし） */
export const UPPER_OPEN_ROOF_TYPES = new Set(['balcony', 'fukinuke', 'porch']);

function _cross2D(o, a, b) {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

function _onSegment2D(a, b, c) {
  return Math.min(a.x, c.x) - 1e-6 <= b.x && b.x <= Math.max(a.x, c.x) + 1e-6
    && Math.min(a.z, c.z) - 1e-6 <= b.z && b.z <= Math.max(a.z, c.z) + 1e-6;
}

function _segmentsIntersect2D(a1, a2, b1, b2) {
  const d1 = _cross2D(a1, a2, b1);
  const d2 = _cross2D(a1, a2, b2);
  const d3 = _cross2D(b1, b2, a1);
  const d4 = _cross2D(b1, b2, a2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (Math.abs(d1) < 1e-9 && _onSegment2D(a1, b1, a2)) return true;
  if (Math.abs(d2) < 1e-9 && _onSegment2D(a1, b2, a2)) return true;
  if (Math.abs(d3) < 1e-9 && _onSegment2D(b1, a1, b2)) return true;
  if (Math.abs(d4) < 1e-9 && _onSegment2D(b1, a2, b2)) return true;
  return false;
}

/** 2 ポリゴン（XZ）が重なるか */
export function polygonsOverlapXZ(polyA, polyB) {
  if (!polyA?.length || !polyB?.length || polyA.length < 3 || polyB.length < 3) return false;
  for (const p of polyA) {
    if (pointInPolygon(p, polyB)) return true;
  }
  for (const p of polyB) {
    if (pointInPolygon(p, polyA)) return true;
  }
  const ca = polygonCentroid(polyA);
  const cb = polygonCentroid(polyB);
  if (pointInPolygon(ca, polyB) || pointInPolygon(cb, polyA)) return true;
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i], a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j], b2 = polyB[(j + 1) % polyB.length];
      if (_segmentsIntersect2D(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/** 上階にこの部屋と重なる構造（部屋・階段）があるか */
export function roomHasUpperStructureOverlap(room, upperFloor) {
  if (!room?.polygon || room.polygon.length < 3 || !upperFloor) return false;
  for (const ur of upperFloor.rooms || []) {
    if (UPPER_OPEN_ROOF_TYPES.has(ur.type)) continue;
    if (ur.polygon?.length >= 3 && polygonsOverlapXZ(room.polygon, ur.polygon)) return true;
  }
  for (const stair of upperFloor.stairs || []) {
    if (polygonsOverlapXZ(room.polygon, stairFootprintCorners(stair))) return true;
  }
  return false;
}

/** 平板屋根を自動生成すべき部屋か（バルコニー・吹抜け除外、上階構造なし） */
export function roomNeedsAutoRoof(room, floor, plan) {
  if (!room?.polygon || room.polygon.length < 3) return false;
  if (NO_AUTO_ROOF_TYPES.has(room.type)) return false;
  const upper = getUpperFloor(plan, floor.id);
  if (!upper) return true;
  return !roomHasUpperStructureOverlap(room, upper);
}

export function wallThicknessMM(wall, fallback = DEFAULT_WALL_THICKNESS_MM) {
  return wall?.thicknessMM ?? fallback;
}

export function floorCeilingMM(floor, fallback = DEFAULT_CEILING_MM) {
  return floor?.ceilingHeightMM ?? fallback;
}

/** バルコニーの屋外側の壁（手すり壁）の既定の高さ（mm） */
export const BALCONY_PARAPET_MM = 1500;
/** 手すり壁の高さの下限（mm） */
export const MIN_BALCONY_PARAPET_MM = 300;

/**
 * バルコニーの手すり壁の高さ（mm）。部屋ごとに room.parapetHeightMM で指定でき、未指定なら既定値。
 * 下限（300mm）と階の天井高の範囲に収める。
 */
export function balconyParapetMM(room, ceilingMM) {
  const v = Number(room?.parapetHeightMM);
  const h = Number.isFinite(v) && v > 0 ? v : BALCONY_PARAPET_MM;
  return Math.min(Math.max(Math.round(h), MIN_BALCONY_PARAPET_MM), ceilingMM);
}

/**
 * 壁の高さを部屋の種類から決める。
 * バルコニーの屋外側の辺だけ手すり壁の高さ、それ以外（居室の壁・バルコニーと居室が共有する建物側の壁）は階の天井高。
 * 「居室と共有する辺」は、辺の座標が居室の壁と一致するか、辺の中点が居室の壁の上にある（同一直線上）辺とみなす。
 * バルコニーが 2 つ並んで 1 つの居室の壁に接する場合のように、辺の一部だけが居室の壁と重なる場合にも対応するが、
 * 辺の途中で共有と屋外が切り替わる場合（バルコニーが居室より長い等）は、辺全体を中点の側に揃える。
 */
export function applyWallHeights(floor) {
  const ceiling = floorCeilingMM(floor);
  const roomById = new Map((floor.rooms || []).map((r) => [r.id, r]));
  const indoorWalls = (floor.walls || []).filter((w) => {
    const room = roomById.get(inferWallRoomId(w));
    return room && !isOutdoorRoom(room);
  });
  const indoorEdgeKeys = new Set(indoorWalls.map((w) => wallEdgeKeyFromWall(w)));
  const sharedWithIndoor = (w) => {
    if (indoorEdgeKeys.has(wallEdgeKeyFromWall(w))) return true;
    const mid = { x: (w.start.x + w.end.x) / 2, z: (w.start.z + w.end.z) / 2 };
    return indoorWalls.some((iw) =>
      _segmentsParallel(w.start, w.end, iw.start, iw.end) && pointToSegmentDist(mid, iw.start, iw.end) < 5);
  };
  for (const w of floor.walls || []) {
    const room = roomById.get(inferWallRoomId(w));
    const parapet = room?.type === 'balcony' && !sharedWithIndoor(w);
    w.heightMM = parapet ? balconyParapetMM(room, ceiling) : ceiling;
  }
}

// ---- 壁の自動生成 -----------------------------------------------------------
/** 壁辺の決定論的キー（共有壁の同一判定に使用） */
export function wallEdgeKey(start, end) {
  const r = (v) => Math.round(v);
  const p1 = `${r(start.x)},${r(start.z)}`;
  const p2 = `${r(end.x)},${r(end.z)}`;
  return p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`;
}

export function wallEdgeKeyFromWall(wall) {
  return wallEdgeKey(wall.start, wall.end);
}

export function isWallEdgeRemoved(floor, wall) {
  return (floor.removedWallEdges || []).includes(wallEdgeKeyFromWall(wall));
}

export function removeWallEdges(floor, edgeKeys) {
  if (!edgeKeys?.length) return;
  if (!floor.removedWallEdges) floor.removedWallEdges = [];
  for (const key of edgeKeys) {
    if (!floor.removedWallEdges.includes(key)) floor.removedWallEdges.push(key);
  }
  const removed = new Set(edgeKeys);
  floor.openings = (floor.openings || []).filter((op) => {
    const w = floor.walls.find((wl) => wl.id === op.wallId);
    return w && !removed.has(wallEdgeKeyFromWall(w));
  });
}

export function pruneRemovedWallEdges(floor) {
  if (!floor.removedWallEdges?.length) return;
  const live = new Set((floor.walls || []).map(wallEdgeKeyFromWall));
  floor.removedWallEdges = floor.removedWallEdges.filter((k) => live.has(k));
}

/** 壁再生成後も建具の wallId を幾何＋部屋で追従させる */
export function remapOpeningWallIds(floor, oldWalls) {
  for (const op of floor.openings || []) {
    const ow = oldWalls.find((w) => w.id === op.wallId);
    if (!ow) continue;
    const owRoom = inferWallRoomId(ow);
    const nw = floor.walls.find(
      (w) => _matchWallGeometry(w, ow) && inferWallRoomId(w) === owRoom,
    );
    if (nw) {
      op.wallId = nw.id;
      op.wallEdgeKey = wallEdgeKeyFromWall(nw);
    }
  }
  // 古いデータ: wallEdgeKey 未設定の建具を補完
  for (const op of floor.openings || []) {
    if (op.wallEdgeKey) continue;
    const w = floor.walls.find((wl) => wl.id === op.wallId);
    if (w) op.wallEdgeKey = wallEdgeKeyFromWall(w);
  }
}

/** 1 本の壁に紐づく建具（共有壁は edgeKey、幾何フォールバック付き） */
export function openingsForWall(floor, wall) {
  const key = wallEdgeKeyFromWall(wall);
  const seen = new Set();
  const ops = [];
  for (const op of floor.openings || []) {
    if (seen.has(op.id)) continue;
    const ref = floor.walls.find((w) => w.id === op.wallId);
    let include = false;
    if (op.wallId === wall.id || op.wallEdgeKey === key) {
      include = true;
    } else if (ref && wallEdgeKeyFromWall(ref) === key) {
      include = true;
    } else if (ref && _pointOnWallSegment(wall, openingWorldPoint(ref, op))) {
      include = true;
    }
    if (!include) continue;
    seen.add(op.id);
    ops.push(op);
  }
  return ops.sort((a, b) => a.offsetMM - b.offsetMM);
}

export function wallsSameDirection(a, b) {
  const same = (p, q) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.z - q.z) < 0.5;
  return same(a.start, b.start) && same(a.end, b.end);
}

/** 建具配置点の世界座標 */
export function openingWorldPoint(wall, opening) {
  const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1) return { x: wall.start.x, z: wall.start.z };
  const ux = dx / len, uz = dz / len;
  return {
    x: wall.start.x + ux * opening.offsetMM,
    z: wall.start.z + uz * opening.offsetMM,
  };
}

/** 世界座標を壁の offsetMM に変換 */
export function offsetOnWallFromPoint(wall, pt) {
  const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1) return 0;
  const ux = dx / len, uz = dz / len;
  return (pt.x - wall.start.x) * ux + (pt.z - wall.start.z) * uz;
}

/** 建具の offset を描画壁の向きに合わせて変換（世界座標で投影） */
export function openingOffsetOnWall(opening, floor, renderWall) {
  const ref = floor.walls.find((w) => w.id === opening.wallId)
    || floor.walls.find((w) => opening.wallEdgeKey && wallEdgeKeyFromWall(w) === opening.wallEdgeKey);
  if (!ref) return opening.offsetMM;
  const pt = openingWorldPoint(ref, opening);
  return offsetOnWallFromPoint(renderWall, pt);
}

function _wallSpan(wall) {
  const EPS = 0.5;
  const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
  if (Math.abs(dz) < EPS) {
    const z = Math.round((wall.start.z + wall.end.z) / 2);
    return {
      kind: 'H', fixed: z,
      min: Math.min(wall.start.x, wall.end.x),
      max: Math.max(wall.start.x, wall.end.x),
      wall,
    };
  }
  if (Math.abs(dx) < EPS) {
    const x = Math.round((wall.start.x + wall.end.x) / 2);
    return {
      kind: 'V', fixed: x,
      min: Math.min(wall.start.z, wall.end.z),
      max: Math.max(wall.start.z, wall.end.z),
      wall,
    };
  }
  return {
    kind: 'D',
    fixed: 0,
    min: 0,
    max: Math.hypot(dx, dz),
    wall,
  };
}

function _pointOnWallSegment(wall, pt, tol = 2) {
  const off = offsetOnWallFromPoint(wall, pt);
  const len = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
  if (off < -tol || off > len + tol) return false;
  const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
  const len2 = Math.hypot(dx, dz);
  if (len2 < 1) return true;
  const ux = dx / len2, uz = dz / len2;
  const px = wall.start.x + ux * off;
  const pz = wall.start.z + uz * off;
  return Math.hypot(px - pt.x, pz - pt.z) < tol;
}

function _syntheticWallFromInterval(interval, template) {
  let start, end;
  if (interval.kind === 'H') {
    start = { x: interval.min, z: interval.fixed };
    end = { x: interval.max, z: interval.fixed };
  } else if (interval.kind === 'V') {
    start = { x: interval.fixed, z: interval.min };
    end = { x: interval.fixed, z: interval.max };
  } else {
    return { ...template };
  }
  return {
    ...template,
    start,
    end,
  };
}

function _spansTouchOrOverlap(a, b, tol = 5) {
  return a.min <= b.max + tol && b.min <= a.max + tol;
}

function _openingsForChain(floor, chainWalls, renderWall) {
  const seen = new Set();
  const wallIds = new Set(chainWalls.map((w) => w.id));
  const edgeKeys = new Set(chainWalls.map((w) => wallEdgeKeyFromWall(w)));
  const ops = [];
  for (const op of floor.openings || []) {
    if (seen.has(op.id)) continue;
    const ref = floor.walls.find((w) => w.id === op.wallId);
    let include = false;
    if (ref && (wallIds.has(ref.id) || edgeKeys.has(wallEdgeKeyFromWall(ref)))) {
      include = true;
    } else if (op.wallEdgeKey && edgeKeys.has(op.wallEdgeKey)) {
      include = true;
    } else if (ref) {
      const pt = openingWorldPoint(ref, op);
      include = _pointOnWallSegment(renderWall, pt);
    }
    if (!include) continue;
    seen.add(op.id);
    ops.push({
      ...op,
      offsetMM: openingOffsetOnWall(op, floor, renderWall),
    });
  }
  return ops.sort((a, b) => a.offsetMM - b.offsetMM);
}

/** 同一直線上でつながる壁を結合して 3D 描画用リストを作る */
export function wallsToRender(floor) {
  const floorOnlyIds = new Set(
    (floor.rooms || []).filter(isFloorOnlyRoom).map((r) => r.id),
  );
  const outdoorIds = new Set(
    (floor.rooms || []).filter(isOutdoorRoom).map((r) => r.id),
  );
  const active = (floor.walls || []).filter((w) => {
    if (isWallEdgeRemoved(floor, w)) return false;
    const rid = inferWallRoomId(w);
    return !rid || !floorOnlyIds.has(rid);
  });
  const diagChains = [];
  const lineGroups = new Map();

  for (const wall of active) {
    const span = _wallSpan(wall);
    if (span.kind === 'D') {
      diagChains.push({
        wall,
        ops: _openingsForChain(floor, [wall], wall),
      });
      continue;
    }
    // 高さの違う壁（バルコニーの手すり壁と居室の壁など）は同じ直線上でも合成しない
    const gkey = `${span.kind}:${span.fixed}:${wall.heightMM ?? ''}`;
    if (!lineGroups.has(gkey)) lineGroups.set(gkey, []);
    lineGroups.get(gkey).push(span);
  }

  const result = [...diagChains];

  for (const spans of lineGroups.values()) {
    spans.sort((a, b) => a.min - b.min);
    const merged = [];
    for (const s of spans) {
      const prev = merged[merged.length - 1];
      if (!prev || !_spansTouchOrOverlap(prev, s)) {
        merged.push({ kind: s.kind, fixed: s.fixed, min: s.min, max: s.max, walls: [s.wall] });
      } else {
        prev.min = Math.min(prev.min, s.min);
        prev.max = Math.max(prev.max, s.max);
        prev.walls.push(s.wall);
      }
    }
    for (const interval of merged) {
      // 合成後の壁に付く部屋は、屋内の部屋を優先する（バルコニーの名が付くと日射の遮蔽から外れてしまうため）
      const template = interval.walls.find((w) => !outdoorIds.has(inferWallRoomId(w))) || interval.walls[0];
      const renderWall = _syntheticWallFromInterval(interval, template);
      result.push({
        wall: renderWall,
        ops: _openingsForChain(floor, interval.walls, renderWall),
      });
    }
  }

  return result;
}

// 部屋ポリゴンの外周に沿って壁セグメントを生成する（MVP）。
export function wallsFromPolygon(polygon, {
  thicknessMM = DEFAULT_WALL_THICKNESS_MM,
  heightMM = DEFAULT_CEILING_MM,
} = {}) {
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

// フロアの壁を全部屋ポリゴンから作り直す。
// 壁IDは "w_${roomId}_${edgeIndex}" と決定論的に付与するため
// openings の wallId が再生成後も有効であり続ける。
export function rebuildFloorWalls(floor, plan = null) {
  const oldWalls = (floor.walls || []).slice();
  const walls = [];
  for (const room of floor.rooms) {
    if (isFloorOnlyRoom(room)) continue;
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      walls.push({
        id: `w_${room.id}_${i}`,
        roomId: room.id,
        start: { x: a.x, z: a.z },
        end: { x: b.x, z: b.z },
        thicknessMM: 120,
        heightMM: floor.ceilingHeightMM,
      });
    }
  }

  const tmpFloor = { ...floor, walls };
  const exterior = classifyExteriorWalls(tmpFloor, plan);
  for (const wall of walls) {
    const matched = _findMatchingOldWall(oldWalls, wall);
    if (matched && typeof matched.thicknessMM === 'number') {
      wall.thicknessMM = matched.thicknessMM;
    } else {
      wall.thicknessMM = wallThicknessPreset(plan, exterior.get(wall.id));
    }
  }
  floor.walls = walls;
  applyWallHeights(floor);
  remapOpeningWallIds(floor, oldWalls);
  pruneRemovedWallEdges(floor);
  syncStairWallOpenings(floor);
}

// ポリゴン全体を平行移動
export function translatePolygon(polygon, dx, dz) {
  return polygon.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz }));
}

// ---- 既定データ -------------------------------------------------------------
export function defaultFloor(id, level) {
  return {
    id,
    level,
    ceilingHeightMM: DEFAULT_CEILING_MM,
    rooms: [],
    walls: [],
    openings: [], // フェーズAでは空（スキーマのみ）
    removedWallEdges: [], // 消去済み壁辺（edgeKey の配列）
    furniture: [],
    stairs: [],   // 独立した階段カテゴリ
    partitions: [], // 追加壁（間口の逆：1P 等の独立壁段）
  };
}

/** 追加壁の端点（世界座標 mm） */
export function partitionEndpoints(p) {
  const rad = (p.rotationDeg || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = p.lengthMM / 2;
  return {
    start: { x: p.x - cos * hw, z: p.z - sin * hw },
    end: { x: p.x + cos * hw, z: p.z + sin * hw },
  };
}

export function createEmptyPlan(name = '新しいプラン') {
  const now = Date.now();
  return {
    meta: {
      name,
      schemaVersion: 1,
      unitMM: P_MM,
      snapDivisions: 4,
      tatamiM2: 1.62,
      createdAt: now,
      updatedAt: now,
      // 日射計算用の緯度経度（既定: 板橋区赤塚）。将来変更可能。
      lat: 35.775,
      lng: 139.679,
      constructionMethod: 'two_by_six',
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

export function getFloorByLevel(plan, level) {
  return plan.floors.find((f) => f.level === level) || null;
}

/** 1つ下の階 */
export function getLowerFloor(plan, floorId) {
  const cur = plan.floors.find((f) => f.id === floorId);
  if (!cur) return null;
  return getFloorByLevel(plan, cur.level - 1);
}

/** 1つ上の階 */
export function getUpperFloor(plan, floorId) {
  const cur = plan.floors.find((f) => f.id === floorId);
  if (!cur) return null;
  return getFloorByLevel(plan, cur.level + 1);
}

/**
 * 階段ローカル辺インデックス（editor2d の _stairEdgeAt と同じ）
 * 0 = −Z（上り先）, 1 = +X, 2 = +Z（登り口）, 3 = −X
 */
export function stairOpenEdgeIndices(stair) {
  const type = stair.type || 'straight';
  switch (type) {
    case 'l_shape': return [2, 3];       // 登り口 +Z / 出口 −X
    case 'u_shape': return [0, 2];       // 出口 −Z / 登り口 +Z
    case 'winding': return [0, 2];
    case 'spiral': return [2];           // 登り口 +Z のみ（上階へ抜ける）
    case 'straight':
    default: return [0, 2];
  }
}

/** 階段の出入り口辺を世界座標の線分で返す */
export function stairOpenEdgeSegments(stair) {
  const corners = stairFootprintCorners(stair);
  return stairOpenEdgeIndices(stair).map((i) => ({
    start: corners[i],
    end: corners[(i + 1) % 4],
  }));
}

/** 壁と階段出入り口辺の重なり（あれば offsetMM / widthMM） */
function _wallOpeningOverlapForSegment(wall, seg, tolMM = 180) {
  const wdx = wall.end.x - wall.start.x;
  const wdz = wall.end.z - wall.start.z;
  const wlen = Math.hypot(wdx, wdz);
  if (wlen < 1) return null;
  const ux = wdx / wlen;
  const uz = wdz / wlen;
  const nx = -uz;
  const nz = ux;

  const proj = (p) => (p.x - wall.start.x) * ux + (p.z - wall.start.z) * uz;
  const t1 = proj(seg.start);
  const t2 = proj(seg.end);
  const segMin = Math.min(t1, t2);
  const segMax = Math.max(t1, t2);
  const overlapStart = Math.max(0, segMin);
  const overlapEnd = Math.min(wlen, segMax);
  const widthMM = overlapEnd - overlapStart;
  if (widthMM < 400) return null;

  const midT = (overlapStart + overlapEnd) / 2;
  const wallMid = {
    x: wall.start.x + ux * midT,
    z: wall.start.z + uz * midT,
  };
  const segMid = {
    x: (seg.start.x + seg.end.x) / 2,
    z: (seg.start.z + seg.end.z) / 2,
  };
  const dist = Math.abs(nx * (segMid.x - wallMid.x) + nz * (segMid.z - wallMid.z));
  if (dist > tolMM) return null;

  const halfW = widthMM / 2;
  const offsetMM = Math.max(halfW, Math.min(wlen - halfW, midT));
  return { offsetMM, widthMM: Math.min(widthMM, wlen - 1) };
}

/** 階段の出入り口に接する部屋壁へ自動間口（maguchi）を付与・更新 */
export function syncStairWallOpenings(floor) {
  const stairs = floor.stairs || [];
  const liveStairIds = new Set(stairs.map((s) => s.id));
  floor.openings = (floor.openings || []).filter(
    (op) => !op.autoStairId || liveStairIds.has(op.autoStairId),
  );

  for (const stair of stairs) {
    floor.openings = floor.openings.filter((op) => op.autoStairId !== stair.id);
    const seenEdgeKeys = new Set();
    for (const seg of stairOpenEdgeSegments(stair)) {
      for (const wall of floor.walls || []) {
        if (isWallEdgeRemoved(floor, wall)) continue;
        const key = wallEdgeKeyFromWall(wall);
        if (seenEdgeKeys.has(key)) continue;
        const hit = _wallOpeningOverlapForSegment(wall, seg);
        if (!hit) continue;
        seenEdgeKeys.add(key);
        floor.openings.push({
          id: uid('op'),
          type: 'maguchi',
          wallId: wall.id,
          wallEdgeKey: key,
          offsetMM: hit.offsetMM,
          widthMM: hit.widthMM,
          sillMM: 0,
          heightMM: floor.ceilingHeightMM || 2400,
          autoStairId: stair.id,
        });
      }
    }
  }
}

/** 階段の回転矩形フットプリント（mm） */
export function stairFootprintCorners(stair) {
  const rad = (stair.rotationDeg || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = stair.widthMM / 2;
  const hd = stair.depthMM / 2;
  return [
    { x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd },
  ].map((p) => ({
    x: stair.x + p.x * cos - p.z * sin,
    z: stair.z + p.x * sin + p.z * cos,
  }));
}

/** 下階から上階へ突き抜ける階段の高さ（mm） */
export function stairRiseHeightMM(sourceFloor, upperFloor) {
  const rise = sourceFloor?.ceilingHeightMM || 2400;
  if (!upperFloor) return rise;
  return rise;
}

// 後付けのスキーマ補完（古いJSONを読み込んだとき用）
export function normalizePlan(plan) {
  const base = createEmptyPlan(plan?.meta?.name || 'プラン');
  const out = {
    meta: { ...base.meta, ...(plan.meta || {}) },
    site: {
      ...base.site,
      ...(plan.site || {}),
      backgroundImage: plan.site?.backgroundImage
        ? normalizeBackgroundImage(plan.site.backgroundImage)
        : (plan.site?.backgroundImage ?? null),
    },
    floors: Array.isArray(plan.floors) && plan.floors.length ? plan.floors : base.floors,
    exterior: Array.isArray(plan.exterior) ? plan.exterior : [],
  };
  if (!out.meta.createdAt) out.meta.createdAt = Date.now();
  if (!out.meta.updatedAt) out.meta.updatedAt = out.meta.createdAt;
  if (out.meta.constructionMethod !== 'post_and_beam') {
    out.meta.constructionMethod = 'two_by_six';
  }
  out.floors = out.floors.map((f) => ({
    id: f.id,
    level: f.level ?? 0,
    ceilingHeightMM: f.ceilingHeightMM ?? 2400,
    rooms: Array.isArray(f.rooms) ? f.rooms : [],
    walls: Array.isArray(f.walls) ? f.walls : [],
    openings: Array.isArray(f.openings) ? f.openings : [],
    removedWallEdges: Array.isArray(f.removedWallEdges) ? f.removedWallEdges : [],
    furniture: Array.isArray(f.furniture) ? f.furniture : [],
    stairs: Array.isArray(f.stairs) ? f.stairs : [],
    partitions: Array.isArray(f.partitions) ? f.partitions : [],
  }));
  ensureWallRoomIds(out);
  for (const floor of out.floors) {
    if (!floor.rooms.length) continue;
    const missingRoomId = floor.walls.some((w) => !w.roomId);
    const wrongCount = floor.rooms.some((r) =>
      floor.walls.filter((w) => inferWallRoomId(w) === r.id).length !== r.polygon.length,
    );
    if (!missingRoomId && !wrongCount) continue;
    const oldWalls = floor.walls.slice();
    rebuildFloorWalls(floor, out);
    remapOpeningWallIds(floor, oldWalls);
  }
  for (const floor of out.floors) {
    applyWallHeights(floor);
    for (const op of floor.openings || []) {
      if (op.wallEdgeKey) continue;
      const w = floor.walls.find((wl) => wl.id === op.wallId);
      if (w) op.wallEdgeKey = wallEdgeKeyFromWall(w);
    }
  }
  return out;
}

/** site.backgroundImage の正規化（既存 null はそのまま） */
export function normalizeBackgroundImage(raw) {
  if (!raw || typeof raw !== 'object' || !raw.dataUrl) return null;
  const scale = raw.scaleMMperPx;
  return {
    dataUrl: raw.dataUrl,
    naturalWidthPx: raw.naturalWidthPx ?? 0,
    naturalHeightPx: raw.naturalHeightPx ?? 0,
    scaleMMperPx: typeof scale === 'number' && scale > 0 ? scale : null,
    offsetX: raw.offsetX ?? 0,
    offsetZ: raw.offsetZ ?? 0,
    rotationDeg: raw.rotationDeg ?? 0,
    opacity: typeof raw.opacity === 'number' ? raw.opacity : 0.5,
    visible: raw.visible !== false,
  };
}

/** 敷地写真が実寸スケール済みか */
export function isBackgroundImageScaled(bg) {
  return !!(bg && typeof bg.scaleMMperPx === 'number' && bg.scaleMMperPx > 0);
}

/** 壁に roomId が無い古いデータ向けに ID パターン w_{roomId}_{edge} から復元 */
export function inferWallRoomId(wall) {
  if (wall?.roomId) return wall.roomId;
  const m = wall?.id?.match(/^w_(.+)_\d+$/);
  return m ? m[1] : null;
}

/** 全フロアの壁 roomId を補完（開口紐付け用） */
export function ensureWallRoomIds(plan) {
  for (const floor of plan.floors || []) {
    for (const wall of floor.walls || []) {
      if (!wall.roomId) {
        const rid = inferWallRoomId(wall);
        if (rid) wall.roomId = rid;
      }
    }
  }
}
