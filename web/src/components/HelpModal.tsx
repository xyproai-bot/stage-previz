import { useEffect } from 'react';
import './HelpModal.css';

export default function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <header className="help-modal__head">
          <h2>使用說明</h2>
          <button className="dialog__close" onClick={onClose}>×</button>
        </header>
        <div className="help-modal__body">
          <section>
            <h3>🌍 全域</h3>
            <dl>
              <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd></dt>
              <dd>開啟「快速搜尋 / 切換」面板（找專案、Show、cue、物件）</dd>
              <dt><kbd>?</kbd></dt>
              <dd>開啟此說明</dd>
            </dl>
          </section>

          <section>
            <h3>📁 專案編輯器（在某個 project 內）</h3>
            <dl>
              <dt><kbd>J</kbd> / <kbd>K</kbd></dt>
              <dd>切到下一首 / 上一首歌</dd>
              <dt><kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd></dt>
              <dd>切到下一個 / 上一個 cue</dd>
              <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd></dt>
              <dd>Undo（最近 50 步 cue 位置改動）</dd>
            </dl>
          </section>

          <section>
            <h3>🎮 3D Viewport</h3>
            <dl>
              <dt><kbd>W</kbd> / <kbd>E</kbd> / <kbd>R</kbd></dt>
              <dd>切換 移動 / 旋轉 / 縮放 工具</dd>
              <dt><kbd>Q</kbd></dt>
              <dd>切換 World / Local 軸向</dd>
              <dt><kbd>L</kbd></dt>
              <dd>顯示 / 隱藏物件 label</dd>
              <dt><kbd>Esc</kbd></dt>
              <dd>取消選取</dd>
              <dt>點物件</dt>
              <dd>單選</dd>
              <dt><kbd>Shift</kbd>+點物件</dt>
              <dd>加 / 減選（多選）</dd>
              <dt>多選後拖 gizmo</dt>
              <dd>所有選中物件一起移動 / 旋轉</dd>
            </dl>
          </section>

          <section>
            <h3>🎬 Cue 系統</h3>
            <ul>
              <li><strong>Cue tracking</strong>：cue 沒設某物件位置時，會自動繼承同 song 內前一個 cue 的位置（不是回到 default）</li>
              <li><strong>Cue 模板（💎）</strong>：把常用 cue 存成模板，新 cue 可從模板一鍵套用，跨專案也可用（全域模板）</li>
              <li><strong>Crossfade</strong>：cue 設 crossfade 秒數後，切換 cue 時 mesh 位置 / 角度會平滑過渡（不再硬切）</li>
              <li><strong>Storyboard</strong>：topbar「🎬 Storyboard」可一覽該歌所有 cue 縮圖；自動從 3D 場景抓圖存 localStorage</li>
            </ul>
          </section>

          <section>
            <h3>✨ 渲染模式</h3>
            <ul>
              <li><strong>⚡ Quick</strong>：純色 PBR，快但沒 LED 發光</li>
              <li><strong>🎬 Realistic</strong>：LED 發光、HDR 環境貼圖、ACES tone mapping</li>
              <li><strong>✨ Cinematic</strong>：Realistic + Bloom 後處理（LED 真的「溢光」）</li>
              <li>StageScene 工具列點 mode 按鈕循環切換</li>
            </ul>
          </section>

          <section>
            <h3>📺 NDI 即時預覽（動畫師端）</h3>
            <ul>
              <li>動畫師端跑 <code>stage-previz-ndi-helper.exe</code> 後，LED 板會顯示 AE 的 NDI 即時內容</li>
              <li>StageScene 工具列「○ NDI 等待中 / ● LIVE NDI」綠點 — 點開 popover 看狀態、選來源、重連</li>
              <li>沒接 NDI 時 LED 顯示彩色掃描線 mock（避免黑屏）</li>
            </ul>
          </section>

          <section>
            <h3>☁ Drive 整合</h3>
            <ul>
              <li>admin 在 <code>/admin/drive-sources</code> 連 Google 帳號（一次）</li>
              <li>專案編輯器 topbar「☁ Drive」設 Drive 資料夾 + 檔名規則（預設 <code>^S(\d+)_</code>）</li>
              <li>每 5 分鐘自動同步；新版本影片自動分到對應歌曲</li>
              <li>導演端 SongDetail 自動顯示最新影片，多版本可下拉切換、可「⊞ 並排對比」V1 vs V2</li>
            </ul>
          </section>

          <section>
            <h3>🎤 導演端</h3>
            <dl>
              <dt><kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd></dt>
              <dd>切 cue（在 SongDetail 內）</dd>
              <dt>「🎤 整場串播」</dt>
              <dd>從目前歌曲依序自動推進，每 cue 停留 N 秒</dd>
              <dt>影片 ▲ pin</dt>
              <dd>留言時間軸位置；hover 看預覽，點擊跳到對應留言</dd>
              <dt>「💬 在 X 加留言」</dt>
              <dd>留言會綁定當前影片時間，list 顯示 📍</dd>
              <dt>「📍 3D 留言」</dt>
              <dd>StageScene 工具列開啟 → 點 3D 物件 / 空白 → 留言綁定 mesh / world 座標，視角變了 pin 跟著走</dd>
              <dt>「🔗 分享」</dt>
              <dd>建公開連結（admin 端）：寄給外部人看 read-only 預覽，可設密碼 / 期限</dd>
            </dl>
          </section>

          <section>
            <h3>💬 留言</h3>
            <ul>
              <li><strong>篩選 / 排序</strong>：未解決 / 已解決 / 全部 × 角色 × 時間排序</li>
              <li><strong>已解決標記</strong>：點留言旁邊「✓」切換 open / resolved（記下誰解決 + 何時）</li>
              <li><strong>3D 錨點</strong>：留言可貼在物件 / 場景座標上，3D viewport 顯示 💬 pin</li>
              <li><strong>影片時間</strong>：留言可綁影片秒數，時間軸顯示 ▲</li>
            </ul>
          </section>

          <section>
            <h3>🥽 WebXR</h3>
            <ul>
              <li>Quest 瀏覽器 / 支援 WebXR 的桌面瀏覽器：StageScene 右下角會出 VR 按鈕</li>
              <li>戴上頭盔直接走進舞臺（cinematic 模式自動 fallback 為單純 render）</li>
            </ul>
          </section>

          <section>
            <h3>👥 用戶 / 權限</h3>
            <ul>
              <li>每個用戶一組「號碼」（access code）登入，沒有密碼</li>
              <li>admin 可以建用戶、改名、改號碼、指派專案</li>
              <li>非 admin 用戶只看到 admin 指派的專案</li>
              <li>所有操作都會記在「最近活動」（audit log）</li>
            </ul>
          </section>

          <section>
            <h3>📦 模型 / 資產</h3>
            <ul>
              <li>每個專案可上傳一個 .glb / .gltf；舊版本自動保留，可隨時切回</li>
              <li>模板庫（共用資產）：admin 上傳一份，多個專案共用同一個 model（不重複佔空間）</li>
              <li>LED 板會在 Realistic 模式發光投影到周圍物件</li>
            </ul>
          </section>

          <section>
            <h3>🎫 Show 巡迴</h3>
            <ul>
              <li>Show 是巡迴的母體：一個 Show 可包含多個專案（每場一個專案）</li>
              <li>從「📋 複製專案」可以快速複製整棵樹開新場次</li>
            </ul>
          </section>
        </div>
        <footer className="help-modal__foot">
          <span className="muted small">需求 / 回報問題 → 直接跟 admin 說</span>
          <button className="btn btn--primary" onClick={onClose}>知道了</button>
        </footer>
      </div>
    </div>
  );
}
