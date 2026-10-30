// 建本機示範專案（給錄教學短片用）。只連本機後台（lib.mjs 會擋掉非本機的網址）。
// 跑兩次結果一樣：每次先把「示範演唱會」和三個示範帳號清掉再重建。
//
//   node seed.mjs            全部建好
//   node seed.mjs accounts   只建帳號
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS_FILE, API_BASE, ASSETS_DIR, DEMO, api, d1Exec, d1Query, ensureDir, loginWithCode, log, WORK_DIR, writeJson } from './lib.mjs';
import { launchBrowser } from './browser.mjs';
import { applyAutoUv } from './seed-uv.mjs';
import { seedContent } from './seed-content.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  const b = randomBytes(10);
  return Array.from(b, x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ─── 1. 帳號 ───

/** 清掉舊的示範專案和三個示範帳號，建新的（登入碼每次重新隨機） */
export async function seedAccounts() {
  ensureDir(WORK_DIR);
  const ids = Object.values(DEMO.users).map(u => u.id);
  const old = d1Query(`SELECT id FROM projects WHERE name = ${q(DEMO.project)};`);
  const stmts = [];
  for (const p of old) stmts.push(`DELETE FROM projects WHERE id = ${q(p.id)};`);
  // 本機資料庫 migration 會預設放一個製作帳號，不要讓它的名字入鏡
  stmts.push(`DELETE FROM users WHERE id = 'u_phang';`);
  stmts.push(`DELETE FROM users WHERE id IN (${ids.map(q).join(',')});`);
  const accounts = {};
  for (const [key, u] of Object.entries(DEMO.users)) {
    const code = newCode();
    accounts[key] = { ...u, code };
    stmts.push(`INSERT INTO users (id, email, name, role, access_code) VALUES (${q(u.id)}, ${q(u.id + '@auto.local')}, ${q(u.name)}, ${q(u.role)}, ${q(code)});`);
  }
  d1Exec(stmts.join('\n'));
  // 走網站本來的登入拿登入字串（只在這支腳本裡用，不存檔）
  for (const a of Object.values(accounts)) a.token = await loginWithCode(a.code);
  writeJson(ACCOUNTS_FILE, Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, { id: a.id, name: a.name, role: a.role, code: a.code }])));
  log('帳號好了：', Object.values(accounts).map(a => a.name).join('、'));
  return accounts;
}

// ─── 2. 專案、成員、舞台模型 ───

/** 讀 .glb 裡的物件清單（名字 + 位置）。這個示範舞台的物件沒有旋轉也沒有縮放。 */
function readGlbObjects(file) {
  const b = readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
  const root = j.nodes[j.scenes[0].nodes[0]];
  return (root.children || []).map(i => j.nodes[i]).filter(n => n.mesh !== undefined).map(n => ({ name: n.name, t: n.translation || [0, 0, 0] }));
}

// 命名規則跟網站上傳模型時一樣（web/src/lib/parseGlb.ts）
const PREFIX_RULES = [
  [/^LED[_-]/i, 'led_panel'], [/^STAGE[_-]/i, 'mechanism'], [/^MECH[_-]/i, 'mechanism'], [/^ARTIST[_-]/i, 'performer'],
  [/^PROP[_-]/i, 'fixture'], [/^LIGHT[_-]/i, 'fixture'], [/^WALK[_-]/i, 'walk_point'],
];
function classify(name) {
  for (const [re, cat] of PREFIX_RULES) if (re.test(name)) return { category: cat, prefix: name.split(/[_-]/)[0] };
  return { category: 'other', prefix: null };
}
function prettify(name, prefix) {
  if (!prefix) return name;
  return name.replace(new RegExp(`^${prefix}[_-]`, 'i'), '').replace(/[_-]/g, ' ');
}

export async function seedProject(accounts) {
  const tok = accounts.producer.token;
  const { id: projectId } = await api(tok, 'POST', '/api/projects', { name: DEMO.project, description: '教學短片用的示範專案（假資料）' });
  await api(tok, 'POST', `/api/users/${accounts.animator.id}/projects`, { projectId, role: 'animator' });
  await api(tok, 'POST', `/api/users/${accounts.director.id}/projects`, { projectId, role: 'director' });

  const glb = join(ASSETS_DIR, 'demo-stage.glb');
  await api(tok, 'PUT', `/api/projects/${projectId}/model`, readFileSync(glb), { headers: { 'Content-Type': 'model/gltf-binary' } });

  const items = readGlbObjects(glb).map(o => {
    const { category, prefix } = classify(o.name);
    return {
      meshName: o.name, displayName: prettify(o.name, prefix), category,
      defaultPosition: { x: o.t[0], y: o.t[1], z: o.t[2] },
      defaultRotation: { pitch: 0, yaw: 0, roll: 0 },
      defaultScale: { x: 1, y: 1, z: 1 },
    };
  });
  const r = await api(tok, 'POST', `/api/projects/${projectId}/stage-objects/bulk`, { items, replace: false });
  log(`專案好了：${projectId}，物件 ${r.inserted} 個`);
  return projectId;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const what = process.argv[2] || 'all';
  log('後台：', API_BASE);
  const accounts = await seedAccounts();
  if (what === 'accounts') process.exit(0);
  const projectId = await seedProject(accounts);
  writeJson(join(WORK_DIR, 'project.json'), { projectId });
  const browser = await launchBrowser();
  let canvas;
  try {
    canvas = await applyAutoUv(browser, projectId, accounts.producer.token);
    writeJson(join(WORK_DIR, 'project.json'), { projectId, canvas });
  } finally {
    await browser.close();
  }
  const content = await seedContent({ accounts, projectId, canvas });
  writeJson(join(WORK_DIR, 'project.json'), {
    projectId, canvas,
    songs: Object.fromEntries(Object.entries(content.songs).map(([k, s]) => [k, { id: s.id, code: s.spec.code, name: s.spec.name }])),
  });
  log('全部好了');
}
