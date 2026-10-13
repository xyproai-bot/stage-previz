// 一次性：把舊的 KV 留言（key = s:<projectId>-<songId>，value = 留言 JSON 陣列）搬進 D1 comments 表。
//
// 用法（在 cf-worker/ 底下）：
//   1. 把 KV 的留言存成一個 JSON 檔：{ "s:p_xxx-s_yyy": [ ...留言 ], ... }（先備份，這個檔就是備份）
//   2. node scripts/migrate-kv-comments.mjs <kv-dump.json> > <out.sql>
//   3. npx wrangler d1 execute stage-previz-db --remote --file <out.sql>
//
// - 只搬「對得到某首歌」的留言串；舊版單頁工具的留言串（對不到歌）留在 KV
// - 用 INSERT OR IGNORE：重跑不會重複
// - 作者：用名字對到 users 表（同名只有一個人時才對，不然留空 = 只有 admin 能改 / 刪）
// - 格式轉換跟 worker 用的同一份（comments.mjs），讀出來跟以前 KV 版本一模一樣
// - KV 原本的資料不會被刪
import fs from 'node:fs';
import { sanitizeComment, commentToRow } from '../comments.mjs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/migrate-kv-comments.mjs <kv-dump.json>');
  process.exit(1);
}
const dump = JSON.parse(fs.readFileSync(file, 'utf8'));

const sql = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
};

const lines = ['-- 由 scripts/migrate-kv-comments.mjs 產生：KV 留言 → D1 comments'];
let count = 0, skipped = 0;
for (const [key, list] of Object.entries(dump)) {
  const session = key.replace(/^s:/, '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(session) || !Array.isArray(list)) { skipped++; continue; }
  for (const raw of list) {
    const c = sanitizeComment(raw);
    if (!c) { skipped++; continue; }
    const r = commentToRow(c);
    // 專案 / 歌：用 session 規則（跟前端 songCommentSession 一樣）對回去；對不到就不會插入
    // 作者：名字只對到一個人時才填
    lines.push(`INSERT OR IGNORE INTO comments (id, project_id, song_id, time_in_video, anchor_type, anchor_screen_xy, anchor_world_xyz,
  anchor_mesh_name, anchor_offset_xyz, text, mentions, status, resolved_by, resolved_at,
  author_user_id, author_name, author_role, author_email, created_at)
SELECT ${sql(r.id)}, s.project_id, s.id, ${sql(r.time_in_video)}, ${sql(r.anchor_type)}, ${sql(r.anchor_screen_xy)}, ${sql(r.anchor_world_xyz)},
  ${sql(r.anchor_mesh_name)}, ${sql(r.anchor_offset_xyz)}, ${sql(r.text)}, ${sql(r.mentions)}, ${sql(r.status)}, ${sql(r.resolved_by)}, ${sql(r.resolved_at)},
  (SELECT u.id FROM users u WHERE u.name = ${sql(r.author_name)} AND (SELECT COUNT(*) FROM users u2 WHERE u2.name = ${sql(r.author_name)}) = 1),
  ${sql(r.author_name)}, ${sql(r.author_role)}, ${sql(r.author_email)}, ${sql(r.created_at)}
FROM songs s WHERE substr(s.project_id, 1, 28) || '-' || substr(s.id, 1, 28) = ${sql(session)} LIMIT 1;`);
    count++;
  }
}
console.log(lines.join('\n'));
console.error(`產生 ${count} 則留言的 SQL（略過 ${skipped} 筆格式不對的）`);
