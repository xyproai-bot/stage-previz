// 開瀏覽器的共用部分：用顯示卡畫 3D、登入（走網站本來的登入頁）、存登入狀態。
import { join } from 'node:path';
import { chromium } from 'playwright';
import { API_BASE, WEB_BASE, WORK_DIR, ensureDir, loadAccounts, log } from './lib.mjs';

export const VIEW = { width: 1280, height: 720 };

/** 3D 要順：用顯示卡（D3D11）。沒有顯示卡的電腦會自動退回軟體算，會比較慢。 */
export const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
/**
 * 錄影用的顯示比例：畫面放大 1.5 倍錄（錄出來 1920×1080），再縮成 1280×720，字比較清楚。
 * 一定要用瀏覽器自己的 --force-device-scale-factor（不是 Playwright 的 deviceScaleFactor）：
 * 後者只是模擬，CDP screencast 抓到的還是 1280×720，字不會變清楚。
 */
export const RECORD_ARGS = ['--force-device-scale-factor=1.5', '--window-size=1280,720'];

export async function launchBrowser(opts = {}) {
  return chromium.launch({ headless: true, args: [...GPU_ARGS, ...RECORD_ARGS], ...opts });
}

export function statePath(role) { return join(ensureDir(WORK_DIR), `state-${role}.json`); }

/**
 * 每個頁面載入前先做的設定（只在錄影腳本裡加，不動網站程式）：
 *   - 前端連本機後台（localStorage stagepreviz-api-base）
 *   - 動畫師的「帶著做」標成看過，不要蓋在畫面上
 */
export const SETUP_INIT_SCRIPT = `
  try {
    localStorage.setItem('stagepreviz-api-base', ${JSON.stringify(API_BASE)});
    localStorage.setItem('sp_tour_animator_v1', '1');
  } catch (e) {}
`;

/**
 * 用網站的登入頁登入（打登入碼、按登入），把登入狀態存起來給之後的錄影用。
 * 這一段不錄影，登入碼不會入鏡。
 */
export async function saveLoginState(browser, role) {
  const acc = loadAccounts()[role];
  const ctx = await browser.newContext({ viewport: VIEW, locale: 'zh-TW' });
  await ctx.addInitScript(SETUP_INIT_SCRIPT);
  const page = await ctx.newPage();
  await page.goto(WEB_BASE + '/login');
  await page.getByLabel('登入碼').fill(acc.code);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20000 });
  await ctx.storageState({ path: statePath(role) });
  await ctx.close();
  log(`登入狀態存好：${acc.name}`);
}
