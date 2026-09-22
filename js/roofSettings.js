// roofSettings.js — 階ごとの屋根設定（floor.roof）の定義と正規化。依存なし（model.js / roofModel.js の両方から使う）。
//
// floor.roof = { type: 'flat' | 'hip', pitchSun: 勾配（寸）, overhangMM: 軒の出（mm） }
// 未設定（undefined）は既定値。既定は陸屋根（従来の平らな屋根板）で、寄棟を選んだ階だけ屋根を立体にする。

export const ROOF_TYPES = [
  { id: 'flat', name: '陸屋根（平ら）' },
  { id: 'hip', name: '寄棟' },
];

/** 勾配の下限・上限（寸勾配: 水平 10 に対して N 上がる） */
export const MIN_PITCH_SUN = 1;
export const MAX_PITCH_SUN = 10;
/** 軒の出の上限（mm） */
export const MAX_OVERHANG_MM = 1500;

export const DEFAULT_ROOF = { type: 'flat', pitchSun: 4, overhangMM: 450 };

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 保存値・入力値を安全な設定オブジェクトにする（未知の種類は陸屋根、数値は範囲内に収める） */
export function normalizeRoofSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    type: ROOF_TYPES.some((t) => t.id === src.type) ? src.type : DEFAULT_ROOF.type,
    pitchSun: Math.round(clampNumber(src.pitchSun, MIN_PITCH_SUN, MAX_PITCH_SUN, DEFAULT_ROOF.pitchSun) * 2) / 2,
    overhangMM: Math.round(clampNumber(src.overhangMM, 0, MAX_OVERHANG_MM, DEFAULT_ROOF.overhangMM)),
  };
}

/** 寸勾配 → 傾き（高さ/水平距離）。4 寸勾配 = 0.4 */
export function pitchTan(pitchSun) {
  return pitchSun / 10;
}

/** 寸勾配 → 角度（度）。4 寸勾配 ≒ 21.8° */
export function pitchDeg(pitchSun) {
  return (Math.atan(pitchTan(pitchSun)) * 180) / Math.PI;
}
