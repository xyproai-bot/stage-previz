// LED 顏色照原檔：shader 裡算的東西，這裡用 TS 照抄一份（給單元測試驗數學；改 GLSL 要一起改這裡）
//
// 為什麼不在 LED shader 裡「反算」three 的 Neutral tone mapping：
//   Neutral 在亮的地方會把顏色往白色拉（Desaturation），而且只看最亮的那個色版。很亮又很飽和的顏色
//   （例：純紅 255,0,0）不管送多亮進去，出來的綠、藍都不會是 0 → 反算不回來（見測試）。
//   所以改成「LED 畫面不經過 tone mapping」：
//     1. LED shader（ledSurface.ts）：輸出 = 原檔顏色（linear）+ 表面反光「照相機曲線多亮了多少」
//        → 黑的地方的反光跟舞台其他地方一樣被壓，亮的地方幾乎不會被反光墊高
//        主畫面那一次 alpha 寫 0 = 「這是 LED 畫面」
//     2. 輸出（ledOutputPass.ts）：alpha 是 0 的像素不做 tone mapping / 曝光，只轉 sRGB；
//        光暈加在 LED 上的那一份照相機曲線算（跟旁邊舞台的光暈一致）
//   結果：正面看 LED 的像素 = 原檔的像素（只差 8 位元四捨五入）。

export type Vec3 = [number, number, number];

/** three r169 tonemapping_pars_fragment 的 NeutralToneMapping（含 toneMappingExposure） */
export function neutralToneMap(c: Vec3, exposure: number): Vec3 {
  const StartCompression = 0.8 - 0.04;
  const Desaturation = 0.15;
  let r = c[0] * exposure, g = c[1] * exposure, b = c[2] * exposure;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset; g -= offset; b -= offset;
  const peak = Math.max(r, g, b);
  if (peak < StartCompression) return [r, g, b];
  const d = 1 - StartCompression;
  const newPeak = 1 - (d * d) / (peak + d - StartCompression);
  const s = newPeak / peak;
  r *= s; g *= s; b *= s;
  const gm = 1 - 1 / (Desaturation * (peak - newPeak) + 1);
  return [r + (newPeak - r) * gm, g + (newPeak - g) * gm, b + (newPeak - b) * gm];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * 現場模式 LED 一個像素存進畫面的值（ledSurface.ts 的 LED_OUTPUT）：
 *   content = 原檔顏色（linear，已乘亮度 / 像素格 / 側看）；surface = 表面反光 + 打到 LED 的燈（linear）
 *   = content + max(相機曲線(content + surface) − 相機曲線(content), 0)
 */
export function ledLiveDisplay(content: Vec3, surface: Vec3, exposure: number): Vec3 {
  const a = neutralToneMap(add(content, surface), exposure);
  const b = neutralToneMap(content, exposure);
  return [content[0] + Math.max(a[0] - b[0], 0), content[1] + Math.max(a[1] - b[1], 0), content[2] + Math.max(a[2] - b[2], 0)];
}

/**
 * ledOutputPass.ts：畫面上一個像素送去轉 sRGB 前的值（linear）
 *   ledMask = 1 − alpha（1 = LED 畫面、0 = 舞台其他地方；半透明的東西蓋在 LED 上會在中間）
 *   bloom = 光暈這一格加多少（linear）
 */
export function outputPassLinear(stored: Vec3, ledMask: number, bloom: Vec3, exposure: number): Vec3 {
  const lit = neutralToneMap(add(stored, bloom), exposure);
  const base = neutralToneMap(stored, exposure);
  const led: Vec3 = [
    stored[0] + Math.max(lit[0] - base[0], 0),
    stored[1] + Math.max(lit[1] - base[1], 0),
    stored[2] + Math.max(lit[2] - base[2], 0),
  ];
  const m = Math.min(1, Math.max(0, ledMask));
  return [lit[0] + (led[0] - lit[0]) * m, lit[1] + (led[1] - lit[1]) * m, lit[2] + (led[2] - lit[2]) * m];
}

// ─── 像素格（近看時一顆一顆 LED）───

/** GLSL smoothstep */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** ∫_{-∞}^{x} smoothstep(e0, e1, t) dt（ledSurface.ts 的 ledSmoothInt） */
export function smoothstepIntegral(e0: number, e1: number, x: number): number {
  const w = e1 - e0;
  if (x <= e0) return 0;
  if (x >= e1) return 0.5 * w + (x - e1);
  const t = (x - e0) / w;
  return w * (t * t * t - 0.5 * t * t * t * t);
}

/** 一顆 LED 一個方向的亮點形狀：d = 離格子中心多遠（0~0.5 格），half = 亮點半寬，aa = 邊緣模糊寬度 */
export function ledDot1D(d: number, half: number, aa: number): number {
  return 1 - smoothstep(half - aa, half + aa, d);
}

/** ledDot1D 在一格裡的平均（解析解；aa 寬到超出格子邊也對）——除以它，一格的平均亮度就不會變 */
export function ledDotMean1D(half: number, aa: number): number {
  return 1 - 2 * (smoothstepIntegral(half - aa, half + aa, 0.5) - smoothstepIntegral(half - aa, half + aa, 0));
}

/**
 * 像素格的倍數（ledSurface.ts）：dot = 這一點亮點的形狀（0~1），mean = 一格的平均，peak = 這一點原檔最亮的色版（linear）
 *   一般：dot / mean（一格的平均 = 1）
 *   亮的畫面：亮點最亮只能到 1（畫面最亮就是 1，超過會被截掉、平均變暗）→ 把一部分光分到縫裡，
 *   fill = (peak − mean) / (peak (1 − mean))，倍數 = (1 − fill) dot / mean + fill：一格的平均還是 1，最亮那點剛好到 1
 */
export function ledGridFill(peak: number, mean: number): number {
  return Math.min(1, Math.max(0, (peak - mean) / (Math.max(peak, 1e-5) * (1 - mean))));
}

export function ledGridMultiplier(dot: number, mean: number, peak: number): number {
  const fill = ledGridFill(peak, mean);
  return (1 - fill) * (dot / mean) + fill;
}

// ─── 側看變暗 ───

/** 正面 ±20° 以內完全不變（鏡頭正對 LED 時，畫面邊上的 LED 也是原檔亮度），再斜就照 cos² 變暗 */
export const VIEW_FALLOFF_FLAT_COS2 = Math.cos((20 * Math.PI) / 180) ** 2;

export function ledViewCurve(ndv: number): number {
  return Math.min(1, (ndv * ndv) / VIEW_FALLOFF_FLAT_COS2);
}
