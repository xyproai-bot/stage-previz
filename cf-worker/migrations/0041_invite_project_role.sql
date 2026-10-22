-- 邀請連結可以邀「這個專案的製作」（只有新增一個欄位，不重建表、不改舊資料，舊版前端和舊的邀請照樣能用）
--
-- invites.role 有 CHECK（只能 animator / director），表不重建就改不了 → 另外加一欄：
--   project_role — 用了這條邀請之後，這個人「在這個專案」是什麼角色（admin = 這個專案的製作 / director / animator）
--                  NULL = 跟 role 一樣（0041 之前建的邀請都是 NULL，行為完全沒變）
--   role 還是留著：新的人第一次打開時，帳號的預設角色就是它。製作邀請的 role 一律是 animator（最小權限），
--   所以邀請連結永遠不會給出「全站製作」：製作只在這個專案有效（project_members.role = 'admin'），看不到別的專案、管不了用戶。
ALTER TABLE invites ADD COLUMN project_role TEXT CHECK(project_role IS NULL OR project_role IN ('admin', 'animator', 'director'));
