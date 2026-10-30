// 錄教學短片（只連本機）。
//
//   node record.mjs                 錄全部 13 段
//   node record.mjs overview        只錄一段（可以一次寫好幾個 id）
//   --encode                        錄完直接轉成 mp4（等於再跑一次 node encode.mjs <id>）
//   --grid-dir <資料夾>             6 格縮圖放哪裡（跟 --encode 一起用）
//
// 錄之前先跑過 node seed.mjs，本機後台（wrangler dev）和網站（vite）都要開著，網址看 lib.mjs。
import { launchBrowser, saveLoginState } from './browser.mjs';
import { CLIPS, CLIP_IDS } from './clips.mjs';
import { encodeClip } from './encode.mjs';
import { loadEnv } from './env.mjs';
import { log } from './lib.mjs';
import { markNotificationsRead } from './seed-content.mjs';

const args = process.argv.slice(2);
const gi = args.indexOf('--grid-dir');
const gridDir = gi >= 0 ? args[gi + 1] : undefined;
const wantEncode = args.includes('--encode');
const ids = args.filter((a, i) => !a.startsWith('--') && !(gi >= 0 && i === gi + 1));
const todo = ids.length ? ids : CLIP_IDS;
for (const id of todo) if (!CLIPS[id]) { console.error(`沒有這一段：${id}（有：${CLIP_IDS.join('、')}）`); process.exit(1); }

const env = await loadEnv();
const browser = await launchBrowser();
let failed = 0;
// 有改到資料的幾段（提交審查、加影片、回覆）：錄之前先全部還原，錄完也還原，下一段看到的歌單狀態才一樣
const restoreAll = async () => { for (const c of Object.values(CLIPS)) if (c.reset) await c.reset(env); };
try {
  await restoreAll();
  await saveLoginState(browser, 'animator');       // 登入走網站的登入頁，這一段不錄影
  for (const id of todo) {
    const spec = CLIPS[id];
    log(`\n[錄] ${id}（${spec.where}）`);
    let clip;
    try {
      if (spec.reset) await spec.reset(env);
      await markNotificationsRead(env.tokens.animator);
      clip = await spec.setup(browser, env);
      await clip.startRecording(id);
      const t0 = Date.now();
      await spec.run(clip, env);
      const meta = await clip.stopRecording();
      log(`  錄好了：${meta.frames.length} 格、${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
      if (wantEncode) encodeClip(id, { ...(spec.encode || {}), gridDir });
    } catch (e) {
      failed++;
      console.error(`  [失敗] ${id}：${String(e.stack || e).split('\n').slice(0, 6).join('\n')}`);
    } finally {
      if (clip) await clip.close().catch(() => {});
      if (spec.reset) await spec.reset(env).catch(() => {});
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
