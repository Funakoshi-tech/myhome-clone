// heightLimit.js — 北側斜線・高度地区の高さ制限（DOM/Three.js 非依存の純粋関数）
//
// 土地探しの目安として、階ごとに「北端から何 m 離せば置けるか」を求める。
// 各階の高さは「低め（赤）」と「標準（黄）」の 2 組を持ち、低めでも超える範囲 = ほぼ確実に置けない、
// 標準だと超える範囲 = 工夫しだいで入るかもしれない、として扱う（入るのに入らないと出ないよう余白は既定 0）。
//
// 座標は図面座標（mm、x = 右、z = 下）。d は「真北方向の水平距離」（境界に垂直な距離ではない）。
// 高さは地盤面からの mm。
//
// plan.site.heightLimit = {
//   enabled, zoneId, lowRiseAbsMaxMM, shadowRegulated,
//   district: { city, kind, maxHeightMM, custom },
//   build: { low: { groundToFirstFloorMM, storyHeightsMM: [] }, standard: { ... } },
//   marginMM, show: { contour2d },
// }

// ─── 斜線の式（segments） ─────────────────────────────
// H(d) = baseMM + slope × (d − fromMM)（fromMM ≤ d < toMM）。toMM = null は上限なし。

/** 用途地域の北側斜線（建築基準法 56 条 1 項 3 号）。lowRise = 絶対高さ 10m/12m の対象 */
export const ZONE_PRESETS = [
  { id: 'tei1', name: '第一種低層住居専用地域', lowRise: true, north: [{ fromMM: 0, toMM: null, baseMM: 5000, slope: 1.25 }] },
  { id: 'tei2', name: '第二種低層住居専用地域', lowRise: true, north: [{ fromMM: 0, toMM: null, baseMM: 5000, slope: 1.25 }] },
  { id: 'denen', name: '田園住居地域', lowRise: true, north: [{ fromMM: 0, toMM: null, baseMM: 5000, slope: 1.25 }] },
  // 中高層: 日影規制の対象区域では北側斜線が適用除外になる（shadowRegulated）
  { id: 'chuko1', name: '第一種中高層住居専用地域', lowRise: false, midRise: true, north: [{ fromMM: 0, toMM: null, baseMM: 10000, slope: 1.25 }] },
  { id: 'chuko2', name: '第二種中高層住居専用地域', lowRise: false, midRise: true, north: [{ fromMM: 0, toMM: null, baseMM: 10000, slope: 1.25 }] },
  { id: 'other', name: 'その他の用途地域（北側斜線なし）', lowRise: false, north: null },
];

/** 低層系の絶対高さの選択肢 */
export const LOW_RISE_ABS_MAX_OPTIONS_MM = [10000, 12000];

/**
 * 高度地区（都市計画で区ごとに決まる）。区ごとに分けて持ち、他の区はここに 1 つ足す。
 * 板橋区: 区の都市計画決定資料（koudo20230428.pdf）の記載をもとにした。確認日 2026-11-23。
 * maxHeightOptionsMM の null は「絶対高さなし」。
 */
export const DISTRICT_PRESETS = {
  itabashi: {
    name: '板橋区',
    kinds: [
      {
        id: 'type1', name: '第1種高度地区',
        segments: [{ fromMM: 0, toMM: null, baseMM: 5000, slope: 0.6 }],
        maxHeightOptionsMM: [null, 10000, 17000],
      },
      {
        id: 'type2', name: '第2種高度地区',
        segments: [
          { fromMM: 0, toMM: 8000, baseMM: 5000, slope: 1.25 },
          { fromMM: 8000, toMM: null, baseMM: 15000, slope: 0.6 },
        ],
        maxHeightOptionsMM: [null, 17000, 22000, 30000, 35000],
      },
      {
        id: 'type3', name: '第3種高度地区',
        segments: [
          { fromMM: 0, toMM: 8000, baseMM: 10000, slope: 1.25 },
          { fromMM: 8000, toMM: null, baseMM: 20000, slope: 0.6 },
        ],
        maxHeightOptionsMM: [22000, 30000, 35000, 40000, 45000],
      },
    ],
  },
};

export const DEFAULT_CITY = 'itabashi';

/** 高度地区の種類。none = 斜線なし（絶対高さだけ指定できる）、custom = 式を直接入れる */
export const DISTRICT_KINDS = ['none', 'type1', 'type2', 'type3', 'custom'];

// ─── 各階の高さ（仮の値） ─────────────────────────────
// どちらも 2 社（ウィザースホーム・ヤマト住建）の資料の値ではない仮の値。
// low: 天井高を 2300mm 前後に抑えた場合の目安。standard: 天井高 2400mm + 床や梁の厚み約 500mm。
// storyHeightsMM[i] = (i+1) 階の床から上の階の床まで（最上階は床から軒 = 壁の上端まで）。
export const DEFAULT_BUILD = {
  low: { groundToFirstFloorMM: 400, storyHeightsMM: [2650, 2650, 2650] },
  standard: { groundToFirstFloorMM: 600, storyHeightsMM: [2900, 2900, 2900] },
};

export const MAX_GROUND_TO_FIRST_FLOOR_MM = 2000;
export const MIN_STORY_HEIGHT_MM = 1500;
export const MAX_STORY_HEIGHT_MM = 6000;
export const MAX_STORIES = 10;
export const MAX_MARGIN_MM = 3000;

/** 超過の判定の許容（丸め誤差で境目がちらつかないように） */
export const TOLERANCE_MM = 1;

// ─── 正規化 ─────────────────────────────────────────

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function cloneBuild(b) {
  return {
    low: { groundToFirstFloorMM: b.low.groundToFirstFloorMM, storyHeightsMM: b.low.storyHeightsMM.slice() },
    standard: { groundToFirstFloorMM: b.standard.groundToFirstFloorMM, storyHeightsMM: b.standard.storyHeightsMM.slice() },
  };
}

function normalizeStoryHeights(raw, fallback) {
  if (!Array.isArray(raw) || !raw.length) return fallback.slice();
  return raw.slice(0, MAX_STORIES).map((v, i) => Math.round(clampNumber(
    v, MIN_STORY_HEIGHT_MM, MAX_STORY_HEIGHT_MM, fallback[Math.min(i, fallback.length - 1)],
  )));
}

function normalizeBuildSet(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    groundToFirstFloorMM: Math.round(clampNumber(src.groundToFirstFloorMM, 0, MAX_GROUND_TO_FIRST_FLOOR_MM, fallback.groundToFirstFloorMM)),
    storyHeightsMM: normalizeStoryHeights(src.storyHeightsMM, fallback.storyHeightsMM),
  };
}

/** 直接入力の segments を検証して並べ直す（不正なら null） */
export function normalizeSegments(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const segs = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    const fromMM = Number(s.fromMM);
    const baseMM = Number(s.baseMM);
    const slope = Number(s.slope);
    if (![fromMM, baseMM, slope].every(Number.isFinite)) return null;
    if (fromMM < 0 || baseMM < 0 || slope < 0 || slope > 10) return null;
    segs.push({ fromMM: Math.round(fromMM), baseMM: Math.round(baseMM), slope });
  }
  segs.sort((a, b) => a.fromMM - b.fromMM);
  if (segs[0].fromMM !== 0) return null;
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].fromMM === segs[i - 1].fromMM) return null;
  }
  return segs.map((s, i) => ({ ...s, toMM: i + 1 < segs.length ? segs[i + 1].fromMM : null }));
}

function districtKindPreset(city, kind) {
  return DISTRICT_PRESETS[city]?.kinds.find((k) => k.id === kind) || null;
}

function normalizeDistrict(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const city = Object.hasOwn(DISTRICT_PRESETS, src.city) ? src.city : DEFAULT_CITY;
  let kind = DISTRICT_KINDS.includes(src.kind) ? src.kind : 'none';
  const preset = districtKindPreset(city, kind);
  if (kind !== 'none' && kind !== 'custom' && !preset) kind = 'none';

  let maxHeightMM = null;
  const rawMax = src.maxHeightMM === null || src.maxHeightMM === undefined ? null : Number(src.maxHeightMM);
  if (preset) {
    const opts = preset.maxHeightOptionsMM;
    maxHeightMM = opts.includes(rawMax) ? rawMax : opts[0];
  } else if (rawMax !== null && Number.isFinite(rawMax) && rawMax > 0) {
    maxHeightMM = Math.round(Math.min(Math.max(rawMax, 3000), 100000));
  }

  const custom = kind === 'custom' ? normalizeSegments(src.custom) : null;
  if (kind === 'custom' && !custom) kind = 'none';
  return { city, kind, maxHeightMM, custom };
}

/** 保存値・入力値を安全な設定にする（範囲外は既定値。旧データで undefined のときは無効の初期値） */
export function normalizeHeightLimit(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const build = src.build && typeof src.build === 'object' ? src.build : {};
  const zoneId = ZONE_PRESETS.some((z) => z.id === src.zoneId) ? src.zoneId : 'chuko1';
  const lowRiseAbsMaxMM = LOW_RISE_ABS_MAX_OPTIONS_MM.includes(Number(src.lowRiseAbsMaxMM))
    ? Number(src.lowRiseAbsMaxMM) : LOW_RISE_ABS_MAX_OPTIONS_MM[0];
  return {
    enabled: src.enabled === true,
    zoneId,
    lowRiseAbsMaxMM,
    shadowRegulated: src.shadowRegulated === true,
    district: normalizeDistrict(src.district),
    build: {
      low: normalizeBuildSet(build.low, DEFAULT_BUILD.low),
      standard: normalizeBuildSet(build.standard, DEFAULT_BUILD.standard),
    },
    marginMM: Math.round(clampNumber(src.marginMM, 0, MAX_MARGIN_MM, 0)),
    show: { contour2d: src.show?.contour2d !== false },
  };
}

/** 高さを仮の値に戻した build */
export function defaultBuild() {
  return cloneBuild(DEFAULT_BUILD);
}

// ─── 制限の計算 ───────────────────────────────────────

/** 設定から { north, district, absMaxMM } を求める。中高層で日影規制の対象なら north = null */
export function resolveRules(settings) {
  const s = normalizeHeightLimit(settings);
  const zone = ZONE_PRESETS.find((z) => z.id === s.zoneId);
  const north = zone.midRise && s.shadowRegulated ? null : zone.north;
  let district = null;
  if (s.district.kind === 'custom') district = s.district.custom;
  else if (s.district.kind !== 'none') district = districtKindPreset(s.district.city, s.district.kind)?.segments || null;
  const caps = [];
  if (zone.lowRise) caps.push(s.lowRiseAbsMaxMM);
  if (s.district.maxHeightMM !== null) caps.push(s.district.maxHeightMM);
  return { north, district, absMaxMM: caps.length ? Math.min(...caps) : Infinity };
}

/** segments の d での高さ（segments が null なら Infinity） */
export function evalSegments(segs, dMM) {
  if (!segs) return Infinity;
  const d = Math.max(0, dMM);
  let seg = segs[0];
  for (const s of segs) {
    if (d >= s.fromMM) seg = s;
  }
  return seg.baseMM + seg.slope * (d - seg.fromMM);
}

/** d での高さの上限（mm）: 2 つの斜線の低いほうと絶対高さの最小値。制限がなければ Infinity */
export function limitAtMM(rules, dMM) {
  return Math.min(evalSegments(rules.north, dMM), evalSegments(rules.district, dMM), rules.absMaxMM);
}

/** segments で高さ h 以上になる最小の d（届かなければ Infinity）。式は d とともに上がる前提 */
function segmentsInverse(segs, hMM) {
  if (!segs) return 0;
  for (const s of segs) {
    if (s.baseMM >= hMM) return s.fromMM;
    if (s.slope <= 0) {
      if (s.toMM === null) return Infinity;
      continue;
    }
    const d = s.fromMM + (hMM - s.baseMM) / s.slope;
    if (s.toMM === null || d <= s.toMM) return d;
  }
  return Infinity;
}

/** 高さ h の部分を置ける最小の d（mm）。絶対高さを超える h は Infinity */
export function minDistanceForHeightMM(rules, hMM) {
  if (hMM <= 0) return 0;
  if (hMM > rules.absMaxMM + TOLERANCE_MM) return Infinity;
  return Math.max(segmentsInverse(rules.north, hMM), segmentsInverse(rules.district, hMM));
}

// ─── 真北方向の距離 ─────────────────────────────────

/** 図面座標での北方向の単位ベクトル。azimuth = 図面の上から時計回りの度（siteOrientation.js と同じ） */
export function northDir(azimuthDeg) {
  const r = ((Number(azimuthDeg) || 0) * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > pt.z) !== (b.z > pt.z)
      && pt.x < ((b.x - a.x) * (pt.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** plan.site.road から使う分だけ取り出す（不正なら null） */
export function roadForLimit(road, boundary) {
  if (!road || !Array.isArray(boundary) || boundary.length < 3) return null;
  const edgeIndex = Number(road.edgeIndex);
  const widthMM = Number(road.widthMM);
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= boundary.length) return null;
  if (!(widthMM > 0)) return null;
  return { edgeIndex, widthMM };
}

/**
 * pt から真北へ光線を飛ばし、最初に敷地境界と交わる点までの距離 d（mm）。
 * その辺が前面道路なら、道路の反対側の境界まで（幅員を真北方向の距離に直して）足す。
 * 敷地の外の点は null。
 */
export function northDistanceMM(pt, boundary, azimuthDeg, road = null) {
  if (!Array.isArray(boundary) || boundary.length < 3 || !pointInPolygon(pt, boundary)) return null;
  const n = northDir(azimuthDeg);
  let best = Infinity;
  let bestEdge = -1;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i];
    const b = boundary[(i + 1) % boundary.length];
    const ex = b.x - a.x, ez = b.z - a.z;
    const denom = n.x * ez - n.z * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const ax = a.x - pt.x, az = a.z - pt.z;
    const t = (ax * ez - az * ex) / denom; // 光線上の距離
    const u = (ax * n.z - az * n.x) / denom; // 辺上の位置（0〜1）
    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) {
      best = t;
      bestEdge = i;
    }
  }
  if (bestEdge < 0) return null;
  let dMM = best;
  if (road && road.edgeIndex === bestEdge) {
    const a = boundary[bestEdge];
    const b = boundary[(bestEdge + 1) % boundary.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > 0) {
      // 光線が出ていく辺なので、北と外向き法線の内積は正
      const cos = Math.abs((n.x * (b.z - a.z) - n.z * (b.x - a.x)) / len);
      if (cos > 1e-6) dMM += road.widthMM / cos;
    }
  }
  return { dMM, edgeIndex: bestEdge };
}

/** 計算に使う文脈。site = plan.site */
export function makeContext(site, settings) {
  const boundary = Array.isArray(site?.boundary) ? site.boundary : [];
  return {
    boundary,
    azimuth: Number(site?.azimuth) || 0,
    road: roadForLimit(site?.road, boundary),
    rules: resolveRules(settings ?? site?.heightLimit),
  };
}

/** 点ごとの上限。敷地の外は null */
export function heightLimitAtPoint(pt, ctx) {
  const hit = northDistanceMM(pt, ctx.boundary, ctx.azimuth, ctx.road);
  if (!hit) return null;
  return { limitMM: limitAtMM(ctx.rules, hit.dMM), dMM: hit.dMM };
}

// ─── 各階の高さ ───────────────────────────────────────

/** 地盤面からその階（level = 0 が 1 階）の壁上端までの高さ（mm）。ceilingHeightMM は使わない */
export function floorTopMM(buildSet, level) {
  const hs = buildSet.storyHeightsMM;
  let top = buildSet.groundToFirstFloorMM;
  for (let i = 0; i <= level; i++) top += hs[Math.min(i, hs.length - 1)];
  return top;
}

/** 北側道路とみなす下限: 道路の外向き法線と真北のなす角の余弦（60° 以内） */
export const NORTH_ROAD_MIN_COS = 0.5;

/**
 * 前面道路が北側にあるとき、敷地の北端から道路の反対側の境界までの真北方向の距離。
 * → { widthMM, offsetMM }（offsetMM = 幅員 ÷ 余弦）。北側に道路がなければ null。
 * 道路が真北から 60° より大きく傾いている（東西向きに近い）ときは北側道路として扱わない。
 */
export function northRoadOffset(site) {
  const boundary = Array.isArray(site?.boundary) ? site.boundary : [];
  const road = roadForLimit(site?.road, boundary);
  if (!road) return null;
  const a = boundary[road.edgeIndex];
  const b = boundary[(road.edgeIndex + 1) % boundary.length];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 1) return null;
  let out = { x: (b.z - a.z) / len, z: -(b.x - a.x) / len };
  const probe = { x: (a.x + b.x) / 2 + out.x * 50, z: (a.z + b.z) / 2 + out.z * 50 };
  if (pointInPolygon(probe, boundary)) out = { x: -out.x, z: -out.z };
  const n = northDir(site.azimuth);
  const cos = out.x * n.x + out.z * n.z;
  if (cos < NORTH_ROAD_MIN_COS) return null;
  return { widthMM: road.widthMM, offsetMM: road.widthMM / cos };
}

/**
 * 階ごとに、低め・標準それぞれの壁上端（余白込み）と北端から必要な距離。
 * minDistanceMM = 斜線の起点（北側が隣地なら敷地境界、道路なら道路の反対側の境界）からの距離。
 * fromSiteMM = 敷地の北端からの距離（北側道路があれば道路の分を引く。0 = どこでも置ける）。
 * → [{ level, low: { topMM, checkMM, minDistanceMM, fromSiteMM }, standard: { ... } }]（level の昇順）
 */
export function floorClearances(plan, settings) {
  const s = normalizeHeightLimit(settings ?? plan?.site?.heightLimit);
  const rules = resolveRules(s);
  const roadOffsetMM = northRoadOffset(plan?.site)?.offsetMM || 0;
  const levels = [...new Set((plan?.floors || []).map((f) => f.level || 0))].sort((a, b) => a - b);
  const one = (set, level) => {
    const topMM = floorTopMM(set, level);
    const checkMM = topMM + s.marginMM;
    const minDistanceMM = minDistanceForHeightMM(rules, checkMM);
    return { topMM, checkMM, minDistanceMM, fromSiteMM: Math.max(0, minDistanceMM - roadOffsetMM) };
  };
  return levels.map((level) => ({ level, low: one(s.build.low, level), standard: one(s.build.standard, level) }));
}

// ─── 描画用の格子計算 ─────────────────────────────────

function boundsOf(poly) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  return { minX, minZ, maxX, maxZ };
}

/**
 * 高さ h が上限を超える（limit < h − 許容）範囲を、行ごとの連続区間で返す。
 * 格子のセル中心で判定し、区間はセルの幅で返す。→ [{ x0, x1, z, stepMM }]
 * 低めの高さで呼ぶと赤、標準の高さで呼ぶと黄の範囲になる。
 */
export function forbiddenRuns(ctx, hMM, stepMM = 100) {
  if (ctx.boundary.length < 3) return [];
  const { minX, minZ, maxX, maxZ } = boundsOf(ctx.boundary);
  const runs = [];
  for (let z = minZ + stepMM / 2; z < maxZ; z += stepMM) {
    let start = null;
    let last = null;
    for (let x = minX + stepMM / 2; x < maxX; x += stepMM) {
      const r = heightLimitAtPoint({ x, z }, ctx);
      const bad = !!r && r.limitMM < hMM - TOLERANCE_MM;
      if (bad) {
        if (start === null) start = x;
        last = x;
      } else if (start !== null) {
        runs.push({ x0: start - stepMM / 2, x1: last + stepMM / 2, z, stepMM });
        start = null;
      }
    }
    if (start !== null) runs.push({ x0: start - stepMM / 2, x1: last + stepMM / 2, z, stepMM });
  }
  return runs;
}

/**
 * 上限がちょうど h になる線（境目）を marching squares で求める。→ [[{x,z},{x,z}], ...]
 * 敷地の外にかかるセルは描かない。
 */
export function contourSegments(ctx, hMM, stepMM = 100) {
  if (ctx.boundary.length < 3) return [];
  const { minX, minZ, maxX, maxZ } = boundsOf(ctx.boundary);
  const cols = Math.max(1, Math.ceil((maxX - minX) / stepMM));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / stepMM));
  const f = [];
  for (let j = 0; j <= rows; j++) {
    const row = [];
    for (let i = 0; i <= cols; i++) {
      const r = heightLimitAtPoint({ x: minX + i * stepMM, z: minZ + j * stepMM }, ctx);
      row.push(r && Number.isFinite(r.limitMM) ? r.limitMM - hMM : NaN);
    }
    f.push(row);
  }
  const lerp = (p, q, fp, fq) => {
    const t = fp / (fp - fq);
    return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
  };
  const segs = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = [f[j][i], f[j][i + 1], f[j + 1][i + 1], f[j + 1][i]];
      if (v.some(Number.isNaN)) continue;
      const c = [
        { x: minX + i * stepMM, z: minZ + j * stepMM },
        { x: minX + (i + 1) * stepMM, z: minZ + j * stepMM },
        { x: minX + (i + 1) * stepMM, z: minZ + (j + 1) * stepMM },
        { x: minX + i * stepMM, z: minZ + (j + 1) * stepMM },
      ];
      // 各辺で符号が変わる所に点を置く
      const pts = [];
      for (let k = 0; k < 4; k++) {
        const a = v[k], b = v[(k + 1) % 4];
        if ((a < 0) !== (b < 0)) pts.push(lerp(c[k], c[(k + 1) % 4], a, b));
      }
      if (pts.length === 2) segs.push([pts[0], pts[1]]);
      else if (pts.length === 4) {
        // 鞍点: セル中心の値で組み合わせを決める
        const center = (v[0] + v[1] + v[2] + v[3]) / 4;
        if ((center < 0) === (v[0] < 0)) segs.push([pts[0], pts[3]], [pts[1], pts[2]]);
        else segs.push([pts[0], pts[1]], [pts[2], pts[3]]);
      }
    }
  }
  return segs;
}
