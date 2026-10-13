// 依裝置決定現場模式的畫質檔（iPad / 手機 / 低階電腦降一點，保持順暢）

export type QualityProfile = 'high' | 'low';

export interface QualitySpec {
  /** 全場最多幾盞 LED 燈 */
  maxLights: number;
  /** LED 環境光（反射 / 染色）多久更新一次 */
  envIntervalMs: number;
  /** renderer pixelRatio 上限 */
  pixelRatioCap: number;
  /** bloom 解析度比例 */
  bloomScale: number;
  /** 地板倒影 render target 解析度比例（0 = 不畫倒影） */
  reflectionScale: number;
}

export const QUALITY: Record<QualityProfile, QualitySpec> = {
  high: { maxLights: 24, envIntervalMs: 200, pixelRatioCap: 1.5, bloomScale: 1, reflectionScale: 0.5 },
  low: { maxLights: 8, envIntervalMs: 1000, pixelRatioCap: 1, bloomScale: 0.5, reflectionScale: 0 },
};

export function detectQualityProfile(d: { maxTouchPoints: number; hardwareConcurrency: number; userAgent: string }): QualityProfile {
  const mobile = /iPad|iPhone|Android|Mobile/i.test(d.userAgent);
  // iPadOS 的 Safari 預設回報成 Mac，只能靠觸控點判斷
  const touchMac = /Macintosh/.test(d.userAgent) && d.maxTouchPoints > 1;
  if (mobile || touchMac) return 'low';
  if (d.hardwareConcurrency > 0 && d.hardwareConcurrency <= 4) return 'low';
  return 'high';
}
