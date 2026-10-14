// 影片什麼時候會自己開始播 —— 導演頁、分享連結、動畫師工作站共用（純函式，playbackPolicy.test.ts 有測）
//
//   不會自己播：進歌、換歌、換版本、從通知 / 連結點進來、頁面剛打開、交的影片好了換到新的一版、本地檔案換一個
//     → 停在第一格（或要跳到的那一秒），LED 上看得到那一格，cue、機關也擺在那一秒；
//       要自己按播放（小播放器的播放鍵、空白鍵、J / K / L）才開始
//   換網址接著同一秒（比較 A/B、「有新版 · 切換」、播放網址過期重新載入）→ 播放 / 暫停照舊
//   點 cue → 只跳時間，播放 / 暫停照舊
//   點留言 → 跳到那一格停住（看畫記）；點了沒有畫記的區段留言 → 直接循環那一段
//     （打開留言只有自己點的時候；通知 / 連結點進來只會捲到那則留言，不會打開）

/** 載好一支影片之後要不要開始播 */
export function playsAfterLoad(o: {
  /** 叫的人明講要不要播（例：點了區段留言） */
  autoplay?: boolean;
  /** 換網址接著同一秒（比較、有新版 · 切換、網址過期） */
  sameSecond?: boolean;
  /** 換之前在播嗎 */
  wasPlaying?: boolean;
}): boolean {
  if (o.autoplay != null) return o.autoplay;
  return !!o.sameSecond && !!o.wasPlaying;
}

export interface CommentOpenPlan {
  /** 停在哪一秒 */
  at: number;
  /** 要不要跳時間（0 秒、沒有區段的留言 = 不跳） */
  hasTime: boolean;
  /** 區段留言：循環這一段 */
  loop: { start: number; end: number } | null;
  /** 打開之後要不要開始播（點了沒有畫記的區段留言才會） */
  play: boolean;
}

/**
 * 點一則留言：停在哪一格、要不要循環、要不要播。
 * 有畫記 → 停在畫的那一格（區段留言常常是先標 I / O 再畫，畫的不是區段開頭；畫的那一格離區段太遠就用區段開頭）；
 * 沒有畫記 → 留言的時間。有畫記的先停住給你看，按播放再循環整段。
 */
export function commentOpenPlan(
  c: { time: number; timeEnd?: number | null },
  /** 留言的畫記（沒有 = null）；t = 畫的那一格 */
  ann: { t?: number | null } | null,
): CommentOpenPlan {
  const hasRange = c.timeEnd != null && c.timeEnd > c.time;
  const t = ann?.t;
  const at = t != null && (!hasRange || (t >= c.time - 0.5 && t <= (c.timeEnd as number) + 0.5)) ? t : c.time;
  return {
    at,
    hasTime: at > 0 || hasRange,
    loop: hasRange ? { start: c.time, end: c.timeEnd as number } : null,
    play: hasRange && !ann,
  };
}
