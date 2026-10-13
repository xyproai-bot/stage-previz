import { useEffect } from 'react';
import { X } from 'lucide-react';
import Icon from './Icon';
import { helpUrl } from '../lib/helpLinks';
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
            <h3>機關（升降台、轉台、滑軌）</h3>
            <ul>
              <li><strong>設定一次</strong>：專案編輯頁右邊「機關」分頁 →「新增機關」：選要帶的物件（可以用 3D 畫面 <kbd>Shift</kbd>+點物件選好幾個）、直線移動或旋轉、往哪個方向、行程、最高速度、常用位置（收起 / 半開 / 全開）</li>
              <li><strong>每個 cue 選位置</strong>：點常用位置、拖滑桿或打數字；沒設的 cue 會沿用前一個 cue（跟物件位置一樣）；<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> 也能復原</li>
              <li><strong>來不及到位</strong>：有填最高速度的機關，轉場太短時會出現橘色提醒，按「照機器速度」把轉場改成夠用的秒數；播放時機器照最高速度走、晚一點到（導演、動畫師看到的一樣）</li>
              <li><strong>裝在別的機關上</strong>：例如轉台上的升降台，在升降台選「跟著另一個機關動」→ 旋轉舞台，轉的時候會一起轉</li>
              <li><strong>匯出機關總表</strong>：CSV，用 Excel 打開；整個專案每首歌、每個 cue、每個機關一行（起點、目標、行程、可用秒數、需要秒數、速度、檢查），給自動化控台操作員</li>
              <li>行程是用公尺算的：先用 3D 工具列的測距把尺寸校準好，畫面上移動的距離才準</li>
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
              <li>LED 沒有畫面（沒有影片、AE 即時、本地檔案）時會顯示測試圖：每塊 LED 的名字、位置、格線</li>
            </ul>
          </section>

          <section>
            <h3>Google Drive</h3>
            <ul>
              <li>製作先在「Drive 來源」連接 Google 帳號（只要一次）</li>
              <li>專案編輯頁上方的「Drive」設定要抓哪個資料夾</li>
              <li>檔名開頭寫歌曲代號（例如 S03_xxx.mp4）就會自動對到那首歌；代號在歌單上看得到、可以改</li>
              <li>每 5 分鐘自動同步，新的或改過的影片會變成那首歌的下一個版本（V1、V2…）</li>
              <li>導演頁會把最新的一版放到 LED 上，有好幾版時可以切換</li>
            </ul>
          </section>

          <section>
            <h3>導演頁</h3>
            <dl>
              <dt><kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd></dt>
              <dd>切 cue（在歌曲頁裡）</dd>
              <dt>「整場串播」</dt>
              <dd>從目前的歌開始依序自動播放，每個 cue 停幾秒可以選</dd>
              <dt>「比較」（小播放器）</dt>
              <dd>選另一個版本（例如 V2 跟 V1），按旁邊的按鈕或 <kbd>C</kbd> 在兩版之間切換，停在同一個時間點、播放 / 暫停照舊；取代以前的「並排對比」（一次只放一支影片，比較順）</dd>
              <dt>「通過 V2」「需修改 V2」</dt>
              <dd>會記下你看的是哪一版；需修改一定要寫原因，原因會發成一則留言、動畫師會收到通知。動畫師交新版後歌會自動回到「審查中」，歌上會出現「有新版 V3」</dd>
              <dt>審片紀錄</dt>
              <dd>留言上方的「審片紀錄」：V2 需修改、V3 已通過…誰、什麼時候、原因</dd>
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
              <li><strong>綁版本</strong>：留言會記在你正在看的那一版（V2 小標籤）；以前沒有版本時的留言寫「舊留言」</li>
              <li><strong>這一版 / 全部</strong>：「這一版」只看這一版的留言、之前版本還沒改好的、在這一版改好的（灰掉）；「全部」看所有留言</li>
              <li><strong>回覆</strong>：每則留言底下可以回覆（一層），原本留言的人會收到通知</li>
              <li><strong>已改好（V3）</strong>：動畫師或製作改好後按，會記下是哪一版改好的；導演覺得還沒好可以按「重新打開」</li>
              <li><strong>篩選 / 排序</strong>：還沒改好 / 已改好 / 全部，依角色、依時間排</li>
              <li><strong>3D 位置</strong>：留言可以釘在物件或場景上，3D 畫面會顯示留言圖釘</li>
              <li><strong>影片時間</strong>：留言可以綁影片的秒數，時間軸上會有小三角形</li>
            </ul>
          </section>

          <section>
            <h3>通知（小鈴鐺）</h3>
            <ul>
              <li>上方的小鈴鐺：有人 @ 你、回覆你、你的歌被退（需修改）或通過、有新版等你審、歌指派給你，都會出現在這裡</li>
              <li>點一則就會打開那首歌、那一版、那則留言；「全部標為已讀」把數字清掉</li>
              <li>每 25 秒自動更新，切回分頁時也會馬上更新；60 天以前的通知會自動清掉</li>
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
              <li>每個人用一組「登入碼」登入，或點製作傳的「邀請連結」直接進專案</li>
              <li>製作可以新增用戶、改名、重設登入碼、指派專案、建立邀請連結</li>
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
          <span className="muted small">
            <a href={helpUrl()} target="_blank" rel="noopener">完整的圖文使用說明（每個角色、每個功能）</a> · 有需求或發現問題，請直接跟我們說
          </span>
          <button className="btn btn--primary" onClick={onClose}>知道了</button>
        </footer>
      </div>
    </div>
  );
}
