# 客戶帳號、隱私、計費 (client accounts, privacy, billing) — design

Date: 2026-10-18. Status: **design approved by the owner, nothing built yet**. Grounded in the code at `27b956e` (`origin/feat/live-stage-look`, last migration `0037`).

Language rules for everything that ships: UI strings are Traditional Chinese, plain words, no emoji (icons via `Icon` + lucide), in-page dialogs only, no English role words (the guard tests `web/src/test/noEmojiInUi.test.ts`, `noEnglishRoleWords.test.ts`, `noNativeDialogs.test.ts` apply to every new screen). Dialog and message texts in this document are quoted exactly as they should ship.

Vocabulary used below (English on the left only exists in this document and in code):

| Term | Meaning |
|---|---|
| operator | The platform owner's account(s): today's global `users.role = 'admin'`, shown in the UI as 「製作」. |
| client / org | A 「客戶」: an organisation (a production company). Projects belong to exactly one org. |
| org admin | 「客戶管理者」: manages their own org's people, sees the access log and statements. |
| org member | Any other person in an org (導演, 動畫師, other staff). |
| project role | `project_members.role` (admin = 製作 on that project, director = 導演, animator = 動畫師). Unchanged. |
| 「我自己」 | The operator's own org (`org_self`, `kind = 'operator'`). Every existing project and user goes here. |

---

## 0. Summary and the owner's decisions

| # | Decision (approved) | Consequence in this design |
|---|---|---|
| 1 | The operator creates every project for clients. Clients are invited, they do not self-register projects. | `POST /api/projects` stays operator-only; it gains an optional `orgId`. No client-side "new project" button. |
| 2 | Org = client. Projects belong to one org. Each org has 客戶管理者 who invite / remove their own people. | New `orgs`, `org_members`, `projects.org_id` (section 2). Org admin is an **org-level flag, not a new global role** (section 3.1 explains why). |
| 3 | The operator is a project member while setting up. After hand-off the 客戶管理者 can remove the operator from a project. Then the operator sees only usage and billing for that project, not content. | `projects.operator_access` + one central access resolver (section 3). Honest split of what is enforced vs contractual in section 4.3. |
| 4 | Every project open / access is logged (who, when, what). 客戶管理者 can see it, including the operator's visits. | `access_log` (section 4.4). Operator visits are flagged and visible to the client. |
| 5 | The operator's own projects are unaffected. | Org 「我自己」 keeps today's rules byte for byte (section 3.2). |
| 6 | Billing per project per month. Monthly fee and included GB are editable per project. No hardcoded prices. Only active months are billed; archiving stops billing. Overage billed per GB. Org storage cap with 80 % warning. | Section 5. Prices live only in the database (`project_billing_terms`, `app_settings`). |
| 7 | Payment v1 is manual: statements per org, operator marks 「已開發票」 / 「已收款」, CSV / print-to-PDF export. Clean seam for ECPay / TapPay later. | Statement lifecycle (5.6), payment provider seam (5.9). |
| 8 | Draft 服務條款 and 隱私權政策 in Traditional Chinese with a visible "must be reviewed by a lawyer" note. | Stage 4, Appendix B. |
| 9 | Stages: 1 orgs + ownership + 客戶管理者; 2 privacy + access log; 3 billing + statements + caps; 4 terms pages. | Section 11. |
| 10 | Existing projects go into 「我自己」; all existing users and permissions stay exactly the same. | Section 8; the migration test compares every (user, project) role before and after (section 10). |

What is deliberately recommended by this spec where the owner left a choice open: "any active day = full month" proration, daily-average storage basis, org admin = full project admin inside their org, soft-deleted files do not count toward billing or the cap. All four are in the open questions (section 12) with defaults.

---

## 1. What the code does today (the parts this design touches)

### 1.1 Identity and roles

| Thing | Where | Today |
|---|---|---|
| Global role | `users.role` CHECK in ('admin','animator','director') — `cf-worker/migrations/0001_init.sql` | `admin` = the operator and sees/does everything on every project. There is no tenant concept at all. |
| Project role | `project_members(project_id,user_id,role)` — `0001_init.sql` | admin / director / animator per project. |
| Role resolver | `access.mjs: projectRoleOf(globalRole, memberRole)` (line 62) | `globalRole === 'admin'` returns `'admin'` for **every** project. This single line is what makes the operator all-seeing. |
| Route permission table | `access.mjs: describeProjectRoute` → `need` (member, editor, shareManager, stageProps, cameraBookmarks, videoUploader/Linker/Editor, globalAdmin, projectPatch, songPatch); `roleMeetsNeed` | One table for everything under `/api/projects/:id/*`. `globalAdmin` is the operator-only bucket (invites, duplicate, restore, wrap-up, archive, project Drive/status/3D-view fields). |
| Project gate | `worker.js: handleProjectsRouter` (~line 321) → `loadProjectContext` (~383) → `projectRoleOf` (~437) | One round trip: project + my membership. The only chokepoint for ~90 % of content endpoints. |
| Sessions | `sessions.mjs`; `worker.js: loadRequestUser` (~3285) | Signed `<userId>.<exp>.<sig>`, 90 days, revoked by `users.sessions_revoked_at` (migration 0025). Bearer or cookie. |
| Login codes | `loginCodes.mjs`; `users.access_code` (plain, 0007) / `users.access_code_hash` (0022); `app_settings.login_code_storage` | Plain-text codes still in the DB until the release-checklist switch to `hashed`. Operator can list (`listUsers`, ~3493) and reset (`setAccessCode`) any user's code. |
| Invites | `invites.mjs`, table `invites` (0022): `project_id NOT NULL`, role animator/director only, SHA-256 token hash, 7-day default, `inviteUserDecision` refuses admin accounts | Only the operator creates them (`describeProjectRoute` `invites` → `globalAdmin`). Redeem creates the user and the `project_members` row. |
| Share links | `share_links` (0012/0017/0018/0026), `worker.js: handleShareRouter` (~5911), `handleProjectShareLinks` (~5778) | Bearer-token capability. Created by admin or director. Password via PBKDF2, 8-hour pass. Guests are read-only (plus optional guest comments). Not tied to a user. |
| Public file URLs | `/r2/models/<pid>/<ts>-<rand>.glb` (`handleModelDownload` ~2589, `modelKeys.mjs`), comment thumbs, comment attachments | No auth; protected only by an unguessable 128-bit key. Anyone who ever received the URL can fetch it forever. Video streams use a short-lived `pass` (`verifyVideoPass`, `handleMemberVideoStream` ~5670). |
| Activity | `activity_log` (0005), `logActivity` (~4101) | Mutations only, per project, visible to every member. Not a visit log. |
| Archive | `archiveProject` (~1441): `UPDATE projects SET status='archived', updated_at=now` | **No status history.** `projects.status` ('active','in_review','archived') only keeps the current value; the only trace is an `activity_log` row. Billing cannot be computed from this. |
| Storage | `storage.mjs` (0029): `storageSummary` per project (live videos from `song_videos`, deleted-in-30-days, models and comment images from the 6-hourly R2 scan in `storage_usage`); `ops.mjs: GET /api/admin/storage` | Bytes per project exist. The "cost estimate" (`StorageUsagePanel.tsx`, `lib/storageApi.ts`: R2 USD per GB, `USD_TO_TWD = 32`, GB = 1024^3) is the operator's **cost**, computed in the browser, never stored. There is no per-day history. |
| Operator tools | `ops.mjs` (`/api/admin/*`, `opsAccessDecision`: `me.role === 'admin'`), `backups.mjs` (full D1 dump to R2 daily, `keepDaily: 30`, downloadable by the operator) | Operator-only. Backups contain every table. |
| View as | `web/src/lib/viewAs.ts` | Frontend-only preview as 導演 / 動畫師 for accounts with role admin. The server still sees the operator's token, so view-as gets no extra server rights. |
| Cron | `wrangler.toml`: `crons = ["*/5 * * * *"]`; `worker.js: scheduled` (~111) runs Drive sync, video copy, `runOpsCron`, `storage.runStorageCron` | Place to hang the daily snapshot / statement / seal jobs. |
| Frontend routing | `web/src/App.tsx`, `lib/roleRouting.tsx` (`RequireAdmin`), `lib/landing.ts` | `/admin/*` operator only; `/studio`, `/preview` per role. Landing page decided by the **global** role. |
| Migrations | `cf-worker/migrations/0001…0037`; test DB harness `cf-worker/testing/d1-sqlite.mjs` (`node:sqlite` + `applyMigrations`) | Another agent may add `0038` (watermark / no-download). This spec uses the working names `ORGS`, `PRIVACY`, `BILLING`, `LEGAL` and says "take the next free number when you start, rebase if 0038 landed". |

### 1.2 The facts that shape the design

1. **One resolver, but ~35 side doors.** `worker.js` has 35 `role === 'admin'` / `!== 'admin'` checks, plus `access.mjs` (`roleMeetsNeed` `globalAdmin`, `canBrowseSharedAssets`), `ops.mjs:44`, `invites.mjs:106`, `reviews.mjs` (`VISIBLE_NOTIFICATIONS` has `?2 = 'admin'` — a global admin sees every project's notifications). Gating the operator out of content means replacing *all* of them with one function, not patching the router (inventory in 3.4).
2. **Global role cannot carry "客戶管理者".** `users.role` has a CHECK constraint (changing it needs a table rebuild with foreign keys on) and the **old production frontend routes by it** (`landing.ts`). A new value would break production. So 客戶管理者 is `org_members.org_role = 'admin'` and the account's `users.role` stays `director` or `animator`.
3. **Everything that bypasses the router is a leak.** Comments (`resolveCommentThread`), member video stream, notifications, search, shows, Drive stream, cross-project `import-cues`, shared model library, `listProjects`, `listShows`, `/api/auth/me`.
4. **No history of status changes** → billing needs a status-event table.
5. **Operator tooling can read client data by design** (login-code reset, plain codes, backups, R2). The product can only partly prevent it (4.3).
6. **The worker is shared** by the production frontend and every Vercel preview (`origins.mjs` lists them all, one `proxy.haimiaan.com`). Any worker/DB change is live for the old frontend immediately. Everything must be additive.

---

## 2. Data model and migrations

All migrations are additive (new tables, new nullable / defaulted columns, new indexes). Nothing is dropped or rewritten except the one-time backfill `UPDATE`s. A worker from before the migration keeps working on the migrated DB (it ignores new columns); a migrated worker keeps working for a DB row with `org_id IS NULL` by treating NULL as 「我自己」 (so an old code path that inserts a project without `org_id`, such as `importProject` or an older worker during a rollout, cannot create an orphan).

### 2.1 Stage 1 — migration `ORGS`

```sql
CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,                      -- 'org_self' for the operator's own, else 'org_' + 8 random bytes hex
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'client' CHECK (kind IN ('operator','client')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  note        TEXT NOT NULL DEFAULT '',              -- operator's private note
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_one_operator ON orgs(kind) WHERE kind = 'operator';

CREATE TABLE IF NOT EXISTS org_members (
  org_id    TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  org_role  TEXT NOT NULL DEFAULT 'member' CHECK (org_role IN ('admin','member')),
  added_by  TEXT,
  added_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id)  REFERENCES orgs(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs(id);   -- NULL = 「我自己」 (never NOT NULL: SQLite cannot add that)
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
ALTER TABLE shows ADD COLUMN org_id TEXT REFERENCES orgs(id);      -- NULL = 「我自己」; a show may only hold projects of one org
ALTER TABLE shared_assets ADD COLUMN client_visible INTEGER NOT NULL DEFAULT 0;   -- only these appear in a client org's model-library picker
ALTER TABLE invites ADD COLUMN org_id TEXT;                        -- set when an org admin created it; redeem also adds the org_members row

-- backfill (the whole "existing data" story, section 8)
INSERT OR IGNORE INTO orgs (id, name, kind) VALUES ('org_self', '我自己', 'operator');
INSERT OR IGNORE INTO org_members (org_id, user_id, org_role)
  SELECT 'org_self', id, CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END FROM users;
UPDATE projects SET org_id = 'org_self' WHERE org_id IS NULL;
UPDATE shows    SET org_id = 'org_self' WHERE org_id IS NULL;

-- access log table is created here so org-management events are recorded from day one (readers and visit events are Stage 2)
-- (full DDL in 2.2)
```

Invariants (enforced in code at write time, covered by tests, not by SQL):

- I1. `users.role = 'admin'` implies the user is a member of `org_self` only. A client org admin can never create or promote a global admin; `PATCH /api/users/:id` refuses `role: 'admin'` for anyone who belongs to a client org.
- I2. A `project_members` row for a client-org project may only be added for (a) a member of that org, or (b) an operator-org account (operator staff, tagged 「製作團隊」 in the UI), and (c) only the operator can add (b), and only while `operator_access = 'open'`.
- I3. Removing a person from an org deletes all their `project_members` rows in that org's projects in the same batch.
- I4. A show contains projects of a single org. `cue import` (`import-cues`) and `duplicate` never cross orgs.
- I5. Every client org keeps at least one 客戶管理者; the last one cannot be demoted or removed (message in Appendix C). Recommended: two.
- I6. A user may belong to several orgs (freelance animators). Their project roles are per project as today.

### 2.2 Stage 2 — migration `PRIVACY`

```sql
ALTER TABLE projects ADD COLUMN operator_access     TEXT NOT NULL DEFAULT 'open' CHECK (operator_access IN ('open','removed'));
ALTER TABLE projects ADD COLUMN operator_removed_at TEXT;
ALTER TABLE projects ADD COLUMN operator_removed_by TEXT;

CREATE TABLE IF NOT EXISTS access_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,                     -- epoch ms
  org_id       TEXT    NOT NULL,                     -- the owning org at that moment ('org_self' for the operator's own)
  project_id   TEXT,                                 -- NULL for org-level events
  actor_user_id TEXT,                                -- NULL for share guests / system
  actor_name   TEXT    NOT NULL,                     -- snapshot: names change, users get deleted
  actor_kind   TEXT    NOT NULL CHECK (actor_kind IN ('operator','org_admin','member','guest','system')),
  project_role TEXT,                                 -- role used for this access ('admin','director','animator', NULL)
  event        TEXT    NOT NULL,                     -- catalogue in 4.4
  target_type  TEXT,                                 -- 'song' | 'video' | 'model' | 'share_link' | 'user' | 'statement' ...
  target_id    TEXT,
  detail       TEXT    NOT NULL DEFAULT '{}',        -- JSON, passed through scrubActivityPayload (no codes / tokens / passwords)
  outcome      TEXT    NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','denied')),
  country      TEXT,                                 -- cf-ipcountry only; NO IP address is stored
  ua_class     TEXT                                  -- 'desktop' | 'mobile' | 'helper' | 'other'
);
CREATE INDEX IF NOT EXISTS idx_access_log_org_time     ON access_log(org_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_project_time ON access_log(project_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_actor_time   ON access_log(actor_user_id, at DESC);

CREATE TABLE IF NOT EXISTS access_log_seals (          -- tamper evidence, see 4.4
  org_id TEXT NOT NULL, day TEXT NOT NULL,             -- Asia/Taipei day 'YYYY-MM-DD'
  row_count INTEGER NOT NULL, digest TEXT NOT NULL, prev_digest TEXT,
  sealed_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, day)
);
```

### 2.3 Stage 3 — migration `BILLING`

```sql
ALTER TABLE orgs ADD COLUMN billing_enabled     INTEGER NOT NULL DEFAULT 1;    -- 0 for 「我自己」 (set by the migration)
ALTER TABLE orgs ADD COLUMN storage_cap_bytes   INTEGER;                       -- NULL = no cap
ALTER TABLE orgs ADD COLUMN payment_terms_days  INTEGER NOT NULL DEFAULT 30;   -- due date = issued + N days
ALTER TABLE orgs ADD COLUMN billing_name        TEXT;                          -- company name on the invoice
ALTER TABLE orgs ADD COLUMN billing_tax_id      TEXT;                          -- 統一編號
ALTER TABLE orgs ADD COLUMN billing_email       TEXT;
ALTER TABLE orgs ADD COLUMN billing_address     TEXT;
UPDATE orgs SET billing_enabled = 0 WHERE kind = 'operator';

ALTER TABLE projects ADD COLUMN billing_start_month TEXT;      -- 'YYYY-MM' (Asia/Taipei). NULL = no billing yet. Set on transfer / creation in a client org.

CREATE TABLE IF NOT EXISTS project_billing_terms (             -- price book, effective-dated so old statements never change
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  effective_month TEXT NOT NULL,                               -- 'YYYY-MM', first month these terms apply
  monthly_fee_twd INTEGER NOT NULL CHECK (monthly_fee_twd >= 0),
  included_gb REAL NOT NULL CHECK (included_gb >= 0),
  overage_twd_per_gb REAL NOT NULL CHECK (overage_twd_per_gb >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, effective_month),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_status_events (             -- the missing history
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','in_review','archived')),
  at INTEGER NOT NULL,                                         -- epoch ms
  by_user_id TEXT,
  source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live','backfill')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pse_project_time ON project_status_events(project_id, at);

CREATE TABLE IF NOT EXISTS storage_daily (                     -- one row per project per Asia/Taipei day; the last sample of the day wins
  project_id TEXT NOT NULL, day TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  billable_bytes INTEGER NOT NULL,                             -- live videos + models + comment images (NOT soft-deleted files)
  video_bytes INTEGER NOT NULL DEFAULT 0, model_bytes INTEGER NOT NULL DEFAULT 0,
  image_bytes INTEGER NOT NULL DEFAULT 0, other_bytes INTEGER NOT NULL DEFAULT 0,
  deleted_bytes INTEGER NOT NULL DEFAULT 0,                    -- soft-deleted, still in R2 (information only, not billed, not capped)
  sampled_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, day),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY,                                         -- 'st_' + hex
  org_id TEXT NOT NULL, period TEXT NOT NULL,                  -- 'YYYY-MM'
  revision INTEGER NOT NULL DEFAULT 1,
  number TEXT NOT NULL UNIQUE,                                 -- 'S202611-001' (per period counter) -- shown to the client
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','invoiced','paid','void')),
  currency TEXT NOT NULL DEFAULT 'TWD',
  tax_mode TEXT NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('none','add_5pct')),   -- decided by open question 5
  subtotal_twd INTEGER NOT NULL DEFAULT 0, adjustment_twd INTEGER NOT NULL DEFAULT 0,
  tax_twd INTEGER NOT NULL DEFAULT 0,      total_twd INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',                         -- JSON: missing terms, missing snapshot days ...
  generated_at INTEGER NOT NULL, issued_at INTEGER, due_at INTEGER,
  invoiced_at INTEGER, invoice_no TEXT, invoice_date TEXT,
  paid_at INTEGER, paid_amount_twd INTEGER, paid_method TEXT, paid_note TEXT,
  void_at INTEGER, void_reason TEXT,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_statements_live ON statements(org_id, period) WHERE status != 'void';
CREATE TABLE IF NOT EXISTS statement_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id TEXT NOT NULL, project_id TEXT, project_name TEXT NOT NULL,   -- name snapshot
  kind TEXT NOT NULL CHECK (kind IN ('fee','overage','adjustment')),
  description TEXT NOT NULL, quantity REAL, unit_price REAL, amount_twd INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',                           -- JSON: terms used, active days, average GB, missing days ...
  FOREIGN KEY (statement_id) REFERENCES statements(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS statement_events (                  -- audit of every state change
  id INTEGER PRIMARY KEY AUTOINCREMENT, statement_id TEXT NOT NULL, at INTEGER NOT NULL,
  by_user_id TEXT, event TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (statement_id) REFERENCES statements(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS payments (                          -- the seam for ECPay / TapPay (5.9); v1 only writes provider = 'manual'
  id TEXT PRIMARY KEY, statement_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'manual',
  provider_ref TEXT, amount_twd INTEGER NOT NULL, status TEXT NOT NULL, raw TEXT, created_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES statements(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS org_alerts (                        -- edge-triggered storage warnings (one row per crossing, so nobody is spammed every 5 minutes)
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cap_80','cap_100')),
  raised_at INTEGER NOT NULL, cleared_at INTEGER, used_bytes INTEGER, cap_bytes INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);

-- backfill: history starts at creation; archived projects get an approximate archive time
INSERT INTO project_status_events (project_id, status, at, source)
  SELECT id, 'active', COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0) * 1000, 'backfill' FROM projects;
INSERT INTO project_status_events (project_id, status, at, source)
  SELECT id, 'archived', COALESCE(CAST(strftime('%s', updated_at) AS INTEGER), 0) * 1000, 'backfill' FROM projects WHERE status = 'archived';
```

Settings (in `app_settings`, no schema change): `billing_default_fee_twd`, `billing_default_included_gb`, `billing_default_overage_twd_per_gb` (empty on install: **nothing is billed until the owner types numbers**), `billing_proration` (`any_day` | `daily`, open question 1), `billing_storage_basis` (`daily_average` | `peak` | `month_end`, open question 2), `billing_tax_mode`, `org_default_cap_gb` (empty = no cap), `access_log_keep_days` (730), `legal_draft_banner` (`on`).

### 2.4 Stage 4 — migration `LEGAL` (optional part)

```sql
CREATE TABLE IF NOT EXISTS terms_acceptances (
  user_id TEXT NOT NULL, doc TEXT NOT NULL CHECK (doc IN ('terms','privacy')), version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL, PRIMARY KEY (user_id, doc, version),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

The two pages themselves need no table (static routes). Recording acceptance is optional and only starts after a lawyer approved the text (task S4-4).

---

## 3. Access model

### 3.1 Org admin is an org flag, not a new global role

`users.role` keeps its three values. A 客戶管理者 is a user with `users.role = 'director'` (lands on `/preview`, same as a real 導演; `animator` also works) plus `org_members.org_role = 'admin'`. The new frontend shows a 「我的組織」 entry; the old frontend ignores it. This keeps `landing.ts`, `RequireAdmin`, the CHECK constraint and every old client untouched.

### 3.2 The resolver (one function, used everywhere)

Replaces `projectRoleOf` as the only way any code decides a role. Pure, in `access.mjs`, table-tested.

```js
// orgKind: 'operator' | 'client' | null (null = 「我自己」)
resolveProjectAccess({ globalRole, memberRole, orgKind, orgRole, operatorAccess })
  -> { role: 'admin'|'director'|'animator'|null, via: string, billingOnly: boolean }

if (orgKind == null || orgKind === 'operator')          // 「我自己」: today's behaviour, unchanged
  return { role: projectRoleOf(globalRole, memberRole), via: 'legacy', billingOnly: false }
// client org
if (globalRole === 'admin')                              // operator
  return memberRole in ROLES && operatorAccess === 'open'
       ? { role: memberRole, via: 'operator-member', billingOnly: false }
       : { role: null,       via: 'operator-no-access', billingOnly: true }
if (orgRole === 'admin') return { role: 'admin', via: 'org-admin', billingOnly: false }   // open question 3 (default)
if (memberRole in ROLES) return { role: memberRole, via: 'member', billingOnly: false }
return { role: null, via: 'none', billingOnly: false }
```

**Stage 1 shortcut:** the `operator_access` column does not exist until Stage 2, so in Stage 1 the operator branch for client orgs also returns `via: 'legacy'` (global admin = project admin, exactly as today). One constant (`OPERATOR_GATING`, false in Stage 1) is flipped in the Stage 2 deploy; the resolver, its table test and every call site are already final in Stage 1, so Stage 2 changes behaviour in one place.

Because 「我自己」 projects go through the `legacy` branch, every existing (user, project) pair resolves to exactly what `projectRoleOf` returns today. The migration test (section 10) proves it for all pairs.

`loadProjectContext` gets one extra LEFT JOIN (`orgs`, `org_members` for `me`) in the same query, so there is still one database round trip.

New `need` values in `roleMeetsNeed`:

- `projectOwner` = `via` is `operator-member` with role admin, or `org-admin`, or (`legacy` and global admin). Replaces `globalAdmin` for the routes in the "owner" rows of the matrix.
- `operatorOnly` = global admin **and** the project is in 「我自己」 or `operator_access = 'open'` (duplicate, import, create, Drive binding).
- `billingOnlyOk` = global admin, any project (usage, billing terms, statements, lifecycle). Never content.

### 3.3 Visibility of project lists (SQL predicate)

```sql
-- p = projects, o = orgs (LEFT JOIN, NULL = 「我自己」), :uid, :isOp
(   EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = :uid)
 OR (:isOp = 1 AND COALESCE(o.kind,'operator') = 'operator')                      -- the operator still sees all of 「我自己」
 OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = p.org_id AND om.user_id = :uid AND om.org_role = 'admin'))   -- 客戶管理者 sees the whole org
```

(In Stage 1 the second line is `:isOp = 1` without the org-kind condition: the operator still sees everything until Stage 2 turns gating on.) Used by `listProjects` (~616), `/api/projects-archived`, `handleSearch` (~1210), `showMemberFilter` (~1491), notifications (`VISIBLE_NOTIFICATIONS`), `listShows`, `getShow`. A handed-off project is **not** in the operator's project list; it appears only in the operator's 客戶 → 專案 list as a billing row (usage, name, status, no content link).

### 3.4 Gate inventory (every place that must use the resolver)

| # | Place (at `27b956e`) | Today | Change |
|---|---|---|---|
| G1 | `worker.js handleProjectsRouter` ~358–364 (`ctx.archived && me.role !== 'admin'`, `roleMeetsNeed`) | global admin passes everywhere | use `ctx.access`; add `projectOwner` / `operatorOnly` / `billingOnlyOk` needs |
| G2 | `listProjects` ~616 | `me.role === 'admin'` lists all | predicate 3.3; add `orgId`, `orgName`, `handedOff` fields |
| G3 | `handleSearch` ~1210, `showMemberFilter` ~1491, `listShows`/`getShow` ~1505–1541 | admin bypass | predicate 3.3 |
| G4 | `import-cues` ~1903 | admin may read any source song | resolver on the source project + same-org rule (I4) |
| G5 | `handleComments` ~2868/2871/2961, `resolveCommentThread` ~2897–2923 | `projectRoleOf(me.role, …)` | resolver; legacy KV threads stay operator-only |
| G6 | `handleNotifications` / `reviews.mjs VISIBLE_NOTIFICATIONS` (228–235), `notificationToApi` | `?2 = 'admin'` sees all | membership, or operator on a 「我自己」 project |
| G7 | `handleMemberVideoStream` ~5680–5691 | `projectRoleOf(row.user_role, …)`, archived exception for admin | resolver (needs org kind + `operator_access` in the SELECT) |
| G8 | `driveStreamFile` ~4694–4725, Drive list/accounts ~4240/4370/4392/4466 | admin bypass | resolver for stream; Drive accounts and folder binding stay operator-only (his Google account) |
| G9 | `handleAssetsRouter` ~3941: `canBrowseSharedAssets` | any project admin may browse the whole library | client-org project admins see only `client_visible = 1` assets; 「我自己」 behaviour unchanged |
| G10 | `handleUsersRouter` ~3463, `listUsers`, `updateUser`, `setAccessCode`, `addUserToProject`, `removeUserFromProject` | operator edits any user, sees plain codes | operator lists client users without `accessCode`; refuses resets for client-org members (except 客戶管理者, 4.3 item 3); `addUserToProject` obeys I2; I1 on `role` changes |
| G11 | `handleInvitesRouter` / `describeProjectRoute` `invites` ~3735 | operator only | `projectOwner` (so the 客戶管理者 can invite); redeem also inserts `org_members` |
| G12 | `updateProject` ~752–763 (`PROJECT_GLOBAL_ADMIN_FIELDS`) | operator only | `projectOwner` for client-org projects (look settings, LED canvas, status); Drive fields stay `operatorOnly` |
| G13 | `archiveProject` ~1441, restore ~590, `wrap-up` | operator only | `projectOwner` or `billingOnlyOk` (archive / restore are lifecycle, always logged to the client) |
| G14 | `ops.mjs opsAccessDecision` 44, `/api/admin/storage` | operator only | unchanged (it already shows names and bytes, not content); the wrap-up button in the panel hides for handed-off projects |
| G15 | `createProject` / `importProject` / `duplicate` | operator only | add `orgId` (default 「我自己」); `duplicate` refuses a source the operator has no access to |
| G16 | `/api/auth/me` (`authMe` ~3430) | `{id,name,role,avatarColor}` | add `isOperator`, `orgs:[{id,name,kind,orgRole}]` (additive) |

A **guard test** (section 10) greps `worker.js` and the `*.mjs` modules for `role === 'admin'` / `role !== 'admin'` / `globalRole` and fails if a line is not on an allowlist of platform-level (not project-content) endpoints. A future endpoint that copies the old pattern fails CI instead of silently leaking.

### 3.5 Permission matrix

Legend. Columns: **OP** = operator on 「我自己」 projects, or on a client project while `operator_access = 'open'` (identical to today); **OP-out** = operator on a client project after removal; **CA** = 客戶管理者; **PA / PD / PN** = client-side project 製作 / 導演 / 動畫師; **OM** = org member who is not on that project; **G** = share-link guest. `Y` allowed, `-` denied, `R` read only, `own` only own items, `C` guest comment only if the link allows it. Cells for PA/PD/PN are exactly today's `access.mjs` rules and do not change. CA is `Y` wherever PA is `Y`, because an org admin resolves to project role 製作 (default of open question 3).

Project content (everything under `/api/projects/:id/…`)

| Category (today's `need`) | OP | OP-out | CA | PA | PD | PN | OM | G |
|---|---|---|---|---|---|---|---|---|
| Open the project, songs, cues, objects, model, mechanisms, activity, comment summary, reviews (`member`) | Y | - | Y | Y | Y | Y | - | R |
| Edit content: songs, cues, objects, model upload, templates, mechanisms, auto-UV, export (`editor`) | Y | - | Y | Y | - | - | - | - |
| Song status (`songStatusDecision`) | Y | - | Y | Y | decide | submit own | - | - |
| Comments: post / reply (`commentPostDecision`) | Y | - | Y | Y | Y | own songs | - | C |
| Video: upload file (`videoUploader`) | Y | - | Y | Y | - | own songs | - | - |
| Video: submit a link (`videoLinker`) | Y | - | Y | Y | Y | own songs | - | - |
| Video: play / list versions | Y | - | Y | Y | Y | Y | - | R |
| Video: edit note, delete, retry (`videoEditor`) | Y | - | Y | Y | own | own | - | - |
| Video: recently deleted, restore (editor) | Y | - | Y | Y | - | - | - | - |
| Share links: list, create, rename, delete (`shareManager`) | Y | - | Y | Y | Y | - | - | - |
| Share links: turn on guest comments | Y | - | Y | Y | - | - | - | - |
| Stage props, camera bookmarks (`stageProps`, `cameraBookmarks`) | Y | - | Y | Y | Y | - | - | R |
| Project name / description / tags (`projectPatch`, general fields) | Y | - | Y | Y | - | - | - | - |
| 3D view settings, LED canvas, project status (`PROJECT_GLOBAL_ADMIN_FIELDS`, new `projectOwner`) | Y | - | Y | - | - | - | - | - |
| Drive folder binding (`operatorOnly`) | Y | - | - | - | - | - | - | - |
| Project members and invites (`projectOwner`) | Y (3.4 I2) | - | Y | - | - | - | - | - |
| Archive, restore (lifecycle, always logged to the client) | Y | Y | Y | - | - | - | - | - |
| Wrap-up, clean videos (`projectOwner`) | Y | - | Y | - | - | - | - | - |
| Duplicate, import, create project (`operatorOnly`) | Y | - | - | - | - | - | - | - |
| Remove the operator from a project / bring the operator back | leave only | - | Y | - | - | - | - | - |
| See this project's access log | own org only | - | Y | - | - | - | - | - |

Org and platform

| Category | OP | OP-out | CA | Member (any org member) | G |
|---|---|---|---|---|---|
| Create / rename / suspend an org, set the storage cap, billing terms | Y | n/a | - | - | - |
| Create the first 客戶管理者 account | Y | n/a | - | - | - |
| Invite / remove org members, change org role, change project roles | - (except as project owner under I2) | n/a | Y | - | - |
| Reset a client member's login code | - | n/a | Y | - | - |
| Reset a 客戶管理者's login code (recovery only) | Y, logged to the org | n/a | Y (other admin) | - | - |
| Org access log (all projects of the org) and CSV export | own org only | n/a | Y | - | - |
| Org storage usage and cap bar | Y (all orgs) | Y (all orgs) | Y | - | - |
| Per-project usage in the operator's 系統狀態 | Y | Y | - | - | - |
| Statements: view own org's issued statements | Y (all) | Y (all) | Y (issued or later only) | - | - |
| Statements: generate, issue, invoice, receive payment, void | Y | Y | - | - | - |
| Users page (all accounts) / system status / backups | Y | Y | own org's list only | - | - |
| Shared model library | Y | n/a | `client_visible` only (read) | - | - |
| Terms and privacy pages | public | public | public | public | public |

OP-out keeps exactly three kinds of access to a handed-off project: its name / status / org (metadata), its byte usage, and the lifecycle + billing endpoints. Everything under the content rows above is refused with the same `403 沒有權限存取此專案` a stranger gets, and the attempt is written to the access log as a denied operator visit (4.4).

---

## 4. Privacy

### 4.1 Removing the operator (flow)

Who: a 客戶管理者 of the project's org (button on 「我的組織 → 專案」), or the operator leaving voluntarily ("我交接完了" on the project row). Endpoint: `DELETE /api/projects/:id/operator-access` (one batch):

1. `projects.operator_access = 'removed'`, `operator_removed_at`, `operator_removed_by`.
2. Delete the `project_members` rows of **every** account with `users.role = 'admin'` on this project. (Operator staff accounts with role animator / director stay; they are people the client can see and remove, shown as 「製作團隊」.)
3. Optional, default checked: revoke the share links created by operator accounts (`share_links.created_by_user_id`), and revoke their unused `invites` (a share link is a bearer credential the operator already holds; this is the only way to close it).
4. Optional, default checked: clear `drive_oauth_token_id` / `drive_folder_id` (the Drive source runs on the operator's own Google account; the client decides whether to keep it).
5. Write `access_log` event `operator_removed` (visible to the client), and `activity_log` row.

Bringing him back: `POST /api/projects/:id/operator-access { userId, role }` by a 客戶管理者 only: sets `operator_access = 'open'`, inserts the member row, logs `operator_regranted`. The operator can never add himself back: every member-adding path (`addUserToProject`, invites, transfer) checks `operator_access`.

Confirm dialog (shipped text):

> 確定要移除製作對「{專案名}」的存取權嗎？
> 移除後，製作只能看到這個專案的用量和帳單，看不到影片、留言、模型和分享連結。你之後隨時可以再把製作加回來。
> [勾] 一併取消製作建立的分享連結（{N} 條）
> [勾] 一併中斷製作的 Google Drive 連結
> 按鈕：「移除製作」「取消」

### 4.2 What the operator sees afterwards

Project name, org, status, creation date, byte totals by category (already in 系統狀態), billing terms, statements. Nothing else. The operator's own 「我自己」 projects are unchanged. The operator's account stays valid (`users.role = 'admin'`), so there is no way to "lock out" the platform owner from his own platform: only from client content.

### 4.3 Enforceable versus contractual (state this plainly in the privacy policy)

The operator owns the Cloudflare account that hosts the Worker, D1 and R2 and the Vercel account that hosts the frontend. Anyone with those credentials can read raw data and deploy different code. No application feature can change that. So:

**The product enforces (code + tests, visible to the client):**

1. After removal, no HTTP endpoint of the product returns project content to an operator account: project router, comments, member video streams, notifications, search, shows, import-cues, Drive stream, model library, lists (gate inventory 3.4, guard test).
2. The operator cannot re-add himself, create share links on it, invite people into it, or copy content out of it (duplicate / import-cues refuse).
3. The operator cannot silently impersonate a client user through the product: login-code reset for client members is refused; resetting a 客戶管理者's code (recovery) writes `account_reset` to the org log and the other org admins see it; resetting revokes the user's old sessions (existing behaviour); client users never appear with `accessCode` in the operator's user list.
4. Every access, including every operator visit to a project where he is still a member and every denied attempt after removal, is written to a log the operator's API cannot edit or delete, with a daily digest the client can keep (4.4).
5. Share links the operator created can be revoked in the same click as the removal.

**Contractual / not enforceable by the product (say so in 服務條款 and 隱私權政策, section Appendix B):**

1. The operator, as owner of the Cloudflare and Vercel accounts, can technically read D1 and R2 directly, change the Worker code, or edit rows (including log rows). The log proves *product* access; it cannot prove *infrastructure* access. The promise not to do this is a contract term, not a software guarantee.
2. Daily D1 backups (`backups.mjs`) contain every table, including handed-off projects. They are needed for disaster recovery and are downloadable by the operator. They are covered by the same promise and the retention period (30 days, `BACKUP_DEFAULTS.keepDaily`).
3. File URLs that are public capabilities (model files, comment thumbnails and attachments) stay valid for anyone who already received the URL, including the operator before removal. Closing this needs signed, expiring URLs for client-org projects (extend the existing `verifyVideoPass` mechanism to models and images). It is **not** in the four stages; it is recorded as follow-up F1 because the old frontend must first be checked to use API-returned URLs verbatim.
4. A client that needs a hard technical guarantee (for example a broadcaster) needs its own Cloudflare account running its own copy of the platform. This is the only real answer and the spec only mentions it as a sales option.

What the product still gives the client in the contractual cases: the log makes product-level access visible, the daily digest lets the client prove tampering of old rows, and the terms make the promise explicit.

### 4.4 Access log

What is logged (event catalogue). One row per access *window*, not per HTTP request:

| Event | When | Dedupe |
|---|---|---|
| `open_project` | member (or operator) loads `GET /api/projects/:id` (`project.get`) | once per (user, project) per 30 minutes |
| `view_video` | `videos.stream` / `handleMemberVideoStream` first range request | once per (user, video) per 30 minutes |
| `download_model`, `export` | model file fetched through an API-issued URL, project export | every time |
| `share_view` | guest opens a share link (`handleShareRouter` data call) | once per (link, country, ua_class) per 30 minutes; actor is `guest`, `detail` has the link label / slug |
| `denied` | an authenticated operator (or org member of the org) hits a project they have no access to | at most 50 per user per day |
| `member_invited`, `member_joined`, `member_removed`, `member_role_changed`, `org_admin_changed` | org management | every time |
| `account_reset` | login code reset on a 客戶管理者 (operator recovery) | every time |
| `operator_removed`, `operator_regranted` | 4.1 | every time |
| `share_link_created`, `share_link_revoked` | share link management | every time |
| `project_transferred_in`, `project_archived`, `project_restored` | lifecycle | every time |
| `statement_issued`, `cap_changed`, `terms_changed` | operator actions on this org | every time |

Content *mutations* (editing a cue, uploading a video) are not duplicated here; they stay in `activity_log` (0005), visible to every member. The 客戶管理者's 「存取紀錄」 screen shows both feeds side by side (「誰打開過」 and 「誰改過什麼」).

Writing: `accessLog.mjs: logAccess(env, ctx, event, …)`, always through `runInBackground` (never delays the request, a failure only `console.warn`s like `logActivity`). `actor_kind` is derived from the resolver: `operator` when the actor is a global admin, `org_admin` for 客戶管理者, `member`, `guest`, `system`. `detail` goes through `scrubActivityPayload` (no codes, tokens, passwords, share tokens; a share link is referred to by its label or the last 4 characters).

Privacy of the log itself: no IP address is stored. Only `country` (Cloudflare's `cf-ipcountry`) and a coarse `ua_class` are kept so the client can notice an unexpected login location without the platform keeping personal network data. It is described in the privacy policy.

Visibility: the org's 客戶管理者 (all projects of the org), the operator for 「我自己」 projects. Not the operator for client projects (he has the `denied` events he caused, in aggregate: a count in 系統狀態, no rows). A client org never sees another org's log (tested).

Retention: `access_log_keep_days` = 730 days (two years), pruned by the daily cron (batches of 1,000, like `pruneClientErrors`). `access_log_seals` and `statements` are kept indefinitely (statements are accounting records; keep at least the legal retention period — confirm with the accountant).

Tamper evidence: once a day (first cron run after 00:10 Asia/Taipei) the previous day per org is sealed: `digest = SHA-256(prev_digest || canonical JSON of that day's rows ordered by id)`. The digest is shown on the log screen and included in every CSV export. If the operator later edits or deletes a row, the client's saved digest no longer matches a recomputation. This is detection, not prevention (4.3 item 1).

Volume estimate: 30 people × ~6 windows/day × a handful of events ≈ 1–2 k rows/day for a busy org; two years ≈ 1 M rows worst case, a few hundred MB in D1 only if every org is that busy. The retention job and the dedupe windows keep it far below that; the cron reports row counts in 系統狀態 so it can be watched.

---

## 5. Billing

### 5.1 Principles

- All money is integer **NT$** (`currency = 'TWD'` column exists for later). Overage price per GB may have decimals (6.5); every *line amount* is rounded half up to an integer.
- All months are **Asia/Taipei** calendar months (`Asia/Taipei` has no daylight saving; `backups.mjs` already uses a fixed `+8h` offset, do the same).
- GB = 1024^3 bytes, like `lib/storageApi.ts`.
- No price exists in code. Missing terms block issuing a statement; they never fall back to a number in the source.
- A statement is a *snapshot*: after `issued`, its lines never change; later changes to terms or history only affect later months (or a new revision).

### 5.2 Terms per project

`project_billing_terms` (effective-dated): `monthly_fee_twd`, `included_gb`, `overage_twd_per_gb`. Defaults come from `app_settings.billing_default_*` and prefill the form; a project always ends up with its own explicit row. The terms in force for a month are the row with the largest `effective_month <= month`. `projects.billing_start_month` says from which month billing starts (set to the month of creation in a client org, or the month of transfer; never retroactive; the operator can push it later to give free months).

### 5.3 Is a project billable this month? (proration — open question 1)

Active = status `active` or `in_review`. `archived` stops billing. Using `project_status_events` build the active intervals; clip to the month in Asia/Taipei.

| Rule | Fee for a month | Overage average over | Pros / cons |
|---|---|---|---|
| **A. any active day = full month** (recommended default) | full fee if active at least one moment in the month and month >= `billing_start_month` | the days the project was active | Simplest to explain on an invoice; no tiny odd amounts; client avoids it by archiving *before* the 1st. Slightly unfair for a project created on the 30th (fix: `billing_start_month`, or a one-line 折讓). |
| B. daily proration | fee x active days / days in month, rounded half up | the days the project was active | Fairest; every amount needs a calculation shown to the client; archive / restore games change amounts by a few dollars. |
| C. active at month end only | full fee if the status on the last day is active | the days the project was active | A project created Nov 5 and archived Nov 28 is free: easy to abuse. Not recommended. |

Both A and B are implemented behind `billing_proration`; the statement line shows how the fee was computed ("11/01–11/12，使用 12 天"), so switching later or explaining to a client needs no manual math. Every line can carry a manual **adjustment** (negative or positive, with a reason) — that is the escape hatch for any month the rule gets wrong.

### 5.4 Storage measurement and overage (open question 2)

- A daily snapshot `storage_daily` per project: `billable_bytes = live ready videos (song_videos, deleted_at IS NULL) + models + comment images`. Soft-deleted files inside the 30-day recovery window (`storage.mjs PURGE_DAYS`) and anything not attributed to a project are recorded (`deleted_bytes`) but **not billed and not counted toward the cap**: the client who deletes expects the meter to drop, and the platform keeps the 30-day safety net at its own cost. (Open question 2 covers the basis and this point.)
- Models and comment images come from the 6-hourly `storage_usage` scan (same lag as 系統狀態); videos come live from `song_videos`. The cron keeps today's row current (upsert every 30 minutes, gated through `ops_state`); the last write of the day is the day's value.
- Overage per project per month, default basis `daily_average`:
  - `avgGb = round(mean(billable_bytes over the project's active days that have a sample) / 1024^3, 3)`
  - `overageGb = max(0, avgGb - included_gb)` (3 decimals)
  - `amount = roundHalfUp(overageGb x overage_twd_per_gb)`
- Missing sample days (cron down): carry the previous day forward and add a warning to `statements.warnings` (`"11/14–11/15 沒有用量紀錄，用 11/13 的數字代替"`). No sample at all in the month: the draft shows the current live number and a warning; it cannot be issued until the owner accepts or adjusts.
- Alternative bases are one function each: `peak` (largest daily value), `month_end` (value of the last active day).
- Archived projects: no fee, no overage. Their files stay in R2 and **still count toward the org cap** (otherwise "archive everything" would be a free storage plan). A per-GB charge for archived storage is possible later through an optional `billing_archived_twd_per_gb` setting (default empty = 0); the spec does not enable it.

### 5.5 Worked examples

Common terms: Project A 「巡演A」: NT$3,000 / month, 50 GB included, NT$6 per GB over. Project B 「晚會B」: NT$1,500, 20 GB, NT$6. Statement period 2026-11, org 「星河製作」, tax shown separately (open question 5). Rule A and daily-average basis unless stated.

**Example 1 — a normal month with overage.** A is active the whole month. Daily billable usage: days 1–10 = 40 GB, 11–20 = 60 GB, 21–30 = 90 GB.
`avg = (10x40 + 10x60 + 10x90) / 30 = 63.333 GB`; `overage = 63.333 - 50 = 13.333 GB`; `13.333 x 6 = 79.998 -> NT$80`. Lines: 月費 3,000 + 超出空間 80 = **3,080**. (Peak basis would be `(90-50) x 6 = 240`; month-end basis also 240. This is why the basis is an owner decision.)

**Example 2 — a project archived mid-month, rule A versus rule B.** B was created 2026-10-20, archived 2026-11-12 14:00, never restored. Its usage while active averaged 25 GB in November (12 active days), 18 GB in October.
- October (active Oct 20–31 = 12 of 31 days): A -> fee **1,500**; B -> `1,500 x 12/31 = 580.6 -> 581`. Overage: 18 < 20 -> 0.
- November (active Nov 1–12 = 12 of 30 days): A -> fee **1,500**; B -> `1,500 x 12/30 = 600`. Overage: `avg 25 - 20 = 5 GB x 6 = 30`. December onward: archived -> nothing.
- November statement under A: A 3,080 + B 1,530 = **4,610**; under B: 3,080 + 630 = **3,710**. If the owner decides to waive B's overage, one adjustment line of -30 gives 4,580 (A) with the reason printed.

**Example 3 — archive and restore in the same month.** C is archived Nov 3 and restored Nov 20: Rule A bills November **once** (not twice); active days are 3 + 11 = 14, used for the overage average. Rule B bills `fee x 14/30`.

**Example 4 — a free first month.** D is created Nov 28 in a client org with `billing_start_month = 2026-12`: November has no line for D; December is billed in full. The same field covers an existing project transferred into a client org on Nov 15: `billing_start_month` defaults to 2026-11 (or 2026-12 if the owner wants a free month).

**Example 5 — tax and rounding.** If open question 5 is "加稅": subtotal 4,610 x 5 % = 230.5 -> tax **231** (half up), total **4,841**. If it is "價格已含稅": the statement prints 4,610 and a note "金額含營業稅". Rounding is per line, tax is computed once on the subtotal.

**Example 6 — the storage cap.** Org cap 500 GB. Billable usage across all the org's projects, archived ones included: 410 GB -> 82 % -> the 80 % warning is raised once (`cap_80`) and shown to the operator and the 客戶管理者. A 100 GB upload is refused (`410 + 100 > 500`); a 60 GB upload goes through. The client deletes 30 GB of videos: those become soft-deleted, leave the billable count immediately, and a later 100 GB upload (`380 + 100 = 480`) passes.

### 5.6 Statement lifecycle

```
draft --確認出帳--> issued --記錄發票--> invoiced --記錄收款--> paid
  ^                    \----------記錄收款(不開發票)---------^
  |   退回草稿(issued only)                    ^
  +---------------------- void(any state before paid, with reason) -> new revision (draft)
paid --取消收款(with reason)--> invoiced / issued
```

- **Draft**: generated by cron on the 1st of the next month at 04:30 Asia/Taipei for every `billing_enabled` org that has billable projects, and on demand (「產生本月帳單」, which shows a running preview of the current month). Re-generating a draft is idempotent (it replaces lines and warnings). The operator checks it, adds adjustments, resolves warnings.
- **Issued** (「確認出帳」): refused while `warnings` has blocking items (missing terms). Freezes lines and totals, sets `issued_at` and `due_at = issued_at + payment_terms_days`, makes the statement visible to the client org's 客戶管理者. Sends nothing by itself (no email infrastructure exists; the operator sends the printed PDF / CSV, or the client reads it in 我的組織).
- **Invoiced** (「已開發票」): operator types the invoice number and date (the invoice itself is made in his own invoicing tool; the platform does not issue 統一發票).
- **Paid** (「已收款」): amount, date, method (轉帳 / 現金 / 其他) and a note; if `paid_amount_twd != total_twd` the row shows the difference and stays marked "金額不同". Writes a `payments` row with `provider = 'manual'`.
- **Overdue** is derived, never stored: status `issued` or `invoiced` and now > `due_at` -> badge 「逾期」. No automatic suspension in v1. The operator may suspend the org by hand (`orgs.status = 'suspended'`): new uploads and new projects are refused with a clear message, reading, downloading, deleting and exporting keep working. **Client data is never deleted or hidden because of non-payment.**
- **Void** (「作廢」): needs a reason, keeps the row; the same period can then get a new revision (partial unique index `status != 'void'`).
- Every transition writes `statement_events` and, for the client's org, an `access_log` row (`statement_issued` etc.).

### 5.7 Exports

- **CSV** (`GET …/statements/:id.csv`): UTF-8 with BOM so Excel opens Chinese correctly; columns `帳單編號,客戶,月份,專案,項目,說明,數量,單價,金額(NT$)`; then rows 小計 / 調整 / 稅額 / 合計; the seal digest is not included here. One more CSV for the list of statements (`帳單編號,客戶,月份,狀態,小計,稅額,合計,出帳日,發票號碼,收款日`) for the accountant.
- **PDF**: v1 = a print-styled page `/admin/billing/statements/:id/print` (and the client's equivalent) with `@media print`; the user chooses 「列印 → 另存成 PDF」. A server-side PDF needs an embedded CJK font (several MB per Worker bundle) and is deferred (follow-up F2).

### 5.8 Storage cap enforcement points

The cap is `orgs.storage_cap_bytes` against the org's current billable bytes (all its projects, archived included, soft-deleted excluded). Videos are read live from `song_videos`; models and comment images use the last scan plus the size of uploads accepted since (recorded in an `ops_state` counter, not in isolate memory, so the check is not blind for 6 hours). The check is approximate by design (±one concurrent upload); it only ever blocks *adding* bytes.

| Point | Code | Behaviour at >= 100 % (after adding the new size) | Behaviour at >= 80 % |
|---|---|---|---|
| Start a video upload | `createVideoUpload` (~4956; `sizeBytes` is known) | `409 { code: 'org_storage_full' }` before the R2 multipart upload is created | allowed; response carries `orgStorage: { state: 'warn', usedBytes, capBytes }` so the dialog can warn |
| Submit a link / Drive file | `videos.link` + `runVideoCopyJobs` (copy size known only after HEAD) | refuse when already full at enqueue; the copy job re-checks before creating each multipart upload and fails with the same message | allowed |
| Continue an already-started upload (`parts`, `complete`) | `videos.part`, `videos.complete` | **always allowed** (never strand a half-finished upload) | allowed |
| Restore a soft-deleted video | `videos.restore` | refused if it would exceed the cap | allowed |
| New model version / auto-UV apply | `handleModel` PUT, `led-uv` apply | refused | allowed |
| Comment attachment upload | `commentAttachments` upload | refused only when the org is already over the cap | allowed |
| Reads, downloads, deletes, wrap-up, export, comments (text) | everything else | never blocked | never blocked |

80 % warning: `org_alerts` is written once per crossing by the cron right after the storage scan; the operator sees a badge on 客戶 and in 系統狀態, the 客戶管理者 sees a banner on 我的組織 and on the project list (texts in section 6). There is no email in v1. The alert clears (`cleared_at`) when usage falls below 75 % (hysteresis so it does not flap).

Message when blocked (shipped text): 「儲存空間已滿（已用 {used} / {cap}）。請先刪除不需要的舊影片，或聯絡製作增加空間。」

### 5.9 Payment seam (ECPay / TapPay later)

Keep it small and real:

- `cf-worker/payments/index.mjs` exports `getProvider(name)` returning `{ name, createCheckout(statement, org, urls), handleWebhook(request, env) , refund? }`. v1 registers only `manual` (no checkout; `handleWebhook` throws).
- A reserved route `POST /api/payments/:provider/webhook` (no login, signature-verified by the provider module) returns 404 until a provider is registered. It must be listed in `routeRequest` before the generic router like `/api/share/` is, and in the CORS / trusted-origin notes.
- Payment results enter **only** through `recordPayment(env, { statementId, provider, providerRef, amountTwd, status, raw })`, which writes `payments`, moves the statement to `paid` when the amount matches, and appends `statement_events`. The manual 「已收款」 button calls the same function, so a gateway adds a caller, not a new state machine.
- ECPay (form POST + `CheckMacValue`) and TapPay (front-end prime + server `pay-by-prime`) need different front-end steps; the statement page already reserves a 「線上付款」 button slot, hidden until `app_settings.payment_provider` is set. Electronic invoices (電子發票) are a separate integration, out of scope; `invoice_no` is entered by hand.

---

## 6. UI screens (Traditional Chinese labels)

All new screens use the existing admin shell / dialogs / toasts / `Icon`. No native `confirm`/`alert`.

### 6.1 Operator (製作) — `/admin/clients`, `/admin/billing`

- **客戶** list: 客戶名稱 / 專案數 / 已用空間 與 上限 (bar, orange at 80 %, red at 100 %) / 本月預估 / 狀態 (使用中、暫停、已結束). Button 「新增客戶」: dialog fields 客戶名稱、第一位客戶管理者的名字; on save it creates the org and the account and shows the login code once (same pattern as the user page: 「登入碼只會顯示這一次」).
- **客戶 → {名稱}** tabs: 專案 (each row: 名稱、狀態、用量、收費設定、`已交接 · 只看用量與帳單` badge, or the normal editor link while he still has access) / 人員 (read-only list; adding and removing is the client's job; button 「重設客戶管理者的登入碼」 with a warning that it is logged and visible to the client) / 用量與上限 (「空間上限（GB）」 input, 80 % rule text) / 帳單 / 設定 (帳單抬頭、統一編號、Email、地址、付款期限（天）, 暫停).
- Project editor settings → 「所屬客戶」 select and 「交接給客戶」 wizard: 1 選客戶 → 2 檢查成員 (lists members who are not in that org: 「加進這個客戶」 / 「從專案移除」) → 3 設定收費 (月費、含空間 GB、超出每 GB、從哪個月開始) → 4 完成 (explains that the 客戶管理者 can now remove his access).
- 專案收費設定 dialog: 「每月費用（NT$）」「含儲存空間（GB）」「超出每 GB（NT$）」「從哪個月開始」「備註」; prefilled from the defaults in 帳單設定; empty defaults show 「還沒有預設價格，請先到「帳單設定」填」.
- **帳單** `/admin/billing`: month picker, one row per org with status chips 「草稿」「已出帳」「已開發票」「已收款」「逾期」「作廢」, totals, warnings count. Buttons: 「產生本月帳單」「確認出帳」「記錄發票」「記錄收款」「作廢」「匯出 CSV」「列印 / 另存 PDF」. Statement detail shows every line with how it was computed and an 「加調整」 row. Page 「帳單設定」: default prices, 計費方式 (「有用到的月份收整月」 / 「照使用天數算」), 空間用量怎麼算, 稅額.
- 系統狀態 → 空間用量: each project row gets 「收費」 (月費 + 超出) next to the existing cost estimate so the owner sees revenue against cost; handed-off projects show usage only.

### 6.2 Client (客戶管理者) — `/org`

Entry: avatar menu 「我的組織」 (and a banner link when 80 % is reached). Tabs:

- **專案**: cards with 名稱、狀態、已用空間、成員數. A project that the operator can still enter shows 「製作可以看到內容」 and the button 「移除製作的存取權」 (dialog in 4.1). After removal it shows 「製作只能看到用量和帳單」 and 「讓製作回來」.
- **人員**: table 名字、角色（客戶管理者／導演／動畫師）、參加的專案、最後上線. 「邀請」 dialog: 名字、角色、要加入的專案（可多選）→ shows the invite link once (same screen as the user page); 「移除」 asks 「確定要把 {名字} 從所有專案移除嗎？」; 「改成客戶管理者」 / 「改回一般成員」; 「重設登入碼」. A 「製作團隊」 section lists the operator's staff accounts on your projects with 「移除」.
- **存取紀錄**: filters 專案、人、類型（打開專案、看影片、下載、分享連結、人員異動、製作的存取）、日期; rows 時間 / 誰 / 做了什麼 / 專案 / 國家 / 裝置; operator rows carry a 「製作」 badge; denied attempts read 「製作想打開，被擋下」. Buttons 「匯出 CSV」; footer 「封存碼（每天一個）」 with the latest digest and a note 「請定期匯出並自己保存，之後可以用來檢查紀錄有沒有被改過」. Second tab 「異動」 shows `activity_log` (誰改了什麼).
- **用量與帳單**: usage bar with the cap, 「已刪除、30 天內可救回的檔案不算在上限內」; statements list (only issued or later) with 「檢視」 and 「列印 / 另存 PDF」, status chips, due date.

Banners (shipped text): 80 %: 「儲存空間已用 {pct}%（{used} / {cap}）。快滿了，要上傳大檔前請先整理舊影片，或聯絡製作增加空間。」 100 %: 「儲存空間已滿，暫時不能上傳新檔案。可以先刪除不需要的影片，或聯絡製作增加空間。」 Suspended org: 「這個組織目前暫停上傳，請聯絡製作。閱讀和下載不受影響。」

### 6.3 Everyone

`/terms` 「服務條款」 and `/privacy` 「隱私權政策」: public pages (no login), banner at the top: 「這份文件是草稿，正式使用前請務必請律師審閱。」 (hard-coded visible until `app_settings.legal_draft_banner` is set to `off` by the owner after legal review). Links in the login page footer, the invite page (`InvitePage.tsx`, shown before 「進入」), 設定頁 and the org screen. Help page (`Help.tsx`) gets a 「客戶管理者」 chapter.

---

## 7. Compatibility (old production frontend, old Worker)

The Worker is shared by the production frontend (older) and all previews, so every change here must be additive.

| Case | Behaviour |
|---|---|
| Old frontend, operator, 「我自己」 projects | Identical to today (legacy resolver branch). `POST /api/projects` without `orgId` creates in 「我自己」. |
| Old frontend lists / opens a project the operator was removed from | The project is not in `GET /api/projects`; opening a saved link gets `403 沒有權限存取此專案`, which the old frontend already shows as an error. No crash path (it already handles a stranger's 403). |
| Old frontend user page (operator) | Client users appear in `GET /api/users` with extra fields it ignores (`orgId`, `orgName`); their `accessCode` is omitted (the page already tolerates "no code"). Adding a client user to a project through the old page works only inside I2 and returns a plain Chinese error otherwise. |
| `GET /api/auth/me`, `GET /api/projects`, `GET /api/projects/:id` | Only new keys are added (`isOperator`, `orgs`, `orgId`, `orgName`, `handedOff`, `operatorAccess`, `orgStorage`). `myRole` keeps its meaning (a 客戶管理者 gets `'admin'`). |
| Old frontend used by a client | Not supported and not needed: clients are invited only after the new frontend is promoted to production. This is a **release gate** (section 8), the old frontend simply has no 我的組織 screen. |
| New frontend against an old Worker (preview before the Worker deploys) | The org screens feature-detect `orgs` in `/api/auth/me` and stay hidden when absent. |
| Old Worker against the migrated DB (rollback) | Works (extra columns ignored) **but** loses privacy gating: see risk R6. After the first client project is handed off, a rollback below the Stage 2 Worker is forbidden by the release checklist. |
| Invites | Old invite links keep working (`invites.org_id` NULL). An invite created by a 客戶管理者 carries `org_id`; redeem adds the org membership. |
| Share links, video streams | URLs and formats unchanged. |
| `activity_log`, comments, review flows | Unchanged tables and payloads. |
| Production preview rule | New frontend work goes to the Vercel fix-branch URL first, owner confirms, then master (existing deploy practice). The Worker deploy order per stage: migration -> Worker -> frontend preview -> owner OK -> frontend master. |

---

## 8. Upgrade path for existing data

1. **Prerequisite (blocks Stage 1 go-live):** production must already run the new frontend and `app_settings.login_code_storage = 'hashed'` (see `docs/release-checklist.md`). With plain-text login codes the operator can read every client's code, which makes all of the privacy design meaningless. The Stage 1 deploy script checks this and refuses to create the first client org otherwise.
2. **Rehearse on a copy.** Download the latest backup (`/api/admin/backups/<day>.sql.gz`), load it into the `node:sqlite` harness (`cf-worker/testing/d1-sqlite.mjs`), run the new migration, run the equivalence checks (below). There is no staging D1; this is the staging.
3. **Apply the migration** (`ORGS`): creates `org_self`, puts every existing user in it (`u_phang` and other admins as org admin, everyone else as member) and every project and show in it. No project, member, role or share link changes.
4. **Equivalence check, executed against the real DB after the migration and before the Worker deploy:** for every (user, project) pair `resolveProjectAccess` must equal the old `projectRoleOf`; the `GET /api/projects` list per user is byte-identical apart from the new keys; counts of users / projects / project_members are unchanged. Any difference aborts the rollout.
5. **Deploy the Worker** (resolver in place, org endpoints live but with no client orgs): behaviour for everybody is unchanged because every project is 「我自己」.
6. **Create the first client org by hand** with a test org first (a throw-away org, one fake project, two test accounts) and walk the removal flow end to end before any real client.
7. **Moving an existing project into a client org** (`POST /api/admin/projects/:id/transfer`): shows a dry run (members not in the target org, share links, Drive binding), requires billing terms or an explicit 「先不收費」, sets `billing_start_month`, writes `project_transferred_in`. Reversible by the operator only while he still has access.
8. `ORGS`, `PRIVACY`, `BILLING` migrations are deployed one per stage; each stage can sit in production without the next one.
9. Rollback of a migration is not offered (columns and tables are left in place, unused). The only destructive step is the transfer, which is audited.

---

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A missed `role === 'admin'` door leaves operator access after removal (the highest-impact failure). | One resolver, the gate inventory (3.4), the grep guard test, a table-driven matrix test through the real worker with in-memory D1, and a manual walkthrough with a throw-away org before the first real client. |
| R2 | The operator controls the infrastructure (Cloudflare, Vercel, GitHub). | Cannot be fixed in software; stated in 服務條款 / 隱私權政策; seal digests make log tampering detectable; hard guarantee = client-owned deployment (4.3). |
| R3 | Operator impersonates a client by resetting a login code. | Refused for members; for 客戶管理者 recovery it is logged and visible, sessions revoked; recommend two 客戶管理者 per org; hashed codes are a release prerequisite (8.1). |
| R4 | Backups contain every client's data and are downloadable. | Contractual (4.3); retention is 30 days; future option F3: encrypt backup sections per org. |
| R5 | Public capability URLs (models, thumbnails, attachments, share links) outlive membership. | Share links revoked at removal (default); signed URLs recorded as F1. |
| R6 | A Worker rollback removes the gating. | Release checklist forbids rolling back below the Stage 2 Worker after the first hand-off; `GET /api/admin/system-status` shows 「隱私保護：已開啟（版本 {n}）」. |
| R7 | Live-DB migration with no staging environment. | Rehearsal on a restored backup (8.2); additive-only SQL; equivalence check before the Worker deploy. |
| R8 | Money errors: rounding, timezone, missing snapshots, history gaps. | Integer NT$, half-up per line, fixed +8 h months, snapshot warnings that block issuing, frozen statements, fixtures from the worked examples, regenerate-is-idempotent test. |
| R9 | Cap and usage numbers lag (6-hour R2 scan). | Cap checks add recently accepted bytes; documented as approximate; deletes and reads are never blocked. |
| R10 | Access log grows or slows requests. | Visit-window dedupe, background writes, 730-day retention, pruning in cron, row counts in 系統狀態. |
| R11 | Org admin loses access (only admin forgets the code). | Operator recovery reset (logged, visible); I5 keeps at least one admin; recommend two. |
| R12 | Cross-org leakage through shows, cue templates, the model library, search. | `shows.org_id`, `client_visible` assets, predicate 3.3 everywhere, same-org rule for import / duplicate, tests per surface. |
| R13 | Legal: the drafts are not legal advice; 個資法 duties (notice, rights requests, cross-border processors: Cloudflare, Vercel, Google Drive); accounting-record retention; invoicing duties stay with the owner. | Visible draft banner until reviewed; Appendix B lists the clauses a lawyer must settle; the platform records invoice numbers but does not issue invoices. |
| R14 | A freelancer in two client orgs sees both in one account. | Allowed (I6); every project shows its org name; log shows the org; each org admin can only manage their own membership rows. |
| R15 | The dedicated "client" screens add weight to a codebase that is operator-first. | New code lives in new modules (`orgs.mjs`, `accessLog.mjs`, `billing.mjs`, `payments/`) with pure functions and tests, matching `ops.mjs` / `storage.mjs`. |

---

## 10. Test plan

Backend tests use the existing harness (`cf-worker/testing/d1-sqlite.mjs`, `applyMigrations`, route-level style of `framelikeRoutes.test.mjs`) and are added to `cf-worker/package.json` `test`.

1. **Resolver table test** (`orgsAccess.test.mjs`): every combination of `globalRole x memberRole x orgKind x orgRole x operatorAccess` -> expected `role / via / billingOnly`. The matrix in 3.5 is encoded as data (`MATRIX` array) and the same data drives the route test below, so the document and the code cannot drift.
2. **Equivalence/migration test:** build a DB at migration `0037` with realistic data (several users of each role, projects in all statuses, memberships, share links, invites), snapshot `(user, project) -> projectRoleOf` and `GET /api/projects` per user, apply `ORGS`, assert the resolver and the list are unchanged and `org_self` holds every user and project. Re-running the migration is a no-op.
3. **Route matrix test:** through the real Worker `fetch` with in-memory D1: personas (OP in setup, OP-out, CA, PA, PD, PN, OM, G) x one representative endpoint per row of the matrix -> expected status codes (200/201 vs 403/404). Plus: every endpoint in the gate inventory G1–G16 with OP-out returns 403/404 and leaks no content; lists (`projects`, `search`, `shows`, `notifications`, `comments/summary`) never include a handed-off project for OP-out.
4. **Guard test:** greps `worker.js` + `cf-worker/*.mjs` for `role === 'admin'`, `role !== 'admin'`, `globalRole` and `?2 = 'admin'` and fails on any occurrence not in the reviewed allowlist (platform endpoints: users, ops, Drive accounts, library writes, `/api/admin/*`).
5. **Removal flow test:** remove -> operator rows gone, share links revoked per checkbox, operator cannot add himself via `addUserToProject`, invites, transfer, duplicate, import-cues; re-grant by 客戶管理者 restores access; removal is idempotent; the last 客戶管理者 cannot be removed (I5); org member removal clears project rows (I3); I1 and I2 refusals.
6. **Access log tests:** dedupe windows (two loads within 30 min = one row, a load after 31 min = two), `denied` rows capped at 50/day, operator visits flagged `operator`, logging failures never fail the request, `detail` never contains codes / tokens / share tokens, no IP persisted, org A cannot read org B's log (and cannot guess the project ids), seal digest stable and changes when a row is edited, pruning respects retention.
7. **Billing calculation tests:** the six worked examples as fixtures (expected NT$ to the dollar for rule A and B, three bases, adjustment, tax both modes); month boundary exactly at 00:00 Asia/Taipei (events at 15:59:59.999Z / 16:00:00Z); archive/restore sequences; missing snapshot days -> carry-forward + warning; no terms -> blocking warning; terms change mid-history uses the right row; regenerating a draft is idempotent; an issued statement is immune to later changes; property test: line amounts always sum to subtotal; rounding is half-up for positive and negative adjustments.
8. **Lifecycle tests:** every allowed transition and every refused one (e.g. paid -> issued without a reason), `statement_events` written, overdue derivation, unique partial index (one live statement per org per month, revisions after void), CSV (BOM, headers, commas and quotes in project names), client sees only issued-or-later statements of its own org.
9. **Cap tests:** each enforcement point in 5.8 at 79 % / 80 % / 99 % / 100 % boundaries, in-progress upload continues past 100 %, deletes and reads never blocked, restore refused when it would exceed, alert raised once per crossing and cleared with hysteresis, suspended org refuses uploads but serves reads.
10. **Payment seam test:** `recordPayment` is the only writer of `payments`, the manual button and a fake provider webhook produce the same final state, webhook route is 404 with no provider, signature failure is 400.
11. **Frontend tests (vitest, `web/src/test/`):** new screens pass the existing no-emoji / no-English-role-word / no-native-dialog guards; operator-removal dialog text exact; banner thresholds; handed-off project row has no content link; feature-detect hides org UI against an old Worker; CSV/print pages render with fixtures; terms pages show the draft banner until the flag is off.
12. **Manual verification before each stage goes to production** (per the project rule of running a UX review after UI changes): local Worker + local frontend with a throw-away org, walk operator -> hand-off -> client admin -> removal -> operator view of the same project -> access log -> statement issue / invoice / paid -> print preview. Compare the 「我自己」 project list and permissions with a before-snapshot taken on the production Worker.

---

## 11. Task list per stage

Each stage ends with: tests green, preview deploy, owner walkthrough, then production. New docs: `docs/orgs-api.md`, `docs/billing-api.md`, update `docs/release-checklist.md` (rollback rule, hashed-codes prerequisite) and the permission header comment in `access.mjs`.

### Stage 1 — orgs, project ownership, 客戶管理者

- S1-1 Migration `ORGS` (2.1) + `cf-worker/testing` fixture helper `seedOrgs`; migration/equivalence test (test plan 2).
- S1-2 `access.mjs`: `resolveProjectAccess`, new needs (`projectOwner`, `operatorOnly`, `billingOnlyOk`), update `roleMeetsNeed`, `describeProjectRoute` (`invites`, `duplicate`, `restore`, `wrap-up` mapped to the new needs), header comment; resolver table test (1).
- S1-3 `loadProjectContext` + `handleProjectsRouter`: org columns joined, `ctx.access`; replace gate sites G1–G3, G5–G8, G10–G13, G15, G16 with the resolver / predicate (no behaviour change for 「我自己」); guard test (4) with the allowlist.
- S1-4 `orgs.mjs` (pure rules + handlers): `describeOrgRoute`; operator endpoints (`/api/admin/orgs`, create org + first 客戶管理者 + show login code once, rename, suspend), org endpoints (`/api/orgs`, members list, role change, remove with I3, project role changes), transfer endpoint with dry run (8.7), invariants I1–I6; org-management events into `access_log` (table from 2.2 created in this migration).
- S1-5 Invites by 客戶管理者: `describeProjectRoute` `invites` -> `projectOwner`; `invites.org_id`; redeem adds `org_members`; `users` router changes (G10); `createProject` / `importProject` take `orgId`; `authMe` and `listProjects` additive fields.
- S1-6 Frontend: `lib/orgsApi.ts`, `/admin/clients` (list, new client, detail tabs 專案/人員/設定), project editor 「所屬客戶」 + hand-off wizard (steps 1–2, billing step stub), `/org` shell with 專案 / 人員 tabs, avatar-menu entry, feature-detect for old Worker, `landing.ts` unchanged.
- S1-7 Shows / library / templates org scoping (`shows.org_id`, `client_visible`) and tests (R12).
- S1-8 Help chapter for 客戶管理者; `docs/orgs-api.md`; release checklist update.
- Done when: all existing tests + equivalence test pass; creating a throw-away client org, a 客戶管理者, an invite into a project and a member removal all work in the preview; the operator still has implicit access to client projects (removal comes in Stage 2).

### Stage 2 — privacy and access log

- S2-1 Migration `PRIVACY` (2.2).
- S2-2 Resolver switches on `operator_access`: operator no longer gets implicit access to client projects (`billingOnly`); wire G4, G9, G14 and the remaining side doors; operator project list shows handed-off rows as billing rows only.
- S2-3 `DELETE/POST /api/projects/:id/operator-access` (4.1), share-link / invite revocation options, Drive cut; I2 enforcement on every member-adding path; denied-attempt handling.
- S2-4 `accessLog.mjs`: `logAccess` with dedupe, `actor_kind`, scrub, country / ua class; hooks: `project.get`, member video stream, model/export, share views, org events from S1, lifecycle events; denied events.
- S2-5 Seals + pruning cron (`runPrivacyCron` in `scheduled`), `GET /api/orgs/:id/access-log` (filters + cursor), `…/export.csv`, `…/seals`, 系統狀態 row count and 「隱私保護：已開啟」.
- S2-6 Frontend: 我的組織 project actions (remove / bring back dialogs, exact texts), 存取紀錄 tab (+ 異動 tab from `activity_log`), CSV export, operator-side handed-off project row; removal confirmation text tests.
- S2-7 Tests 3, 5, 6; manual walkthrough with a throw-away org (test plan 12).
- S2-8 Privacy policy facts finalised from what is actually logged (feeds S4).
- Done when: with a handed-off throw-away project, an operator token gets 403/404 on every endpoint of the inventory, the client sees both the operator's earlier visits and the denied attempts, and the release checklist rollback rule is written.

### Stage 3 — billing, statements, storage caps

- S3-1 Migration `BILLING` (2.3) + backfills.
- S3-2 `projectStatus.mjs`: write `project_status_events` from `createProject`, `archiveProject`, restore, `updateProject` status changes, duplicate / import; backfill test.
- S3-3 `billing.mjs` pure calculation: active intervals, month clipping (+8 h), rules A / B / C, three bases, overage, rounding, adjustments, tax; fixtures from 5.5; calculation tests (7).
- S3-4 Daily snapshot (`storage_daily`) in `runBillingCron` using `storageSummary` data; carry-forward + warnings; statement draft generation on the 1st; idempotent regenerate.
- S3-5 Statement endpoints and lifecycle (5.6), `statement_events`, CSV (5.7), operator and client read APIs, overdue derivation; lifecycle tests (8).
- S3-6 Cap: `orgStorage.mjs` (usage, cap check), enforcement points (5.8), `org_alerts`, 80 % / 100 % states in `/api/orgs/:id/usage`, banner data in `authMe`/project list; cap tests (9).
- S3-7 `payments/` seam + `recordPayment` + reserved webhook route (5.9); test (10).
- S3-8 Frontend: 專案收費設定 dialog, 帳單 page, statement detail + print page, 帳單設定 page, 客戶 → 帳單 tab, 我的組織 → 用量與帳單, banners, upload dialog messages, 系統狀態 revenue column; frontend tests (11).
- S3-9 `docs/billing-api.md`; owner confirms the prices to type in (the system ships with none).
- Done when: a throw-away org's month can be generated, issued, invoiced and marked paid, CSV opens correctly in Excel, the printed statement matches the CSV to the dollar, and a 100 GB test upload is refused at the cap.

### Stage 4 — terms pages

- S4-1 `/terms` and `/privacy` routes and pages (public, no login), draft banner (hard-coded until `legal_draft_banner = off`), footer links on Login, InvitePage, Settings, org screen.
- S4-2 Draft text in Traditional Chinese from the outline in Appendix B, with the contractual promises of 4.3 and the real logged-data list from S2-8.
- S4-3 Help page links; `docs/` note listing what the lawyer must check.
- S4-4 (optional, only after the lawyer approves) `terms_acceptances` table and a one-time 「我同意」 dialog on first login of invited users, with version number.
- Done when: both pages are public, readable on a phone, and the banner cannot be missed.

---

## 12. Open questions for the owner (max 5)

Answers decide defaults in `app_settings`; each can be changed later without code changes.

1. **收費怎麼算「有用到的月份」？**
   (A) 這個月有任何一天在使用中，就收整個月（建議，最好解釋，帳單沒有零碎金額）
   (B) 照使用天數按比例算（最公平，但每筆都要算）
   (C) 只看月底那天還有沒有在用（容易被鑽漏洞，不建議）
   不管選哪個，每一筆都可以手動「加調整」折讓。

2. **超出的空間，用哪個數字算？**
   (A) 當月每天用量的平均（建議，不會因為一次暫時上傳而多收）
   (B) 當月用量最高的那一天（簡單，但客戶容易覺得被多收）
   (C) 月底那一天的用量
   另外：已經刪掉、還留 30 天可救回的檔案，要不要算進用量？(建議不算，這 30 天的成本由我們自己吸收)

3. **客戶管理者在自己的專案裡可以做到什麼？**
   (A) 等同專案的「製作」：可以改內容、管成員、管分享連結（建議，因為製作被移除後，不然沒有人能改內容）
   (B) 只能管人、看紀錄、看帳單，改內容要先把自己加成專案的製作

4. **空間用到 100% 時要怎麼辦？**
   (A) 只擋「新增檔案」（上傳影片、新模型、留言圖片），其他全部照常（建議）
   (B) 擋新增檔案，而且也暫停這個客戶建立新專案
   (C) 只警告，不擋（上限只是提醒）

5. **帳單金額含不含稅？**
   (A) 價格是未稅，帳單最後另外加 5% 營業稅
   (B) 價格已經含稅，帳單只註明「含營業稅」
   (C) 先不處理，帳單只寫小計，稅由你開發票時自己加

---

## Appendix A — New API surface (summary)

Operator: `GET/POST /api/admin/orgs`, `GET/PATCH /api/admin/orgs/:id` (name, status, cap, billing info), `POST /api/admin/orgs/:id/admin-account` (first 客戶管理者 or recovery reset), `POST /api/admin/projects/:id/transfer`, `GET/PUT /api/admin/projects/:id/billing-terms`, `GET/PUT /api/admin/billing/settings`, `GET /api/admin/billing/statements?period=`, `POST /api/admin/billing/statements/generate`, `POST /api/admin/billing/statements/:id/{issue|invoice|pay|void|revise|reopen}`, `GET /api/admin/billing/statements/:id(.csv)`.
Org (member / admin): `GET /api/orgs`, `GET /api/orgs/:id`, `GET /api/orgs/:id/members` (+ `POST` invite, `PATCH` role, `DELETE`), `GET /api/orgs/:id/usage`, `GET /api/orgs/:id/access-log`, `…/access-log.csv`, `…/access-log/seals`, `GET /api/orgs/:id/statements(/:sid(.csv))`.
Project: `DELETE/POST /api/projects/:id/operator-access`.
Reserved: `POST /api/payments/:provider/webhook`.
Changed (additive): `GET /api/auth/me`, `GET /api/projects`, `GET /api/projects/:id`.

## Appendix B — Terms and privacy outline (for the Stage 4 draft; a lawyer must review)

服務條款: 服務內容與版本; 帳號與登入碼的保管; 客戶、客戶管理者與製作的角色; 專案內容的所有權（客戶內容屬於客戶，平台只為提供服務而儲存）; 製作對客戶內容的存取承諾（移除後不查看內容、存取紀錄的意義、基礎設施層級的限制，見 4.3）; 計費方式（月費、含空間、超出每 GB、封存停止計費、帳單與付款期限、逾期處理、不因欠款刪除資料）; 儲存空間上限與檔案保留（刪除後 30 天可救回、備份保留 30 天）; 終止與資料匯出（結束後保留 30 天供匯出，之後刪除）; 責任限制與服務中斷; 條款修改與通知; 準據法與管轄法院; 聯絡方式。
隱私權政策: 蒐集哪些資料（名字、登入碼的雜湊、專案內容、存取紀錄的國家與裝置類別、前端錯誤回報、分享連結的瀏覽次數）; 使用目的; 不蒐集 IP 位址（登入防猜測用的 IP 處理與保留時間要照實寫）; 委外處理者與跨境傳輸（Cloudflare、Vercel、Google Drive）; 保存期限（存取紀錄 2 年、備份 30 天、帳單依法定年限）; 當事人權利（查詢、更正、刪除、停止處理）與行使方式; Cookie（登入用）; 資料外洩通知; 未成年人; 政策修改。
Each section the lawyer must settle is marked in the draft with a visible 「待律師確認」 tag.

## Appendix C — Messages (shipped text)

- 不是這個專案的成員 / 製作被移除後: 「沒有權限存取此專案」 (unchanged text, same as a stranger).
- 最後一位客戶管理者: 「這個組織至少要有一位客戶管理者，請先指定另一位再移除。」
- 客戶人員被加進別的組織的專案: 「這個人不是這個專案所屬組織的成員，請先邀請他加入組織。」
- 製作想把自己加回已交接的專案: 「這個專案已經交接給客戶，只有客戶管理者可以讓製作回來。」
- 重設客戶管理者登入碼（製作端警告）: 「這個動作會寫進客戶的存取紀錄，客戶管理者看得到。確定要重設嗎？」
- 沒有設定收費就要出帳: 「「{專案名}」還沒有設定收費，請先設定月費和含空間。」
- 缺少某幾天的用量紀錄: 「{日期} 沒有用量紀錄，已用前一天的數字代替。」
- 組織暫停: 「這個組織目前暫停上傳，請聯絡製作。閱讀和下載不受影響。」

## Appendix D — Follow-ups outside the four stages

F1 signed, expiring URLs for models, comment thumbnails and attachments in client-org projects (after checking the old frontend uses API-returned URLs verbatim). F2 server-side PDF with an embedded CJK font. F3 per-org encryption of backup sections. F4 payment gateway (ECPay / TapPay) behind the 5.9 seam, plus electronic-invoice integration. F5 email notifications (80 % warning, statement issued, overdue) once an email path exists. F6 archived-storage fee setting. F7 several 客戶管理者-defined sub-teams (not needed now).
