// 上傳網站到 Cloudflare Pages，而且保留前幾版的程式檔（assets）。
//
// 為什麼：Pages 每次上傳都是一整份新的。網站一更新，還開著舊版頁面的人，
// 點開某些功能時要的舊程式檔就不見了（Failed to fetch dynamically imported module）。
// 這裡把每次 build 出來的 assets 收進一個資料夾，下次上傳時一起帶上去，舊分頁照樣能用。
//
// 用法（在 web/ 底下，先 npm run build）：
//   node scripts/pages-deploy.mjs <pages 專案名稱> <分支> <commit>
//   例：node scripts/pages-deploy.mjs stage-previz-prod master 1c25d0b
//
// 收集的資料夾預設在 ~/stage-previz-work/pages-asset-cache/<專案名稱>（不放 Temp，Temp 會被清掉），
// 可以用環境變數 PAGES_ASSET_CACHE 改。超過 45 天沒被用到的舊檔會刪掉，免得越積越多。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [project, branch, commit] = process.argv.slice(2);
if (!project || !branch || !commit) {
  console.error('用法：node scripts/pages-deploy.mjs <pages 專案名稱> <分支> <commit>');
  process.exit(1);
}

const distAssets = path.resolve('dist', 'assets');
if (!fs.existsSync(distAssets)) {
  console.error('找不到 dist/assets，請先 npm run build');
  process.exit(1);
}

const cacheRoot = process.env.PAGES_ASSET_CACHE || path.join(os.homedir(), 'stage-previz-work', 'pages-asset-cache');
const cacheDir = path.join(cacheRoot, project);
fs.mkdirSync(cacheDir, { recursive: true });

const MAX_AGE_MS = 45 * 24 * 3600 * 1000;
const now = Date.now();

// 1. 這次 build 的檔案收進資料夾（同名就更新時間，代表「還在用」）
let added = 0;
for (const name of fs.readdirSync(distAssets)) {
  const src = path.join(distAssets, name);
  if (!fs.statSync(src).isFile()) continue;
  const dst = path.join(cacheDir, name);
  if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); added++; }
  fs.utimesSync(dst, new Date(), new Date());
}

// 2. 太舊的刪掉；其餘以前的檔案補進這次要上傳的 dist/assets（不覆蓋這次的）
let carried = 0, pruned = 0;
for (const name of fs.readdirSync(cacheDir)) {
  const file = path.join(cacheDir, name);
  const st = fs.statSync(file);
  if (!st.isFile()) continue;
  if (now - st.mtimeMs > MAX_AGE_MS) { fs.unlinkSync(file); pruned++; continue; }
  const dst = path.join(distAssets, name);
  if (!fs.existsSync(dst)) { fs.copyFileSync(file, dst); carried++; }
}
console.log(`[pages-deploy] 這次新增 ${added} 個檔、帶上以前的 ${carried} 個、刪掉過期 ${pruned} 個`);

// 3. 上傳
const r = spawnSync('npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', project, '--branch', branch, '--commit-hash', commit, '--commit-message', `${project}-${commit}`], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
