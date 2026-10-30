// 示範舞台的「自動貼 UV」：照製作平常的做法，在網站的「自動貼 UV」面板按一次。
// （UV 是瀏覽器裡算的，後台沒有現成的 API 可以直接呼叫，所以這一步要開瀏覽器按。）
//   選螢幕：全部自動貼 → 解析度：點距 12 mm → 排版：自動排 → 套用。
import { WEB_BASE, api, log, sleep } from './lib.mjs';
import { SETUP_INIT_SCRIPT, saveLoginState, statePath } from './browser.mjs';

export const PITCH_MM = '12';

export async function applyAutoUv(browser, projectId, producerToken) {
  await saveLoginState(browser, 'producer');
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-TW', storageState: statePath('producer') });
  await ctx.addInitScript(SETUP_INIT_SCRIPT);
  const page = await ctx.newPage();
  try {
    // 讀模型、分析要一下；等「2 解析度」可以按（偶爾要等比較久，卡住就關掉重開一次）
    const sizeTab = page.getByRole('tab', { name: '2 解析度' });
    for (let attempt = 1; ; attempt++) {
      await page.goto(`${WEB_BASE}/admin/projects/${projectId}`);
      await page.getByRole('button', { name: '自動貼 UV（LED 的 UV 和對位圖）' }).click({ timeout: 60000 });
      try {
        await page.waitForFunction(() => {
          const t = [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent.includes('2 解析度'));
          return t && !t.disabled;
        }, null, { timeout: 60000 });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        log(`  自動貼 UV 面板還沒準備好，重開一次（第 ${attempt} 次）`);
      }
    }
    await sizeTab.click();
    await page.getByLabel('點距（毫米）').first().fill(PITCH_MM);
    await page.getByRole('button', { name: '套用到全部已選' }).click();
    await page.getByRole('tab', { name: '3 排版' }).click();
    await page.getByTestId('uv-apply-quick').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="uv-apply-quick"]'); return b && !b.disabled; }, null, { timeout: 30000 });
    await page.getByTestId('uv-apply-quick').click();
    await page.getByTestId('uv-apply-confirm-go').click();
    // 套用完後台的畫布大小會有數字
    let canvas = null;
    for (let i = 0; i < 90 && !canvas; i++) {
      await sleep(1000);
      const d = await api(producerToken, 'GET', `/api/projects/${projectId}`);
      canvas = d.project?.led_canvas ? JSON.parse(d.project.led_canvas) : null;
    }
    if (!canvas) throw new Error('自動貼 UV 沒有套用成功（畫布大小還是空的）');
    log(`自動貼 UV 好了，LED 畫布 ${canvas.width} × ${canvas.height}`);
    return canvas;
  } finally {
    await ctx.close();
  }
}
