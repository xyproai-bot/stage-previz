---
name: stage-previz-dispatch
description: Use BEFORE starting or resuming any background agent (Agent tool / SendMessage resume) for the stage-previz project, and before releasing to the test or production site. Cost-control rules for delegating work (the owner pays per usage and hit his monthly limit twice), a lean agent prompt template, verification budget, and the exact release commands.
---

# stage-previz 派工規則（省用量）

用戶在意用量：10-15 月額度爆兩次；10-22 一個長壽建模 agent 背著 67 萬 token 的歷史改小東西，用戶說「太恐怖了」。每次要派工、續工、上線之前，照這份走。

## 1. 先問：要不要派 agent？

- **自己改**：一兩個檔案、幾十行以內、已經知道改哪裡（文案、樣式、加一個按鈕、小 bug）。直接改 → tsc + 相關測試 + 全部 vitest 一次 + build → 推。
- **派 agent**：要跨很多檔案、要查很多程式、要做瀏覽器實測、要動後台 / 資料庫。
- **先收齊需求再派**：用戶常常一句一句補需求。能等的就先記下來，湊成一次交代；不要每補一句就叫回去改一次。

## 2. 派新的，不要一直叫回舊的

- 一個 agent 只做一段有邊界的工作，做完就結束。
- **不要對長壽 agent 一直 SendMessage 續工。** 看完成通知裡的 `subagent_tokens`：超過約 30 萬，就請它寫交接說明（做了什麼、檔案在哪、怎麼重做、地雷），然後結束；之後的修改開新的 agent，只讀交接說明。
- 例：案例 1 建模的交接說明在 `C:\Users\phang\stage-previz-work\case1\scripts\README.md`。之後這個舞台的修改，開新的 sonnet agent，先讀它和 `out\建模說明.md`。

## 3. 選模型

- 預設 `model: "sonnet"`。
- 只有「新的設計、難的幾何 / 渲染、卡很久的 bug」才用預設的大模型。

## 4. 同時跑幾個

- 最多 2～3 個，而且改的檔案不能重疊（例如兩個都改 StageScene.tsx 就排隊）。
- 不要輪詢 agent 進度，等完成通知。用戶問進度時，看輸出資料夾的檔案時間就好，不要讀 agent 的 transcript。

## 5. agent prompt 範本（精簡）

```
目標：<一句話>
先讀（只讀這些）：<檔案路徑>
要做：<條列，含畫面文字（繁中）>
規則：繁中介面、不用 emoji（用 <Icon/>）、不用原生對話框、畫面不出現英文角色字（守門測試會擋）；
      不重建 / 不刪資料表，migration 用下一個空號；舊版前端要能用；
      commit 用中文、不加署名；LED 顏色不能變（動到 LED 就跑 web/scripts/led-color-accuracy.mjs 前後比）。
驗證（精簡）：tsc、新測試、全部 vitest 一次、build；後台有改跑 cf-worker node 測試；
      瀏覽器最多實測一次、截圖 1～2 張。
上線：<見第 7 節，照抄指令>
回報：簡短。做了什麼、部署資訊、哪些沒驗證到。
```

## 5.5 找程式先查關係圖（graphify）

- 專案根目錄有 `graphify-out/graph.json`（程式關係圖，只含 web + cf-worker 的程式，不含文件和圖片）。
- 要找「X 在哪 / 誰呼叫 Y / 改 Z 會影響哪些地方」：先在專案根目錄跑 `graphify query "<問題>"`（或 `graphify path "A" "B"`、`graphify explain "X"`），拿到相關檔案和行號再只讀那幾段，不要一次 grep / 讀一堆檔。派 agent 時在 prompt 的「先讀」加一句：先用 graphify query 找位置。
- 程式改了很多之後（例如一整批功能上線後），在專案根目錄跑一次 `/graphify . --update`（只重新分析改過的程式檔，不花用量）讓圖保持新鮮。
- 圖只是地圖：結論還是要用實際程式碼確認。

## 6. 驗證看大小

- 小修：tsc + 相關測試 + build。
- 一般功能：再加全部 vitest 一次 + 一次瀏覽器實測。
- 動到 LED 畫面：一定要跑顏色量測，前後一樣。
- 不要拍一堆截圖、不要每一步都開瀏覽器。

## 7. 上線（用戶 10-22 授權：測過的修正和小功能可以直接上正式，推完跟他說）

大改、動資料或權限的先放測試站，並告訴用戶。

**前後台共用的規則檔（改了＝後台也變了）：** 後台直接 import 這些 `web/src/lib/` 檔案，只要動到其中任何一個，**網站和後台一律一起上線**（照下面「後台有改」走完再上網站），不能只上網站，不然兩邊會用兩套規則：
`stageProps.ts`、`cameraBookmarks.ts`、`review/attachmentRules.ts`、`review/stickerRules.ts`、`loginCodeRules.ts`、`mechanisms/`（`model.ts`、`convert.ts`、`group.ts`、`hoist.ts`、`hoistRig.ts`）、`ledTemplate.ts`、`ledCanvas.ts`、`ledCabinet.ts`、`ledTemplateTimeline.ts`、`videoFingerprint.ts`、`watermark/policy.ts`、`shareSlug.ts`。
清單會變：上線前用 `grep -rn "from '../web/src/" cf-worker --include=*.mjs --include=*.js` 確認，跟 `git diff --name-only` 比對有沒有交集。派 agent 時把這條寫進 prompt。

**後台有改（cf-worker）：**
1. 備份 D1 → `C:\Users\phang\stage-previz-backup\`（不要放 Temp，會被清掉）
   `npx wrangler d1 export stage-previz-db --remote --output C:\Users\phang\stage-previz-backup\before-<事>-<日期>.sql`
2. 套 migration（如果有）
3. rebase 到最新 origin/feat/live-stage-look → 全部測試 → push
4. 部署前 `git fetch`，確認 origin == HEAD、工作目錄乾淨（正式站登入碼是雜湊的，絕對不能部署比 origin 舊的 worker）
5. 在 cf-worker/ 跑 `npx wrangler deploy`，用沒登入的請求確認回 401

**前端（兩個站都在 Cloudflare Pages，不會自動部署）：**
```
git push origin HEAD:feat/live-stage-look
git push origin HEAD:refs/heads/master        # 先確認 master 可以快轉
cd web && npm run build
node scripts/pages-deploy.mjs stage-previz-test feat/live-stage-look <sha>
node scripts/pages-deploy.mjs stage-previz-prod master <sha>
```
`pages-deploy.mjs` 會保留前 45 天的程式檔，開著的舊分頁不會壞。上線後提醒用戶重新整理。

## 8. 回報給用戶

- 全中文、白話、不丟術語；有截圖就用 SendUserFile 給。
- 說清楚：改了什麼、怎麼用、要他做什麼、哪裡還沒驗證。
