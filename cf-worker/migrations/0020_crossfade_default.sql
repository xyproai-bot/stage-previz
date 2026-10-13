-- cue 淡入淡出秒數：以前 0 代表「用預設 1 秒」，現在 0 代表「硬切（不淡入淡出）」。
-- 舊資料裡的 0 都是「預設」的意思 → 改成明確的 1 秒，畫面看起來跟以前一樣。
-- （正式前端本來就把 0 和 1 當成一樣，改了看不出差別）
UPDATE cues SET crossfade_seconds = 1 WHERE crossfade_seconds = 0;

-- cue 模板（cue_templates.payload 是 JSON）裡的 crossfadeSeconds 也一樣
UPDATE cue_templates
   SET payload = json_set(payload, '$.crossfadeSeconds', 1)
 WHERE json_valid(payload) AND json_extract(payload, '$.crossfadeSeconds') = 0;
