// parkingSim.js — 駐車シミュレーターの純粋幾何（DOM/Three.js 非依存。tests/parkingSim.test.mjs）
//
// 座標は図面と同じ mm（X=右, Z=下）。車の姿勢 pose = { x, z, th } は「後輪の車軸の中心」と向き。
// th は X 軸から測った角度で、画面上は時計回りが正（Z が下向きのため）。前進方向 = (cos th, sin th)。
// 曲率 k (1/mm) は前進時に th が増える向き（画面で右へ曲がる）を正とする。

/** 道路を描く・障害物にするときに、敷地の辺から左右へ延ばす長さ（mm） */
export const ROAD_EXTEND_MM = 30000;
/** 1 回の計算で進む距離の上限（mm）。これより長い移動は分けて当たり判定する */
export const SIM_STEP_MM = 40;
export const DEFAULT_ROAD_WIDTH_MM = 4000;

/**
 * 車の諸元（mm）。最小回転半径はカタログ値（外側前輪の軌跡）。
 * 前後のオーバーハングは公表値が無いものは全長−ホイールベースを按分した概算。
 */
export const VEHICLE_PRESETS = [
  { id: 'glb2020', name: 'ベンツ GLB（2020・FF）', lengthMM: 4640, widthMM: 1835, wheelbaseMM: 2830, frontOverhangMM: 900, rearOverhangMM: 910, treadMM: 1605, minTurnRadiusMM: 5500, color: '#2f5f9e' },
  { id: 'alto2021', name: 'スズキ アルト（現行）', lengthMM: 3395, widthMM: 1475, wheelbaseMM: 2460, frontOverhangMM: 520, rearOverhangMM: 415, treadMM: 1295, minTurnRadiusMM: 4400, color: '#d0802a' },
  { id: 'suvGeneric', name: '一般的なSUV', lengthMM: 4650, widthMM: 1840, wheelbaseMM: 2700, frontOverhangMM: 950, rearOverhangMM: 1000, treadMM: 1580, minTurnRadiusMM: 5500, color: '#555c66' },
  { id: 'keiGeneric', name: '一般的な軽自動車', lengthMM: 3395, widthMM: 1475, wheelbaseMM: 2460, frontOverhangMM: 520, rearOverhangMM: 415, treadMM: 1300, minTurnRadiusMM: 4500, color: '#7a8b3a' },
];

export function getVehiclePreset(id) {
  return VEHICLE_PRESETS.find((v) => v.id === id) || VEHICLE_PRESETS[0];
}

/** 後輪車軸の中心が描く円の最小半径（mm） */
export function rearAxleMinRadiusMM(v) {
  const R = v.minTurnRadiusMM, L = v.wheelbaseMM;
  const r = Math.sqrt(Math.max(R * R - L * L, 1)) - v.treadMM / 2;
  return Math.max(r, 500);
}

/** ハンドルをいっぱいに切ったときの曲率（1/mm） */
export function maxCurvature(v) {
  return 1 / rearAxleMinRadiusMM(v);
}

/** 曲率に対応する前輪の切れ角（ラジアン。自転車モデルの等価角） */
export function steerAngleForCurvature(v, k) {
  return Math.atan(v.wheelbaseMM * k);
}

/** pose から曲率 k で ds（mm。負なら後退）だけ進んだ姿勢（厳密な円弧） */
export function stepPose(pose, k, ds) {
  const { x, z, th } = pose;
  if (Math.abs(k) < 1e-12) {
    return { x: x + ds * Math.cos(th), z: z + ds * Math.sin(th), th };
  }
  const th2 = th + k * ds;
  return {
    x: x + (Math.sin(th2) - Math.sin(th)) / k,
    z: z - (Math.cos(th2) - Math.cos(th)) / k,
    th: th2,
  };
}

/** 車体の四隅 [右前, 左前, 左後, 右後]（「右」は進行方向に向かって右） */
export function carCorners(pose, v) {
  const c = Math.cos(pose.th), s = Math.sin(pose.th);
  const f = v.wheelbaseMM + v.frontOverhangMM;
  const r = -v.rearOverhangMM;
  const h = v.widthMM / 2;
  // 進行方向 (c, s) の右は画面上 (-s, c)
  const at = (lx, ly) => ({ x: pose.x + lx * c - ly * s, z: pose.z + lx * s + ly * c });
  return [at(f, h), at(f, -h), at(r, -h), at(r, h)];
}

/** 4 輪の中心と向き（描画用）。前輪は曲率 k に応じた切れ角 */
export function wheelPoses(pose, v, k) {
  const c = Math.cos(pose.th), s = Math.sin(pose.th);
  const h = v.treadMM / 2;
  const at = (lx, ly) => ({ x: pose.x + lx * c - ly * s, z: pose.z + lx * s + ly * c });
  const steer = steerAngleForCurvature(v, k);
  return [
    { ...at(v.wheelbaseMM, h), th: pose.th + steer },
    { ...at(v.wheelbaseMM, -h), th: pose.th + steer },
    { ...at(0, -h), th: pose.th },
    { ...at(0, h), th: pose.th },
  ];
}

// ---- 距離・当たり判定 ----------------------------------------------------------

function closestOnSeg(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return { x: a.x + dx * t, z: a.z + dz * t };
}

function cross(ax, az, bx, bz) { return ax * bz - az * bx; }

function segmentsIntersect(p1, p2, q1, q2) {
  const d1 = cross(p2.x - p1.x, p2.z - p1.z, q1.x - p1.x, q1.z - p1.z);
  const d2 = cross(p2.x - p1.x, p2.z - p1.z, q2.x - p1.x, q2.z - p1.z);
  const d3 = cross(q2.x - q1.x, q2.z - q1.z, p1.x - q1.x, p1.z - q1.z);
  const d4 = cross(q2.x - q1.x, q2.z - q1.z, p2.x - q1.x, p2.z - q1.z);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** 線分 p1p2 と q1q2 の最短距離と、そのときの両側の点 { d, p, q } */
export function segmentClosest(p1, p2, q1, q2) {
  if (segmentsIntersect(p1, p2, q1, q2)) {
    // 交点を求めて両側の点にする
    const rx = p2.x - p1.x, rz = p2.z - p1.z, sx = q2.x - q1.x, sz = q2.z - q1.z;
    const den = cross(rx, rz, sx, sz) || 1e-12;
    const t = cross(q1.x - p1.x, q1.z - p1.z, sx, sz) / den;
    const pt = { x: p1.x + rx * t, z: p1.z + rz * t };
    return { d: 0, p: pt, q: pt };
  }
  let best = null;
  const tryPair = (p, q) => {
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (!best || d < best.d) best = { d, p, q };
  };
  tryPair(p1, closestOnSeg(p1, q1, q2));
  tryPair(p2, closestOnSeg(p2, q1, q2));
  tryPair(closestOnSeg(q1, p1, p2), q1);
  tryPair(closestOnSeg(q2, p1, p2), q2);
  return best;
}

function pointInConvex(pt, poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = cross(b.x - a.x, b.z - a.z, pt.x - a.x, pt.z - a.z);
    if (Math.abs(c) < 1e-9) continue;
    const sg = Math.sign(c);
    if (sign === 0) sign = sg;
    else if (sg !== sign) return false;
  }
  return true;
}

/**
 * 車体（四隅）と障害物の線分群の最短距離。
 * @returns {{ d: number, p: {x,z}, q: {x,z}, index: number } | null}  d=0 は接触・めり込み
 */
export function carClearance(corners, obstacles) {
  let best = null;
  for (let j = 0; j < obstacles.length; j++) {
    const o = obstacles[j];
    for (const end of [o.a, o.b]) {
      if (pointInConvex(end, corners)) return { d: 0, p: end, q: end, index: j };
    }
    for (let i = 0; i < 4; i++) {
      const r = segmentClosest(corners[i], corners[(i + 1) % 4], o.a, o.b);
      if (!best || r.d < best.d) best = { ...r, index: j };
      if (best.d === 0) return best;
    }
  }
  return best;
}

// ---- 道路 ----------------------------------------------------------------------

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > pt.z) !== (b.z > pt.z)
      && pt.x < ((b.x - a.x) * (pt.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** plan.site.road を正規化（不正なら null） */
export function normalizeRoad(road, boundary) {
  if (!road || !Array.isArray(boundary) || boundary.length < 3) return null;
  const edgeIndex = Number(road.edgeIndex);
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= boundary.length) return null;
  const widthMM = Number(road.widthMM) > 0 ? Number(road.widthMM) : DEFAULT_ROAD_WIDTH_MM;
  const guardrails = (Array.isArray(road.guardrails) ? road.guardrails : [])
    .filter((g) => g && g.a && g.b && Number.isFinite(g.a.x) && Number.isFinite(g.b.x))
    .map((g) => ({ id: g.id || `gr_${Math.random().toString(36).slice(2, 9)}`, a: { x: g.a.x, z: g.a.z }, b: { x: g.b.x, z: g.b.z }, enabled: g.enabled !== false }));
  return {
    edgeIndex,
    widthMM,
    guardrails,
    vehicleId: getVehiclePreset(road.vehicleId).id,
    neighborFrontWalls: road.neighborFrontWalls !== false,
    usePlanObstacles: road.usePlanObstacles !== false,
  };
}

/**
 * 敷地の辺 edgeIndex を前面道路としたときの形。
 * a→b が敷地の辺、out は敷地から道路へ向かう単位法線、dir は a→b の単位ベクトル。
 */
export function roadGeometry(boundary, edgeIndex, widthMM) {
  const a = boundary[edgeIndex];
  const b = boundary[(edgeIndex + 1) % boundary.length];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 1) return null;
  const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  let out = { x: dir.z, z: -dir.x };
  const probe = { x: (a.x + b.x) / 2 + out.x * 50, z: (a.z + b.z) / 2 + out.z * 50 };
  if (pointInPolygon(probe, boundary)) out = { x: -out.x, z: -out.z };
  const E = ROAD_EXTEND_MM;
  const ext = (p, t, n) => ({ x: p.x + dir.x * t + out.x * n, z: p.z + dir.z * t + out.z * n });
  return {
    a, b, dir, out, len, widthMM,
    nearStart: ext(a, -E, 0), nearEnd: ext(b, E, 0),
    farStart: ext(a, -E, widthMM), farEnd: ext(b, E, widthMM),
    /** 道路上の点 → { s: 辺の始点 a からの道路沿いの距離, n: 境界線から道路側への距離 } */
    toLocal: (p) => ({
      s: (p.x - a.x) * dir.x + (p.z - a.z) * dir.z,
      n: (p.x - a.x) * out.x + (p.z - a.z) * out.z,
    }),
    fromLocal: (s, n) => ext(a, s, n),
  };
}

/**
 * ガードレールの位置を道路に対して表す。
 * gapMM: 敷地の間口の端（近いほうの角）から、ガードレールの近いほうの端までの道路沿いの距離。
 *        正なら間口の外（敷地の前にかかっていない）、負なら敷地の前にかかっている長さ。
 * offsetMM: 境界線から道路側への距離（両端の平均）。
 */
export function guardrailRelation(g, geo) {
  const la = geo.toLocal(g.a), lb = geo.toLocal(g.b);
  const s0 = Math.min(la.s, lb.s), s1 = Math.max(la.s, lb.s);
  const overlap = Math.min(s1, geo.len) - Math.max(s0, 0);
  // 近いほうの角：ガードレールの中央が間口の中央より始点側か終点側か
  const side = (s0 + s1) / 2 < geo.len / 2 ? 'start' : 'end';
  let gapMM;
  if (overlap > 0) gapMM = -overlap;
  else gapMM = side === 'start' ? -s1 : s0 - geo.len;
  return { gapMM, side, offsetMM: (la.n + lb.n) / 2 };
}

/**
 * 当たり判定に使う線分の一覧 [{ a, b, kind, label }]
 * @param {object} p
 * @param {{x,z}[]} p.boundary 敷地
 * @param {object|null} p.geo roadGeometry の結果
 * @param {number} [p.roadEdgeIndex] 前面道路にした敷地の辺（障害物から外す）
 * @param {object[]} p.guardrails 有効なガードレール
 * @param {{a,b}[]} [p.buildingSegs] 建物の外壁
 * @param {{x,z}[][]} [p.vehicleRects] 配置済みの車（四隅）
 * @param {boolean} [p.neighborFrontWalls] 隣地の道路沿いを塀として扱う
 */
export function buildObstacles({ boundary, geo, roadEdgeIndex = -1, guardrails = [], buildingSegs = [], vehicleRects = [], neighborFrontWalls = true }) {
  const obs = [];
  const n = boundary.length;
  const roadEdge = geo ? roadEdgeIndex : -1;
  for (let i = 0; i < n; i++) {
    if (i === roadEdge) continue;
    obs.push({ a: boundary[i], b: boundary[(i + 1) % n], kind: 'site', label: '敷地境界' });
  }
  if (geo) {
    obs.push({ a: geo.farStart, b: geo.farEnd, kind: 'roadFar', label: '道路の向かい側' });
    if (neighborFrontWalls) {
      obs.push({ a: geo.nearStart, b: geo.a, kind: 'neighbor', label: '隣地（道路沿い）' });
      obs.push({ a: geo.b, b: geo.nearEnd, kind: 'neighbor', label: '隣地（道路沿い）' });
    }
  }
  for (const g of guardrails) obs.push({ a: g.a, b: g.b, kind: 'guardrail', label: 'ガードレール', id: g.id });
  for (const s of buildingSegs) obs.push({ a: s.a, b: s.b, kind: 'building', label: '建物' });
  for (const r of vehicleRects) {
    for (let i = 0; i < r.length; i++) obs.push({ a: r[i], b: r[(i + 1) % r.length], kind: 'vehicle', label: '駐車中の車' });
  }
  return obs;
}

/** 道路上の初期位置：敷地の手前（辺の始点側）で、道路の中ほどを道路に沿って進む向き */
export function initialPose(geo, v, fromStart = true) {
  const n = Math.min(geo.widthMM * 0.35, geo.widthMM - v.widthMM / 2 - 300);
  const lane = Math.max(v.widthMM / 2 + 300, n);
  if (fromStart) {
    const p = geo.fromLocal(-(v.lengthMM + 1500), lane);
    return { x: p.x, z: p.z, th: Math.atan2(geo.dir.z, geo.dir.x) };
  }
  const p = geo.fromLocal(geo.len + v.lengthMM + 1500, lane);
  return { x: p.x, z: p.z, th: Math.atan2(-geo.dir.z, -geo.dir.x) };
}

/**
 * 記録した進み方（+1 前進 / -1 後退）の列から、向きを変えた回数と切り返し回数を数える。
 * 「前進で通り過ぎて、後退で入れる」までを 1 回の動作とみなし、それ以降の向きの切り替えを切り返しとする。
 */
export function countDirectionChanges(dirs) {
  let changes = 0, prev = 0;
  for (const d of dirs) {
    if (!d) continue;
    if (prev && d !== prev) changes++;
    prev = d;
  }
  return { changes, kirikaeshi: Math.max(0, changes - 1) };
}

/**
 * pose から曲率 k で dist（負なら後退）だけ動かす。途中でぶつかったら、その手前で止める。
 * @returns {{ poses: object[], hit: object|null, minClear: object|null }}
 */
export function driveWithCollision(pose, v, k, dist, obstacles, stopOnHit = true) {
  const n = Math.max(1, Math.ceil(Math.abs(dist) / SIM_STEP_MM));
  const ds = dist / n;
  const poses = [];
  let cur = pose, hit = null, minClear = null;
  for (let i = 0; i < n; i++) {
    const next = stepPose(cur, k, ds);
    const cl = carClearance(carCorners(next, v), obstacles);
    if (cl && cl.d <= 0) {
      hit = cl;
      if (stopOnHit) break;
    }
    if (cl && (!minClear || cl.d < minClear.d)) minClear = cl;
    poses.push(next);
    cur = next;
  }
  return { poses, hit, minClear };
}
