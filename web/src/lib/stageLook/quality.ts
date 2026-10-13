// 現場模式的畫質檔（LED 燈、環境光、bloom、地板倒影、解析度）
//   一開始依裝置選（iPad / 手機 / 低階電腦從 low 開始），之後 AdaptiveQuality 依實際順不順自動升降：
//   平均低於 40fps 持續 3 秒 → 降一級；高於 55fps 持續 10 秒 → 升一級（最多回到一開始的等級）

export type QualityLevel = 'high' | 'medium' | 'low' | 'minimal';

/** 好 → 差 */
export const QUALITY_LEVELS: readonly QualityLevel[] = ['high', 'medium', 'low', 'minimal'];

export interface QualitySpec {
  /** 全場最多幾盞 LED 燈 */
  maxLights: number;
  /** LED 環境光（反射 / 染色）多久更新一次 */
  envIntervalMs: number;
  /** renderer pixelRatio 上限 */
  pixelRatioCap: number;
  /** bloom 解析度比例（0 = 不畫 bloom） */
  bloomScale: number;
  /** 地板倒影 render target 解析度比例（0 = 不畫倒影） */
  reflectionScale: number;
}

export const QUALITY: Record<QualityLevel, QualitySpec> = {
  high: { maxLights: 24, envIntervalMs: 200, pixelRatioCap: 1.5, bloomScale: 1, reflectionScale: 0.5 },
  medium: { maxLights: 16, envIntervalMs: 500, pixelRatioCap: 1.25, bloomScale: 0.75, reflectionScale: 0.25 },
  low: { maxLights: 8, envIntervalMs: 1000, pixelRatioCap: 1, bloomScale: 0.5, reflectionScale: 0 },
  minimal: { maxLights: 4, envIntervalMs: 2000, pixelRatioCap: 1, bloomScale: 0, reflectionScale: 0 },
};

/** 一開始的畫質（也是自動升級的上限） */
export function detectQualityProfile(d: { maxTouchPoints: number; hardwareConcurrency: number; userAgent: string }): QualityLevel {
  const mobile = /iPad|iPhone|Android|Mobile/i.test(d.userAgent);
  // iPadOS 的 Safari 預設回報成 Mac，只能靠觸控點判斷
  const touchMac = /Macintosh/.test(d.userAgent) && d.maxTouchPoints > 1;
  if (mobile || touchMac) return 'low';
  if (d.hardwareConcurrency > 0 && d.hardwareConcurrency <= 4) return 'low';
  return 'high';
}

export interface AdaptiveQualityOptions {
  /** 平均幾毫秒內的幀 */
  windowMs: number;
  /** 量了這麼久才開始判斷（剛開始幾幀不準） */
  minSampleMs: number;
  /** 平均低於這個 fps … */
  downFps: number;
  /** … 持續這麼久 → 降一級 */
  downAfterMs: number;
  /** 平均高於這個 fps … */
  upFps: number;
  /** … 持續這麼久 → 升一級 */
  upAfterMs: number;
  /** 兩幀間隔超過這個 = 暫停過（分頁藏起來、電腦睡著）→ 重新量 */
  pauseGapMs: number;
  /** 換等級後先等這麼久再量（換的那一下會卡） */
  settleMs: number;
  /** 升級後這麼快又要降 → 那一級太重，之後不再升上去（避免一直跳來跳去） */
  failedUpWithinMs: number;
}

export const ADAPTIVE_QUALITY_DEFAULTS: AdaptiveQualityOptions = {
  windowMs: 2000,
  minSampleMs: 1000,
  downFps: 40,
  downAfterMs: 3000,
  upFps: 55,
  upAfterMs: 10000,
  pauseGapMs: 1000,
  settleMs: 1000,
  failedUpWithinMs: 30000,
};

/**
 * 自動畫質：每幀呼叫 frame(現在時間, 跟上一幀的間隔)，要換等級時回傳新等級。
 * 不碰 DOM / three，時間由外面給 → 可以直接測。
 */
export class AdaptiveQuality {
  private readonly opts: AdaptiveQualityOptions;
  private readonly startIdx: number;
  private idx: number;
  /** 最好只能升到這一級（index 越小越好） */
  private ceilingIdx: number;
  private times: number[] = [];
  private dts: number[] = [];
  private sum = 0;
  private measuringSince: number | null = null;
  private holdUntil = -Infinity;
  private belowSince: number | null = null;
  private aboveSince: number | null = null;
  private lastUpAt: number | null = null;

  constructor(start: QualityLevel, opts: Partial<AdaptiveQualityOptions> = {}) {
    this.opts = { ...ADAPTIVE_QUALITY_DEFAULTS, ...opts };
    this.startIdx = QUALITY_LEVELS.indexOf(start);
    this.idx = this.startIdx;
    this.ceilingIdx = this.startIdx;
  }

  get level(): QualityLevel { return QUALITY_LEVELS[this.idx]; }

  /** 最好能升到哪一級 */
  get ceiling(): QualityLevel { return QUALITY_LEVELS[this.ceilingIdx]; }

  /** 目前量到的平均 fps（還沒量夠 → null） */
  averageFps(): number | null {
    return this.dts.length > 0 && this.sum > 0 ? (this.dts.length * 1000) / this.sum : null;
  }

  /** 這段時間的幀不算（剛載入模型、切模式、分頁切回來）；量到一半的重來 */
  hold(nowMs: number, durationMs: number) {
    this.holdUntil = Math.max(this.holdUntil, nowMs + durationMs);
    this.restart();
  }

  /** 情況變了（切現場 / 快速）→ 之前判定太重的等級可以再試 */
  resetCeiling() {
    this.ceilingIdx = this.startIdx;
    this.lastUpAt = null;
  }

  frame(nowMs: number, dtMs: number): QualityLevel | null {
    const o = this.opts;
    if (nowMs < this.holdUntil) return null;
    if (!(dtMs > 0) || dtMs > o.pauseGapMs) {
      this.restart();
      return null;
    }
    this.times.push(nowMs);
    this.dts.push(dtMs);
    this.sum += dtMs;
    while (this.times.length > 0 && this.times[0] < nowMs - o.windowMs) {
      this.times.shift();
      this.sum -= this.dts.shift()!;
    }
    if (this.measuringSince === null) this.measuringSince = nowMs;
    if (nowMs - this.measuringSince < o.minSampleMs) return null;

    const fps = this.averageFps()!;
    if (fps < o.downFps) {
      this.aboveSince = null;
      this.belowSince ??= nowMs;
      if (nowMs - this.belowSince >= o.downAfterMs && this.idx < QUALITY_LEVELS.length - 1) {
        // 剛升上來就撐不住 → 這一級太重，之後不再升上來
        if (this.lastUpAt !== null && nowMs - this.lastUpAt < o.failedUpWithinMs) {
          this.ceilingIdx = Math.max(this.ceilingIdx, this.idx + 1);
        }
        this.lastUpAt = null;
        return this.change(this.idx + 1, nowMs);
      }
    } else if (fps > o.upFps) {
      this.belowSince = null;
      this.aboveSince ??= nowMs;
      if (nowMs - this.aboveSince >= o.upAfterMs && this.idx > this.ceilingIdx) {
        this.lastUpAt = nowMs;
        return this.change(this.idx - 1, nowMs);
      }
    } else {
      this.belowSince = null;
      this.aboveSince = null;
    }
    return null;
  }

  private change(idx: number, nowMs: number): QualityLevel {
    this.idx = idx;
    this.hold(nowMs, this.opts.settleMs);
    return this.level;
  }

  private restart() {
    this.times = [];
    this.dts = [];
    this.sum = 0;
    this.measuringSince = null;
    this.belowSince = null;
    this.aboveSince = null;
  }
}
