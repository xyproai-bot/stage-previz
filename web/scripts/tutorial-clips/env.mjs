// 錄影腳本用的：讀 seed 建好的專案資料，用假帳號的登入碼走一次網站的登入拿登入字串。
import { join } from 'node:path';
import { WORK_DIR, loadAccounts, loginWithCode, readJson } from './lib.mjs';

export async function loadEnv() {
  const proj = readJson(join(WORK_DIR, 'project.json'));
  if (!proj?.projectId || !proj.songs) throw new Error('找不到示範專案資料，請先跑：node seed.mjs');
  const acc = loadAccounts();
  const tokens = {};
  for (const k of ['producer', 'animator', 'director']) tokens[k] = await loginWithCode(acc[k].code);
  return { ...proj, accounts: acc, tokens };
}
