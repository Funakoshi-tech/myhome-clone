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

// フロアの壁を全部屋ポリゴンから作り直す。
// 壁IDは "w_${roomId}_${edgeIndex}" と決定論的に付与するため
// openings の wallId が再生成後も有効であり続ける。
export function rebuildFloorWalls(floor) {
  const walls = [];
  for (const room of floor.rooms) {
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      walls.push({
        id: `w_${room.id}_${i}`,
        roomId: room.id,          // opening 紐付け用（スキーマ拡張）
        start: { x: a.x, z: a.z },
        end: { x: b.x, z: b.z },
        thicknessMM: 120,
        heightMM: floor.ceilingHeightMM,
      });
    }
  }
  floor.walls = walls;
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
    ceilingHeightMM: 2400,
    rooms: [],
    walls: [],
    openings: [], // フェーズAでは空（スキーマのみ）
    furniture: [],
    stairs: [],   // 独立した階段カテゴリ
  };
}

export function createEmptyPlan(name = '新しいプラン') {
  const now = Date.now();
  return {
    meta: {
      name,
      schemaVersion: 1,
      unitMM: 910,
      snapDivisions: 4,
      tatamiM2: 1.62,
      createdAt: now,
      updatedAt: now,
      // 日射計算用の緯度経度（既定: 板橋区赤塚）。将来変更可能。
      lat: 35.775,
      lng: 139.679,
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
  out.floors = out.floors.map((f) => ({
    id: f.id,
    level: f.level ?? 0,
    ceilingHeightMM: f.ceilingHeightMM ?? 2400,
    rooms: Array.isArray(f.rooms) ? f.rooms : [],
    walls: Array.isArray(f.walls) ? f.walls : [],
    openings: Array.isArray(f.openings) ? f.openings : [],
    furniture: Array.isArray(f.furniture) ? f.furniture : [],
    stairs: Array.isArray(f.stairs) ? f.stairs : [],
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
    rebuildFloorWalls(floor);
    for (const op of floor.openings) {
      const ow = oldWalls.find((w) => w.id === op.wallId);
      if (!ow) continue;
      const match = (a, b) =>
        (a.start.x === b.start.x && a.start.z === b.start.z && a.end.x === b.end.x && a.end.z === b.end.z)
        || (a.start.x === b.end.x && a.start.z === b.end.z && a.end.x === b.start.x && a.end.z === b.start.z);
      const owRoom = inferWallRoomId(ow);
      const nw = floor.walls.find((w) => match(w, ow) && inferWallRoomId(w) === owRoom);
      if (nw) op.wallId = nw.id;
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
