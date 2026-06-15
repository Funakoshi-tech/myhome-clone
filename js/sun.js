// sun.js
// 日射計算（フェーズB）。外部ライブラリは使わず天文計算式を直接実装する。
// 太陽位置は NOAA Solar Position Algorithm に基づく。
//
// 方位角 azimuthDeg: 真北=0、東=90、南=180、西=270（時計回り）。
// 高度角 altitudeDeg: 地平線=0、天頂=90。高度が0以下なら夜（地平線下）。

const DEG = Math.PI / 180;
const rad = (d) => d * DEG;
const deg = (r) => r / DEG;
const mod360 = (x) => ((x % 360) + 360) % 360;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// 既定座標：板橋区赤塚
export const DEFAULT_LAT = 35.775;
export const DEFAULT_LNG = 139.679;

// 季節の目盛り（うるう年でない平年基準の通日）
export const SEASON_MARKERS = [
  { doy: 79,  label: '春分 3/20' },
  { doy: 172, label: '夏至 6/21' },
  { doy: 266, label: '秋分 9/23' },
  { doy: 355, label: '冬至 12/21' },
];

// ユリウス日（その日の 0h UT）
function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

/**
 * 太陽の方位角・高度角を返す。
 * @param {Date} date  対象日（年月日のみ使用）
 * @param {number} hour 現地標準時の時刻（0〜23、小数可）
 * @param {number} lat  緯度（度, 北が正）
 * @param {number} lng  経度（度, 東が正）
 * @returns {{azimuthDeg:number, altitudeDeg:number}}
 */
export function getSunPosition(date, hour, lat, lng) {
  // 時間帯（経度から推定：15°=1時間）。日本付近は +9。
  const tz = Math.round(lng / 15);

  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();

  const minutes = hour * 60; // 現地真夜中からの分

  // UT に変換してユリウス世紀 T を求める
  const jd0 = julianDay(y, m, d);
  const jd = jd0 + (minutes - tz * 60) / 1440;
  const T = (jd - 2451545.0) / 36525.0;

  // 太陽の幾何平均黄経・平均近点角・離心率
  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const Mdeg = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = rad(Mdeg);

  // 中心差
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * Mr) * 0.000289;

  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega)); // 視黄経

  // 黄道傾斜角
  const seconds = 21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813));
  const eps0 = 23 + (26 + seconds / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));

  // 赤緯
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));

  // 均時差（分）
  const yv = Math.tan(rad(eps / 2)) ** 2;
  const L0r = rad(L0);
  const eqTime = 4 * deg(
    yv * Math.sin(2 * L0r)
    - 2 * e * Math.sin(Mr)
    + 4 * e * yv * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * yv * yv * Math.sin(4 * L0r)
    - 1.25 * e * e * Math.sin(2 * Mr),
  );

  // 真太陽時（分）
  const tst = ((minutes + eqTime + 4 * lng - 60 * tz) % 1440 + 1440) % 1440;

  // 時角（度）
  let ha = tst / 4;
  ha = ha < 0 ? ha + 180 : ha - 180;

  const latR = rad(lat);
  const declR = rad(decl);
  const haR = rad(ha);

  // 天頂角
  const cosZen = clamp(
    Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR),
    -1, 1,
  );
  const zen = Math.acos(cosZen);
  const altitudeDeg = 90 - deg(zen);

  // 方位角
  const sinZen = Math.sin(zen);
  let azimuthDeg;
  if (Math.abs(sinZen) < 1e-6) {
    azimuthDeg = 180;
  } else {
    let cosAz = (Math.sin(latR) * cosZen - Math.sin(declR)) / (Math.cos(latR) * sinZen);
    cosAz = clamp(cosAz, -1, 1);
    const azRaw = deg(Math.acos(cosAz));
    azimuthDeg = ha > 0 ? mod360(azRaw + 180) : mod360(540 - azRaw);
  }

  return { azimuthDeg, altitudeDeg };
}

/**
 * 方位角・高度角から、原点→太陽 方向の単位ベクトルを返す。
 * 世界座標系の規約: X=東, Y=上, Z=南（北=-Z）。
 */
export function sunDirection(azimuthDeg, altitudeDeg) {
  const az = rad(azimuthDeg);
  const al = rad(altitudeDeg);
  const cosAl = Math.cos(al);
  return {
    x: cosAl * Math.sin(az),
    y: Math.sin(al),
    z: -cosAl * Math.cos(az),
  };
}

// 通日(1〜365)から Date を作る（指定年・平年基準）
export function dateFromDayOfYear(doy, year = 2025) {
  const d = new Date(year, 0, 1);
  d.setDate(doy);
  return d;
}

// 通日 → "M/D"
export function formatMonthDay(doy, year = 2025) {
  const d = dateFromDayOfYear(doy, year);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
