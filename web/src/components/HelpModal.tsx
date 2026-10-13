import { useEffect } from 'react';
import { X } from 'lucide-react';
import Icon from './Icon';
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
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="help-modal__body">
          <section>
            <h3>全站</h3>
            <dl>
              <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd></dt>
              <dd>快速搜尋 / 切換（找專案、Show、cue、物件）</dd>
              <dt><kbd>?</kbd></dt>
              <dd>打開這個說明</dd>
            </dl>
          </section>

          <section>
            <h3>專案編輯頁</h3>
            <dl>
              <dt><kbd>J</kbd> / <kbd>K</kbd></dt>
              <dd>切到下一首 / 上一首歌</dd>
              <dt><kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd></dt>
              <dd>切到下一個 / 上一個 cue</dd>
              <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd></dt>
              <dd>復原（這個 cue 最近 50 步的位置 / 角度 / 顯示改動；換 cue 不會改到別的 cue）</dd>
              <dt><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 或 <kbd>Ctrl</kbd>+<kbd>Y</kbd></dt>
              <dd>重做（把剛剛復原的再做一次）</dd>
            </dl>
          </section>

          <section>
            <h3>3D 畫面</h3>
            <dl>
              <dt><kbd>W</kbd> / <kbd>E</kbd></dt>
              <dd>切換 移動 / 旋轉 工具</dd>
              <dt><kbd>Q</kbd></dt>
              <dd>切換 世界座標軸 / 物件自己的軸</dd>
              <dt><kbd>L</kbd></dt>
              <dd>顯示 / 隱藏物件名稱</dd>
              <dt><kbd>X</kbd></dt>
              <dd>線框模式（看穿模型）</dd>
              <dt><kbd>Esc</kbd></dt>
              <dd>取消選取</dd>
              <dt>點物件</dt>
              <dd>單選</dd>
              <dt><kbd>Shift</kbd>+點物件</dt>
              <dd>加選 / 減選（多選）</dd>
              <dt>多選後拖控制器</dt>
              <dd>所有選中的物件一起移動 / 旋轉</dd>
              <dt>重置攝影機</dt>
              <dd>工具列的攝影機按鈕：回到設定好的畫面（旁邊的小箭頭可以設定這個畫面）</dd>
            </dl>
          </section>

          <section>
            <h3>Cue</h3>
            <ul>
              <li><strong>沿用前一個 cue</strong>：cue 沒設某個物件的位置時，會沿用同一首歌前一個 cue 的位置（不會跳回預設位置）</li>
              <li><strong>轉場</strong>：每個 cue 可以設轉場秒數，換 cue 時物件會在這段時間內滑過去；0 秒 = 直接切換</li>
              <li><strong>常用擺位</strong>：在 cue 旁邊按書籤圖示，把這個 cue 的物件位置存起來；新增 cue 時選「從常用擺位建立」就能套用，也可以給所有專案共用</li>
              <li><strong>分鏡</strong>：上方「分鏡」可以一次看這首歌所有 cue 的縮圖，也能匯出 PDF</li>
            </ul>
          </section>

          <section>
            <h3>畫面模式</h3>
            <ul>
              <li><strong>快速</strong>：LED 顏色跟 AE 一樣（像素 1:1），看得最清楚</li>
              <li><strong>現場</strong>：暗場、LED 照亮周圍、光暈，比較像演出當天的樣子</li>
              <li>現場模式的「設定」可以調底光、曝光、LED 照明、光暈、倒影（只影響你自己看到的）</li>
            </ul>
          </section>

          <section>
            <h3>AE 即時（NDI）</h3>
            <ul>
              <li>動畫師的電腦開著 NDI 小程序，3D 舞台的 LED 就會即時顯示 AE 的畫面</li>
              <li>3D 畫面上方的 NDI 標示：綠色實心點 = 正在播、空心點 = 等待中；點一下可以看狀態、選來源、重新連線</li>
              <li>還沒接上 AE 時，LED 會顯示彩色的示意畫面（不會全黑）</li>
            </ul>
          </section>

          <section>
            <h3>Google Drive</h3>
            <ul>
              <li>製作先在「Drive 來源」連接 Google 帳號（只要一次）</li>
              <li>專案編輯頁上方的「Drive」設定要抓哪個資料夾、檔名規則</li>
              <li>每 5 分鐘自動同步，新版本的影片會自動分到對應的歌</li>
              <li>導演頁會自動顯示最新的影片，有好幾版時可以切換、並排對比</li>
            </ul>
          </section>

          <section>
            <h3>導演頁</h3>
            <dl>
              <dt><kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd></dt>
              <dd>切 cue（在歌曲頁裡）</dd>
              <dt>「整場串播」</dt>
              <dd>從目前的歌開始依序自動播放，每個 cue 停幾秒可以選</dd>
              <dt>時間軸上的小三角形</dt>
              <dd>留言的時間點；滑鼠移上去看內容，點一下跳到那則留言</dd>
              <dt>「在 00:12 加留言」</dt>
              <dd>留言會綁在目前的影片時間</dd>
              <dt>「3D 留言」</dt>
              <dd>在 3D 畫面點物件或空白處，留言會釘在那個位置，轉視角也會跟著</dd>
              <dt>「分享」</dt>
              <dd>製作建立公開連結：外部的人不用登入就能看（只能看不能改），可以設密碼和期限</dd>
            </dl>
          </section>

          <section>
            <h3>留言</h3>
            <ul>
              <li><strong>篩選 / 排序</strong>：未解決 / 已解決 / 全部，依角色、依時間排</li>
              <li><strong>已解決</strong>：按留言旁邊的打勾圖示，切換「已解決 / 未解決」（會記下是誰、什麼時候）</li>
              <li><strong>3D 位置</strong>：留言可以釘在物件或場景上，3D 畫面會顯示留言圖釘</li>
              <li><strong>影片時間</strong>：留言可以綁影片的秒數，時間軸上會有小三角形</li>
            </ul>
          </section>

          <section>
            <h3>VR</h3>
            <ul>
              <li>支援 VR 的瀏覽器（例如 Quest）：3D 畫面右下角會出現「進入 VR」按鈕</li>
              <li>戴上頭盔就能直接走進舞台</li>
            </ul>
          </section>

          <section>
            <h3>用戶與權限</h3>
            <ul>
              <li>每個人用一組「號碼」登入，沒有密碼</li>
              <li>製作可以新增用戶、改名、改號碼、指派專案</li>
              <li>動畫師和導演只看得到被指派的專案</li>
              <li>重要的操作都會記在「最近活動」</li>
            </ul>
          </section>

          <section>
            <h3>模型</h3>
            <ul>
              <li>每個專案可以上傳一個 .glb / .gltf；舊版本會自動留著，隨時可以切回</li>
              <li>模型庫：製作上傳一份，多個專案共用同一個模型（不重複佔空間）</li>
              <li>LED 在「現場」模式會發光，照亮周圍的物件</li>
            </ul>
          </section>

          <section>
            <h3>Show 巡迴</h3>
            <ul>
              <li>Show 是一整個巡迴：一個 Show 底下可以放好幾個專案（每場一個）</li>
              <li>專案卡片的「複製專案」可以快速複製整個專案，開新的場次</li>
            </ul>
          </section>
        </div>
        <footer className="help-modal__foot">
          <span className="muted small">有需求或發現問題，請直接跟我們說</span>
          <button className="btn btn--primary" onClick={onClose}>知道了</button>
        </footer>
      </div>
    </div>
  );
}
