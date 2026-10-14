# 前端從 Vercel 搬到 Cloudflare Pages（照著點就好）

為什麼搬：Vercel 的 Hobby（免費）方案不能商用。後端（proxy.haimiaan.com 的 Worker）不動，網址也不變，使用者不會感覺到差別。

程式這邊已經準備好了（`web/public/_headers`、`web/public/_redirects`，建置時會自動帶進網站）。**下面是你要在 Cloudflare 網頁上點的步驟。Vercel 完全不要動，留著當退路。**

## 先看懂：要建兩個專案

| | 測試站 | 正式站 |
|---|---|---|
| Pages 專案名稱 | `stage-previz-test` | `stage-previz` |
| 正式分支（Production branch） | `feat/live-stage-look` | `master` |
| 自訂網域 | `test.previz.haimiaan.com` | `previz.haimiaan.com` |
| 暫時網址（Cloudflare 自動給） | `stage-previz-test.pages.dev` | `stage-previz.pages.dev` |

**順序：先做測試站，確認沒問題，再做正式站。** 兩個專案的步驟一模一樣，只有上表的名字不同。

## 一、建立專案（每個專案做一次）

1. 登入 Cloudflare，左邊選 **Workers & Pages**。
2. 按 **Create**（建立應用程式）。
3. 找 **Pages**：畫面下方有一行小字「Looking to deploy Pages? **Get started**」，按它；再選 **Import an existing Git repository**。（畫面偶爾會小改，認英文關鍵字就好。）
4. 第一次會要你連 GitHub：按 **Connect GitHub**，在跳出的 GitHub 頁面授權 Cloudflare，**只勾這個倉庫 `xyproai-bot/stage-previz`**，按 Install / Save。
5. 回到 Cloudflare 選 `xyproai-bot/stage-previz`，按 **Begin setup**。
6. 填設定（照上面的表）：
   - **Project name**：`stage-previz-test` 或 `stage-previz`
   - **Production branch**：`feat/live-stage-look` 或 `master`
   - **Framework preset**：選 **None**（無）
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`
   - **Root directory**（展開 Advanced / 進階才看得到）：`web`
   - **Environment variables**（環境變數）：按 Add variable，新增一個
     - 名稱 `NODE_VERSION`　內容 `22`（指定用哪一版 Node，保險用）
   - 預覽分支（Preview branches）如果有這個選項，選 **None**（不要為其他分支另外建網站）。沒有這個選項就跳過。
7. 按 **Save and Deploy**，等 1～3 分鐘，狀態變 **Success**。

**要從 Vercel 抄過來的環境變數：沒有。** 前端程式沒有用任何 `VITE_` 開頭的變數（後端網址 `proxy.haimiaan.com` 寫在程式裡）。保險起見，你可以開 Vercel 專案 → Settings → Environment Variables 看一眼，如果裡面其實有東西，把**名稱**告訴我，我確認要不要帶過去（內容不用貼給我）。

## 二、先用暫時網址看一眼（還沒換網域）

打開 `https://stage-previz-test.pages.dev`（正式站就是 `stage-previz.pages.dev`）：

- 網站出得來、舞臺畫面能顯示。
- 在網址後面隨便加一段，例如 `/admin/projects/abc` 再按 F5：應該還是我們的網站（登入頁或站內的找不到頁），**不是** Cloudflare 的白底 404。

注意：暫時網址上**登入和後端功能會失敗，這是正常的**（後端目前只認我們自己的網域和 Vercel 的網址，還不認 `pages.dev`，見最後一節）。所以完整檢查要等換好網域之後。

## 三、換網域（這一步使用者會真的改到網站）

1. 進到專案（例如 `stage-previz-test`）→ **Custom domains** 分頁 → **Set up a custom domain**。
2. 輸入 `test.previz.haimiaan.com`（正式站輸入 `previz.haimiaan.com`），按 Continue。
3. **這個網域現在的 DNS 記錄是指向 Vercel 的**（通常是 CNAME 指向 `cname.vercel-dns.com`，或 A 記錄 `76.76.21.21`，以你畫面上看到的為準）。Cloudflare 會告訴你要把它改成指向 `stage-previz-test.pages.dev`：
   - 如果畫面有 **Update DNS record / Activate domain** 之類的按鈕，按它（它會把舊記錄換成新的）。
   - 如果說「已經有同名記錄」，就到左邊 `haimiaan.com` 網域 → **DNS → Records**，找到 `test.previz`（正式站找 `previz`），**先把舊記錄的類型、名稱、內容拍照或抄下來（回滾要用）**，再把它刪掉，回 Pages 重新按 Activate。
   - 找不到 previz 的 DNS 記錄，或畫面跟這裡差很多：先停下來問我。
4. 等網域狀態從 Verifying 變成 **Active**（綠色，通常幾分鐘，最久約一小時）。
5. 切換的那一刻起，這個網域的人看到的就是 Cloudflare 上的版本。Vercel 那邊的網域設定**不要刪**，它會顯示「設定無效」，不用理它。

## 四、怎麼確認成功（在自訂網域上）

1. 打開 `https://test.previz.haimiaan.com`（正式站 `https://previz.haimiaan.com`），可以登入。
2. 開一個專案：3D 舞臺出得來、LED 畫面有顏色、影片能播（這樣代表模型和解壓縮器都正常）。
3. 在專案裡的深層網址按 F5，還是原本那頁。
4. 開 `/help` 說明頁，圖片都在。
5. 想確定真的是 Cloudflare：網頁按 F12 → Network，點第一個請求，標頭裡有 `server: cloudflare`、**沒有** `x-vercel-id`。
6. 如果登入後看到舊畫面：按 Ctrl + Shift + R 強制重新整理一次（網站有離線快取）。

測試站都正常再做正式站，正式站建議挑沒人在用的時段。

## 五、出問題怎麼退回 Vercel

Vercel 上的專案和網域設定都沒動，所以退回只要把 DNS 改回去：

1. Cloudflare → `haimiaan.com` → **DNS → Records**，找到 `test.previz`（或 `previz`）那筆指向 `pages.dev` 的記錄。
2. 把它改回之前抄下來的 Vercel 記錄（類型、名稱、內容照舊值）；如果當初是刪掉的，就重新新增一筆一模一樣的。
3. 幾分鐘內網站就回到 Vercel。Pages 專案和自訂網域可以先留著，不用急著刪。
4. 告訴我，我會幫你查原因。

## 六、之後由我處理的事（你不用動手）

後端的白名單（`cf-worker/origins.mjs`、`cf-worker/worker.js` 的登入跳回網址檢查、NDI 小程式的 `ws_server.rs`）目前**不認 `*.pages.dev`**，所以只有 `pages.dev` 暫時網址不能登入。自訂網域不受影響，正式站和測試站不會壞。

如果之後想在 `pages.dev` 網址上完整測試，告訴我，我再把 `pages.dev` 加進白名單（後端要重新發佈；NDI 小程式要出新版才認得）。Vercel 的白名單等搬家穩定、確定不退回之後再拿掉。
