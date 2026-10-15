// 手機、iPad 上「真正看得到的高度」。
//
// 網址列縮起來、螢幕鍵盤跳出來的時候，100vh 不會變（iPhone 的鍵盤甚至不改版面的高度），
// 固定在畫面底下的留言框就被鍵盤蓋住。這裡把瀏覽器回報的「現在看得到的範圍」（visualViewport）
// 寫進兩個 CSS 變數，版面用它算高度：
//   --vvh      看得到的高度（px）
//   --vv-top   看得到的範圍離版面最上面多遠（iPhone 打字時會把畫面往上推一點）
// 順便在 <html> 上標 data-keyboard="open"（鍵盤大概跳出來了），CSS 想收起底下的固定列可以用。
// 兩指放大的時候（scale > 1）不改：放大後 visualViewport 變小不是鍵盤，版面不該跟著縮。
// 版面只在手機 / iPad 的規則裡用到這些變數（沒設就退回 100dvh），電腦版不受影響。

export interface ViewportMetrics {
  /** visualViewport.height */
  height: number;
  /** visualViewport.offsetTop */
  offsetTop: number;
  /** visualViewport.scale（1 = 沒放大） */
  scale: number;
  /** window.innerHeight（版面的高度） */
  layoutHeight: number;
}

export interface ViewportVars {
  /** null = 不要覆蓋（讓 CSS 退回 100dvh） */
  vvh: string | null;
  vvTop: string | null;
  keyboardOpen: boolean;
}

/** 鍵盤至少要吃掉多少高度，才算「鍵盤跳出來了」（網址列縮放大約 50～100px，不算） */
export const KEYBOARD_MIN_PX = 120;

/** 純函式：瀏覽器回報的數字 → 要寫進 CSS 的值 */
export function viewportVars(m: ViewportMetrics): ViewportVars {
  const ok = Number.isFinite(m.height) && m.height > 0 && Number.isFinite(m.layoutHeight) && m.layoutHeight > 0;
  if (!ok || m.scale > 1.02) return { vvh: null, vvTop: null, keyboardOpen: false };
  const top = Number.isFinite(m.offsetTop) && m.offsetTop > 0 ? m.offsetTop : 0;
  return {
    vvh: `${Math.round(m.height)}px`,
    vvTop: `${Math.round(top)}px`,
    keyboardOpen: m.layoutHeight - m.height >= KEYBOARD_MIN_PX,
  };
}

/** 手機寬度（版面會把留言區變成從底下拉上來的面板）；要跟 CSS 的 `@media (max-width: 640px)` 一樣 */
export const PHONE_MAX_WIDTH = 640;
export function isPhoneLayout(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`).matches;
}

/** 開始跟著瀏覽器回報的範圍更新 CSS 變數；回傳取消用的函式 */
export function installViewportVars(): () => void {
  if (typeof window === 'undefined' || !window.visualViewport) return () => {};
  const vv = window.visualViewport;
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    const v = viewportVars({ height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale, layoutHeight: window.innerHeight });
    if (v.vvh) root.style.setProperty('--vvh', v.vvh); else root.style.removeProperty('--vvh');
    if (v.vvTop) root.style.setProperty('--vv-top', v.vvTop); else root.style.removeProperty('--vv-top');
    if (v.keyboardOpen) root.setAttribute('data-keyboard', 'open'); else root.removeAttribute('data-keyboard');
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  apply();
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
    if (frame) cancelAnimationFrame(frame);
    root.style.removeProperty('--vvh');
    root.style.removeProperty('--vv-top');
    root.removeAttribute('data-keyboard');
  };
}
