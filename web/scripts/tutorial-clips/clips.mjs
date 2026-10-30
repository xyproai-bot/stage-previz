// 13 段短片：每一段 = setup（準備好畫面，不錄）+ run（真正錄下來的動作）+ encode（裁切放大、封面）。
// 動作全部用真的滑鼠和鍵盤（recorder.mjs 的 Clip），網站程式一個字都沒改。
// 要等畫面真的到了那個狀態才往下做（等元素出現、等字出現），不靠固定秒數；秒數只用在「讓人看清楚」的停頓。
import { Clip } from './recorder.mjs';
import { MEDIA_FILES, mediaPath, resetAddVideo, resetComments, resetSubmitReview } from './seed-content.mjs';
import { sleep } from './lib.mjs';

const stageScene = (page) => page.locator('.studio-stage__scene').first();

/** 3D 畫面的範圍（CSS 像素） */
async function stageBox(page) {
  const b = await stageScene(page).boundingBox();
  if (!b) throw new Error('找不到 3D 畫面');
  return b;
}

/**
 * 開動畫師工作站、選好歌、等 3D 和 LED 畫面準備好（這一段不錄）。
 * source：LED 畫面來源（影片 / AE 即時 / 本地檔案）；filter：歌單的「我的 / 全部」
 */
async function openStudio(browser, env, { songCode, source = 'version', filter = 'mine', role = 'animator', play = false, cursor = { x: 1160, y: 650 } }) {
  const clip = await Clip.open(browser, {
    role, source,
    initScripts: [`try { localStorage.setItem('sp_studio_filter', ${JSON.stringify(filter)}); } catch (e) {}`],
  });
  const { page } = clip;
  await clip.goto(`/studio/${env.projectId}`);
  await page.locator('.studio-songs__item').first().waitFor({ timeout: 30000 });
  if (songCode) await page.locator('.studio-songs__item', { hasText: songCode }).first().click();
  await page.locator('.studio-stage__scene canvas').first().waitFor({ timeout: 30000 });
  // 讀取中的字消失 = 版本清單、模型都讀好了
  await page.waitForFunction(() => !/讀取/.test(document.querySelector('.led-source__status')?.textContent || ''), null, { timeout: 30000 });
  await sleep(2500);
  if (play) await startPlayback(page);
  await clip.placeCursor(cursor.x, cursor.y);
  return clip;
}

/** 按小播放器的播放，等它真的在播 */
async function startPlayback(page) {
  await page.locator('.mini-player__btn--play').first().click();
  await page.waitForFunction(() => /播放中/.test(document.querySelector('.led-source__status')?.textContent || ''), null, { timeout: 15000 });
  await sleep(500);
}

/** AE 即時的說明卡先收起來（沒影片的歌，LED 直接看測試圖） */
async function dismissAeCard(page) {
  const close = page.locator('.ndi-guide__close').first();
  if (await close.count()) { await close.click(); await sleep(800); }
}

async function openReviewTab(page) {
  await page.locator('.studio-right .tab', { hasText: '審查 / 留言' }).first().click();
  await page.waitForFunction(() => /留言/.test(document.querySelector('.studio-right__body')?.innerText || ''));
  await sleep(600);
}

async function scrollRightPanel(page, y) {
  await page.evaluate((top) => { const el = document.querySelector('.studio-right__body'); if (el) el.scrollTop = top; }, y);
  await sleep(400);
}

export const CLIPS = {
  // ─────────────────────────────────────────────
  overview: {
    where: 'intro-what',
    alt: '動畫師工作站：示範舞台的 LED 播著示範動畫，用滑鼠拖拉轉視角、滾輪縮放，再按「重置攝影機」回到原本的視角。',
    async setup(browser, env) {
      const clip = await openStudio(browser, env, { songCode: 'S01', play: true });
      await clip.page.getByRole('button', { name: '收起來' }).click();     // 小播放器收起來，3D 畫面看得比較完整
      await sleep(600);
      return clip;
    },
    async run(clip) {
      const { page } = clip;
      const sb = await stageBox(page);
      const cx = sb.x + sb.width * 0.5, cy = sb.y + sb.height * 0.58;
      await clip.pause(1000);
      await clip.dragPath([{ x: cx + 60, y: cy }, { x: cx, y: cy - 6 }, { x: cx - 50, y: cy + 4 }], { msPerLeg: 800 });
      await clip.pause(500);
      await clip.dragPath([{ x: cx - 100, y: cy }, { x: cx, y: cy - 8 }, { x: cx + 90, y: cy }], { msPerLeg: 800 });
      await clip.pause(400);
      await clip.wheel(-240, { steps: 8, gapMs: 70 });
      await clip.pause(900);
      await clip.wheel(240, { steps: 8, gapMs: 70 });
      await clip.pause(700);
      await clip.click(page.getByRole('button', { name: '重置攝影機' }).first(), { ms: 800 });
      await clip.pause(2200);
    },
    encode: { posterAt: 1.0 },
  },

  // ─────────────────────────────────────────────
  'find-song': {
    where: 'login-find',
    alt: '動畫師工作站左邊的歌曲清單：按「我的」只剩指派給自己的歌，點一首，舞台就換成那首歌的樣子。',
    async setup(browser, env) {
      return openStudio(browser, env, { songCode: 'S01', filter: 'all', cursor: { x: 640, y: 420 } });
    },
    async run(clip) {
      const { page } = clip;
      await clip.pause(1200);
      await clip.click(page.locator('.studio-songs__filter .tab', { hasText: '我的' }), { ms: 800 });
      await clip.pause(1000);
      await clip.click(page.locator('.studio-songs__item', { hasText: 'S03' }), { ms: 800 });
      await page.waitForFunction(() => /S03/.test(document.querySelector('.led-source__status')?.textContent || ''), null, { timeout: 15000 });
      await clip.pause(1400);
      await clip.click(page.locator('.mini-player__btn--play').first(), { ms: 800 });
      await clip.pause(2800);
    },
    encode: { posterAt: 4.0 },
  },

  // ─────────────────────────────────────────────
  'local-file': {
    where: 'preview-file',
    alt: '來源選「本地檔案」，把一支影片拖進舞台，LED 馬上出現動畫，再按播放。',
    async setup(browser, env) {
      const clip = await openStudio(browser, env, { songCode: 'S05', cursor: { x: 90, y: 690 } });
      const { page } = clip;
      const file = mediaPath('local');
      await page.route('**/__clip__/local.mp4', route => route.fulfill({ path: file, contentType: 'video/mp4' }));
      // 準備好「被拖的檔案」（網頁裡用 DataTransfer + File 做出來，跟真的拖進來一樣會觸發 dragenter / dragover / drop）
      await page.evaluate(async (name) => {
        const blob = await (await fetch('/__clip__/local.mp4')).blob();
        const dt = new DataTransfer();
        dt.items.add(new File([blob], name, { type: 'video/mp4' }));
        window.__dt = dt;
      }, MEDIA_FILES.local);
      return clip;
    },
    async run(clip) {
      const { page } = clip;
      const fire = (type) => page.evaluate((t) => {
        const el = document.querySelector('main.studio-stage');
        el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
      }, type);
      await clip.pause(900);
      await clip.click(page.getByRole('tab', { name: /本地檔案/ }), { ms: 800 });
      await clip.pause(1200);
      // 從視窗外拖一個檔案進來：游標旁邊跟著檔案小卡，拖到舞台上放開
      await clip.ghost(MEDIA_FILES.local);
      const sb = await stageBox(page);
      await clip.moveTo(sb.x + sb.width * 0.45, sb.y + sb.height * 0.55, 1500);
      await fire('dragenter'); await fire('dragover');
      await clip.pause(900);
      await fire('dragover');
      await clip.pause(500);
      await fire('drop');
      await clip.ghost(null);
      await page.locator('.share-player').waitFor({ timeout: 15000 });
      await clip.pause(1100);
      await clip.click(page.locator('.share-player__btn').first(), { ms: 800 });
      await clip.pause(3600);
    },
    encode: { posterAt: 8.5 },
  },

  // ─────────────────────────────────────────────
  'test-pattern': {
    where: 'preview-test',
    alt: '沒有影片的歌，LED 上是測試圖：把 3D 畫面轉到側邊、拉近，就看得到每一片 LED 自己的名字和位置。',
    async setup(browser, env) {
      const clip = await openStudio(browser, env, { songCode: 'S05', source: 'ndi' });
      await dismissAeCard(clip.page);
      return clip;
    },
    async run(clip) {
      const { page } = clip;
      const sb = await stageBox(page);
      const cx = sb.x + sb.width * 0.5, cy = sb.y + sb.height * 0.6;
      await clip.pause(1200);
      await clip.dragPath([{ x: cx + 60, y: cy }, { x: cx + 20, y: cy - 5 }, { x: cx - 10, y: cy + 3 }, { x: cx - 25, y: cy }], { msPerLeg: 800 });
      await clip.pause(500);
      await clip.wheel(-280, { steps: 8, gapMs: 70 });
      await clip.pause(2400);
      await clip.click(page.getByRole('button', { name: '重置攝影機' }).first(), { ms: 800 });
      await clip.pause(2000);
    },
    encode: { posterAt: 5.5 },
  },

  // ─────────────────────────────────────────────
  'music-cue': {
    where: 'preview-music',
    alt: '沒有影片、有音樂的歌：按播放聽音樂，點 cue，音樂跳到那個時間，3D 的升降台跟著升起來。',
    async setup(browser, env) {
      const clip = await openStudio(browser, env, { songCode: 'S04', source: 'ndi' });
      await dismissAeCard(clip.page);
      // 先把鏡頭拉近一點，升降台升起來看得比較清楚（這段不錄）
      const sb = await stageBox(clip.page);
      await clip.page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await clip.wheel(-220, { steps: 6, gapMs: 60 });
      await sleep(1200);
      await clip.placeCursor(1160, 650);
      return clip;
    },
    async run(clip) {
      const { page } = clip;
      await clip.pause(1000);
      await clip.click(page.locator('.music-bar__play'), { ms: 800 });
      await page.waitForFunction(() => /0:0[1-9]/.test(document.querySelector('.music-bar__time')?.textContent || ''), null, { timeout: 15000 });
      await clip.pause(1800);
      await clip.click(page.locator('.studio-cuebar__cue').nth(2), { ms: 900 });
      await clip.pause(3600);
      await clip.click(page.locator('.studio-cuebar__cue').nth(3), { ms: 900 });
      await clip.pause(3400);
    },
    encode: { posterAt: 7.5 },
  },

  // ─────────────────────────────────────────────
  'add-video': {
    where: 'submit-add',
    alt: '按「＋ 加影片」，寫一句說明、選影片檔，看上傳進度，跑完就多一個新的版本，LED 換成新的一版。',
    async reset(env) { resetAddVideo(env.songs.s03.id); },
    async setup(browser, env) {
      return openStudio(browser, env, { songCode: 'S03', cursor: { x: 1000, y: 520 } });
    },
    async run(clip) {
      const { page } = clip;
      await clip.pause(900);
      await clip.click(page.locator('[data-tour="add-video"]'), { ms: 900 });
      await page.getByRole('dialog').or(page.locator('.sp-dialog-layer, [class*="add-video"]')).first().waitFor({ timeout: 10000 }).catch(() => {});
      await clip.pause(900);
      await clip.click(page.getByPlaceholder('例：修了第二段的轉場'), { ms: 700 });
      await page.keyboard.type('修了第二段的轉場', { delay: 90 });
      await clip.pause(600);
      // 選檔案：點框 → （作業系統的選檔視窗不會被錄到）→ 選好
      page.once('filechooser', async (fc) => { await sleep(900); await fc.setFiles(mediaPath('s03v2')); });
      const cdp = await clip.ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: -1, uploadThroughput: 380 * 1024 });
      await clip.click(page.getByText('把影片拖到這裡，或點這裡選檔案'), { ms: 800 });
      await page.getByText('完成，變成 V2').waitFor({ timeout: 40000 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await clip.pause(1600);
      await clip.click(page.locator('.mini-player__btn--play').first(), { ms: 800 });
      await clip.pause(2600);
    },
    encode: {},
  },

  // ─────────────────────────────────────────────
  versions: {
    where: 'submit-versions',
    alt: '版本列上有 V1、V2：點哪一版，LED 就換成哪一版的畫面。',
    async setup(browser, env) {
      return openStudio(browser, env, { songCode: 'S01', play: true, cursor: { x: 900, y: 360 } });
    },
    async run(clip) {
      const { page } = clip;
      const chip = (v) => page.locator('.vbar__chip', { hasText: v });
      await clip.pause(1400);
      await clip.click(chip('V1'), { ms: 800, left: 14 });
      await clip.pause(2400);
      await clip.click(chip('V2'), { ms: 800, left: 30 });
      await clip.pause(2400);
      await clip.click(chip('V1'), { ms: 800, left: 14 });
      await clip.pause(2000);
      await clip.click(chip('V2'), { ms: 800, left: 30 });
      await clip.pause(1600);
    },
    encode: { crop: { x: 240, y: 62, w: 880 }, posterAt: 6.5 },
  },

  // ─────────────────────────────────────────────
  'submit-review': {
    where: 'submit-review',
    alt: '右邊「審查 / 留言」分頁：先寫一段給導演的話，按「提交審查」再確認，狀態就變成「審查中」。',
    async reset(env) { await resetSubmitReview(env.tokens, env.projectId, env.songs.s02.id); },
    async setup(browser, env) {
      return openStudio(browser, env, { songCode: 'S02', cursor: { x: 1000, y: 330 } });
    },
    async run(clip) {
      const { page } = clip;
      await clip.pause(900);
      await clip.click(page.locator('.studio-right .tab', { hasText: '審查 / 留言' }), { ms: 800 });
      await page.getByRole('button', { name: '提交審查', exact: true }).waitFor({ timeout: 10000 });
      await clip.pause(1000);
      await clip.click(page.locator('.studio-right__body textarea').first(), { ms: 800 });
      await page.keyboard.type('請看 0:10 升降台上來那段', { delay: 80 });
      await clip.pause(700);
      await clip.click(page.getByRole('button', { name: '提交審查', exact: true }), { ms: 800 });
      await page.locator('.sp-dialog-layer button', { hasText: '取消' }).waitFor({ timeout: 10000 });
      await clip.pause(1500);
      await clip.click(page.locator('.sp-dialog-layer button', { hasText: '提交審查' }), { ms: 700 });
      await page.waitForFunction(() => /審查中/.test(document.querySelector('.studio-right__body')?.innerText || ''), null, { timeout: 15000 });
      await clip.pause(2600);
    },
    encode: { crop: { x: 380, y: 60, w: 900 }, posterAt: 11.8 },
  },

  // ─────────────────────────────────────────────
  'record-options': {
    where: 'record-options',
    alt: '按「錄成影片」打開設定視窗：看一遍解析度、範圍、鏡頭和 cue 字幕，最後按「開始錄」。',
    async setup(browser, env) {
      return openStudio(browser, env, { songCode: 'S01', cursor: { x: 900, y: 330 } });
    },
    async run(clip) {
      const { page } = clip;
      await clip.pause(900);
      await clip.click(page.locator('.vbar__btn', { hasText: '錄成影片' }), { ms: 900 });
      await page.getByText('解析度').first().waitFor({ timeout: 10000 });
      await clip.pause(1200);
      await clip.click(page.getByRole('radio', { name: /1280×720/ }), { ms: 800 });
      await clip.pause(900);
      await clip.hover(page.getByRole('radio', { name: /從目前時間到結束/ }), { ms: 700 });
      await clip.pause(900);
      await clip.hover(page.getByLabel('鏡頭'), { ms: 700 });
      await clip.pause(900);
      await clip.hover(page.getByText('左下角疊 cue 名稱字幕'), { ms: 700 });
      await clip.pause(900);
      await clip.click(page.getByRole('button', { name: '開始錄' }), { ms: 800 });
      await clip.pause(1500);
    },
    encode: { crop: { x: 160, y: 80, w: 960 }, posterAt: 5.0 },
  },

  // ─────────────────────────────────────────────
  'record-progress': {
    where: 'record-wait',
    alt: '錄影中：播放控制鎖住，下方出現進度條；按「停止」就存成影片檔，畫面上寫「已存成 …」。',
    async setup(browser, env) {
      const clip = await openStudio(browser, env, { songCode: 'S01', cursor: { x: 760, y: 560 } });
      const { page } = clip;
      await page.locator('.vbar__btn', { hasText: '錄成影片' }).click();
      await page.getByRole('button', { name: '開始錄' }).click();
      await page.getByText(/錄影中/).first().waitFor({ timeout: 15000 });
      return clip;
    },
    async run(clip) {
      const { page } = clip;
      await clip.pause(2800);
      await clip.hover(page.locator('.mini-player__btn--play').first(), { ms: 800 });
      await clip.pause(1900);
      const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      await clip.click(page.getByRole('button', { name: '停止', exact: true }), { ms: 900 });
      await page.getByText(/已存成/).first().waitFor({ timeout: 20000 });
      await dl;
      await clip.pause(3800);
    },
    encode: { crop: { x: 240, y: 225, w: 853 }, posterAt: 8.5 },
  },

  // ─────────────────────────────────────────────
  'feedback-see': {
    where: 'feedback-see',
    alt: '「審查 / 留言」分頁：點導演的一則留言，影片換到那一版、跳到那一秒，攝影機飛到導演當時的視角，導演畫的記號疊在畫面上。',
    async reset(env) { await resetComments(env.tokens, env.projectId, env.songs.s01.id); },
    async setup(browser, env) {
      const clip = await openStudio(browser, env, { songCode: 'S01', cursor: { x: 1050, y: 300 } });
      await openReviewTab(clip.page);
      await scrollRightPanel(clip.page, 1000);
      return clip;
    },
    async run(clip) {
      const { page } = clip;
      await clip.pause(900);
      await clip.hover(page.locator('.rvc-comment', { hasText: '需修改' }).first(), { ms: 800 });
      await clip.pause(1000);
      await clip.click(page.getByText('升降台升起來以後，前面這片 LED 太亮了').first(), { ms: 900 });
      await page.getByText(/畫記 · 示範導演/).first().waitFor({ timeout: 15000 });
      await clip.pause(5600);
    },
    encode: { crop: { x: 240, y: 62, w: 1040 }, posterAt: 6.0 },
  },

  // ─────────────────────────────────────────────
  'feedback-reply': {
    where: 'feedback-reply',
    alt: '按留言下面的「回覆」寫一句話送出，再按「已改好（V2）」，這則留言就變成已解決（灰色）。',
    async reset(env) { await resetComments(env.tokens, env.projectId, env.songs.s01.id); },
    async setup(browser, env) {
      const clip = await openStudio(browser, env, { songCode: 'S01', cursor: { x: 1050, y: 300 } });
      await openReviewTab(clip.page);
      await scrollRightPanel(clip.page, 1000);
      return clip;
    },
    async run(clip) {
      const { page } = clip;
      const thread = page.locator('.rvc-thread', { hasText: '升降台升起來以後' }).first();
      const card = thread.locator('.rvc-comment').first();
      await clip.pause(1000);
      await clip.click(card.locator('.rvc-act', { hasText: '回覆' }), { ms: 900 });
      await page.getByPlaceholder(/回覆（打 @/).waitFor({ timeout: 10000 });
      await clip.pause(600);
      await page.keyboard.type('收到，升降台那段亮度我壓低', { delay: 85 });
      await clip.pause(700);
      await clip.click(page.getByRole('button', { name: '送出回覆' }), { ms: 800 });
      await page.getByText('收到，升降台那段亮度我壓低').first().waitFor({ timeout: 10000 });
      await clip.pause(1300);
      await clip.click(card.locator('.rvc-act--fix'), { ms: 900 });
      await thread.and(page.locator('.is-greyed')).waitFor({ timeout: 10000 });
      await clip.pause(3000);
    },
    encode: { crop: { x: 427, y: 240, w: 853 }, posterAt: 9.0 },
  },

  // ─────────────────────────────────────────────
  compare: {
    where: 'feedback-compare',
    alt: '小播放器下面「比較」選 V1，LED 放 V2；按 C 鍵在兩版之間切換，停在同一秒。',
    async setup(browser, env) {
      return openStudio(browser, env, { songCode: 'S01', play: true, cursor: { x: 700, y: 330 } });
    },
    async run(clip) {
      const { page } = clip;
      const sel = page.locator('select[aria-label="選另一個版本來比較"]');
      await clip.pause(1400);
      await clip.hover(sel, { ms: 900 });
      await clip.pause(500);
      await sel.selectOption({ index: 1 });
      await clip.pause(1700);
      await clip.click(page.getByRole('button', { name: /^切到 V/ }), { ms: 800 });   // 旁邊的按鈕：切到 V1
      await clip.pause(2000);
      await page.keyboard.press('c');                                                 // 鍵盤 C：切回 V2
      await clip.pause(2000);
      await page.keyboard.press('c');
      await clip.pause(2000);
      await page.keyboard.press('c');
      await clip.pause(1500);
    },
    encode: { crop: { x: 240, y: 70, w: 1040 }, posterAt: 7.0 },
  },
};

export const CLIP_IDS = Object.keys(CLIPS);
