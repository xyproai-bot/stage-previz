// 動畫師上手教學頁（/tutorial/animator）的內容資料。頁面：pages/AnimatorTutorial.tsx（只負責排版）。
//   每一句事實都能在 pages/Help.tsx 或程式裡找到根據；按鈕、選單、解析度這些字直接用程式裡的常數，改了不會對不上。
//   第二階段換短片：把 step 的 media 從 image 換成 clip（TutorialMedia 會處理），頁面不用改。
//   第三階段的教學影片做好之後，把 ANIMATOR_TUTORIAL_VIDEO 填上（不是 null 頁面才會顯示影片那一塊）。
import type { ReactNode } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import Icon from '../../components/Icon';
import { HELP_ANCHORS as A, type HelpAnchor } from '../helpLinks';
import { FIGS, type FigKey } from '../../pages/helpFigures';
import { NDI_HELPER_DOWNLOAD_URL, NDI_HELPER_DOWNLOAD_URL_MAC, NDI_TOOLS_URL } from '../downloads';
import { PERMISSION_PROMPT_TEXT, permissionFixSteps } from '../ndiSteps';
import { ledMapMenuLabel } from '../ledMapMenuText';
import { RECORD_RESOLUTIONS, WEBM_NOTE } from '../stageRecording';

export type TutorialMediaItem =
  | { kind: 'image'; src: string; alt: string; width?: number; height?: number }
  | { kind: 'clip'; src: string; poster: string; alt: string; width?: number; height?: number };

export interface TutorialStep {
  /** 網址 #id，例 'login-invite' */
  id: string;
  title: string;
  /** 一到三句話（可以有 <strong>、<Ui> 那種按鈕字樣式） */
  lead: ReactNode;
  /** 照順序做的動作，一行一個動作 */
  actions?: ReactNode[];
  media?: TutorialMediaItem | null;
  /** 「想知道更多」：說明頁的段落 */
  more?: { anchor: HelpAnchor; label: string }[];
}

export interface TutorialSection {
  id: string;
  number: number;
  title: string;
  summary: string;
  steps: TutorialStep[];
}

/** 教學影片；第三階段做好之前是 null（不顯示那一塊） */
export const ANIMATOR_TUTORIAL_VIDEO: { src: string; poster: string } | null = null;

// ─── 小零件 ───

/** 介面上的字（按鈕、選單）：跟說明頁的 <Ui> 同一個樣子 */
function Ui({ children }: { children: ReactNode }) {
  return <span className="tut-ui">{children}</span>;
}

function DownloadLink({ href, primary = false, external = false, children }: { href: string; primary?: boolean; external?: boolean; children: ReactNode }) {
  return (
    <a
      className={'tut-btn' + (primary ? ' tut-btn--primary' : '')}
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      <Icon icon={external ? ExternalLink : Download} /> {children}
    </a>
  );
}

/** 說明頁的圖（同一張圖、同一句替代文字） */
function image(k: FigKey): TutorialMediaItem {
  const f = FIGS[k];
  return { kind: 'image', src: f.src, alt: f.alt, width: f.w, height: f.h };
}

const PNG_LABEL = ledMapMenuLabel('png', 'plain');
const JSX_LABEL = ledMapMenuLabel('jsx', 'plain');
const RES_LIST = RECORD_RESOLUTIONS.map(r => r.label).join('、');
const RES_4K_NOTE = RECORD_RESOLUTIONS.find(r => r.id === '2160p')?.note ?? '';

// ─── 內容 ───

export const ANIMATOR_TUTORIAL: TutorialSection[] = [
  {
    id: 'intro', number: 1, title: '先看這裡',
    summary: '一分鐘看完：這是什麼、幫你省什麼。你在 AE 裡的做法不用改。',
    steps: [
      {
        id: 'intro-what', title: '這是什麼',
        lead: <>這是一個把你的動畫<strong>貼到真的舞台上看</strong>的地方。<strong>你在 AE 裡的做法一點都不用改</strong>，照原本的方式做；多出來的只是：隨時可以在 3D 舞台的 LED 上看到做出來的樣子。</>,
        media: image('studioOverview'),
        more: [{ anchor: A.animStudio, label: '工作站畫面' }],
      },
      {
        id: 'intro-save', title: '幫你省什麼',
        lead: <>不用跑現場，就知道動畫貼在 LED 上長什麼樣子。交一版上來，導演在網頁上就看得到，有意見直接在影片上留言；你在同一個地方回覆、改好、再交一版。</>,
        more: [{ anchor: A.start, label: '整體怎麼運作' }],
      },
      {
        id: 'intro-three', title: '最常做的三件事',
        lead: '先記住這三件事就夠了，其他的用到再看。',
        actions: [
          <>在舞台上看自己的動畫（<Ui>本地檔案</Ui> 或 <Ui>AE 即時</Ui>）。</>,
          <>做好了，交一版給導演（<Ui>＋ 加影片</Ui>）。</>,
          '看導演的意見、回覆，改好再交。',
        ],
        more: [{ anchor: A.animSource, label: '影片 / AE 即時 / 本地檔案' }],
      },
    ],
  },
  {
    id: 'login', number: 2, title: '第一次登入',
    summary: '用邀請連結或登入碼進來，找到指派給你的歌。',
    steps: [
      {
        id: 'login-invite', title: '用邀請連結進來',
        lead: <>製作通常會傳一個邀請連結給你（LINE、微信、Email 都可以），點開就能進專案，不用記密碼。在手機的 LINE 裡點開的話，先選「用瀏覽器開啟」再按「進入專案」。</>,
        actions: [
          '點開邀請連結。畫面會寫你的名字、專案名稱和你的身分。',
          <>按 <Ui>進入專案</Ui>。</>,
          '直接進到動畫師工作站。這台裝置會記得你，下次直接打開網站就可以。',
        ],
        media: image('inviteOpen'),
        more: [{ anchor: A.loginInvite, label: '用邀請連結進來' }],
      },
      {
        id: 'login-code', title: '用登入碼登入',
        lead: <>如果製作給你的是登入碼：打開網站 <code>previz.haimiaan.com</code>，沒登入會自動到登入頁。</>,
        actions: [
          <>在 <Ui>登入碼</Ui> 輸入製作給你的登入碼（大小寫、中間有沒有空格都沒關係）。</>,
          <>按 <Ui>登入</Ui>。</>,
          '登入碼不要給別人：拿到的人就能用你的身分進來。',
        ],
        media: image('login'),
        more: [{ anchor: A.loginCode, label: '用登入碼登入' }],
      },
      {
        id: 'login-find', title: '找到你的歌',
        lead: '登入後會進「動畫師工作站」（有好幾個專案會先讓你選）。',
        actions: [
          <>左邊的歌曲清單，點 <Ui>我的</Ui>：就是指派給你的歌。</>,
          '點一首，舞台就換成那首歌的樣子。',
          <>歌名旁邊的小圓點是狀態，<Ui>有新版</Ui> 是導演還沒看過的版本，留言圖示的數字是新留言。</>,
        ],
        more: [
          { anchor: A.landing, label: '登入後會到哪裡' },
          { anchor: A.animStudio, label: '工作站畫面' },
        ],
      },
    ],
  },
  {
    id: 'before-you-start', number: 3, title: '開工前：把 AE 合成做對',
    summary: '合成的大小對了，LED 才對得準。',
    steps: [
      {
        id: 'before-size', title: '先對好合成的大小',
        lead: '舞台上每塊 LED 在畫布上都有固定的位置。AE 合成的大小和畫布一樣，你的動畫才會剛好貼到對的 LED 上；比例不一樣會被拉長，比較小會比較糊。',
        actions: [
          <>3D 工具列最右邊按 <Ui>⋯</Ui>，選單最下面寫著「畫布 寬 × 高」，AE 合成就照這個大小。</>,
          '以製作給的為準；畫布大小不對，請製作改。',
        ],
        more: [
          { anchor: A.animLedMap, label: 'LED 對位圖' },
          { anchor: A.prodLedCanvas, label: 'LED 畫布大小（製作設定）' },
        ],
      },
      {
        id: 'before-map', title: '方法一：下載 LED 對位圖',
        lead: '對位圖跟 AE 畫布一樣大，畫出每塊 LED 的名字和位置，放進 AE 當參考。',
        actions: [
          <><Ui>⋯</Ui> →「<Ui>{PNG_LABEL}</Ui>」。</>,
          '把 PNG 拖進 AE，放在最上面當參考。',
          '設成導引圖層（Guide Layer），就不會算圖出去。',
        ],
        media: image('ledMapSample'),
        more: [{ anchor: A.animLedMap, label: 'LED 對位圖（做 AE 合成用）' }],
      },
      {
        id: 'before-script', title: '方法二：用 AE 腳本一鍵建合成',
        lead: '不用自己對位置：腳本幫你建好 LED 畫布大小的合成，每塊 LED 的外框和名字都放好了。它們全部是鎖住的導引圖層，算圖時不會出現。',
        actions: [
          <><Ui>⋯</Ui> →「<Ui>{JSX_LABEL}</Ui>」。</>,
          '打開 After Effects（2020 以後的版本，Windows、Mac 都可以）。',
          <>選單 <Ui>File 檔案</Ui> → <Ui>Scripts 指令碼</Ui> → <Ui>Run Script File… 執行指令碼檔案</Ui>，選剛剛下載的 .jsx。</>,
          <>問「合成多長？」寫 分:秒（預設 3:00），按 <Ui>OK</Ui>。</>,
          '跑完會跳一個說明，合成會自己打開。你的素材放在這些導引圖層下面。',
        ],
        media: image('aeScriptResult'),
        more: [{ anchor: A.animAeScript, label: '用 AE 腳本建合成' }],
      },
    ],
  },
  {
    id: 'preview', number: 4, title: '做的時候在舞台上看',
    summary: '做的時候不用先輸出，直接在 3D 舞台的 LED 上看。',
    steps: [
      {
        id: 'preview-file', title: '先用本地檔案看',
        lead: <>把從 AE 輸出的影片放到 LED 上看。<strong>只放在你這台電腦，不會上傳，別人看不到</strong>。</>,
        actions: [
          <>工作站上面的 LED 畫面來源，選 <Ui>本地檔案</Ui>。</>,
          <>把影片（或圖片）拖進頁面，或按左邊 <Ui>加入影片 / 圖片…</Ui>。</>,
          '要用整張 LED 畫布大小的那支，才會對到每一片 LED。',
          '可以一次放好幾個，點清單裡的哪個，LED 就放哪個。',
        ],
        media: image('localFiles'),
        more: [{ anchor: A.animSource, label: '影片 / AE 即時 / 本地檔案' }],
      },
      {
        id: 'preview-ae-tools', title: 'AE 即時 ①：裝 NDI Tools',
        lead: (
          <>
            想要 AE 一動、LED 就跟著動，不用先輸出，用 <Ui>AE 即時</Ui>。第一次要花幾分鐘設定，<strong>只要做一次</strong>。
            先裝 NDI Tools：NDI 官方的免費軟體，AE 靠它把畫面「送出去」。
            <span className="tut-btns"><DownloadLink href={NDI_TOOLS_URL} primary external>前往 NDI Tools 下載頁（免費）</DownloadLink></span>
          </>
        ),
        actions: [
          '打開下載的安裝檔，照預設一直按下一步裝完。裡面的「NDI for Adobe Creative Cloud」就是 AE 要用的，保持勾選。',
          <><strong>AE 開著的話，要關掉重開</strong>，AE 才會認得 NDI。</>,
        ],
        more: [
          { anchor: A.whatYouNeed, label: '要準備什麼' },
          { anchor: A.installNdiTools, label: '裝 NDI Tools' },
        ],
      },
      {
        id: 'preview-ae-helper', title: 'AE 即時 ②：裝 NDI 小程序',
        lead: (
          <>
            NDI 小程序是我們做的免費小程式，在背景接收 AE 的畫面。<strong>裝一次就好</strong>，之後開機會自己啟動，不用管它。
            <span className="tut-btns">
              <DownloadLink href={NDI_HELPER_DOWNLOAD_URL} primary>下載 NDI 小程序（Windows）</DownloadLink>
              <DownloadLink href={NDI_HELPER_DOWNLOAD_URL_MAC}>下載 NDI 小程序（Mac）</DownloadLink>
            </span>
          </>
        ),
        actions: [
          '電腦是 Windows：打開下載的安裝檔，照著按下一步裝完。跳出藍色的「Windows 已保護您的電腦」，按「其他資訊」→「仍要執行」。最後一頁的「Launch Stage Previz NDI Helper now」保持打勾，按 Finish。',
          '電腦是 Mac：解壓縮下載的 zip，把「Stage Previz NDI Helper」拖進「應用程式」資料夾，再打開它。一定要先拖進去再打開，不然開機自動啟動會失效。',
          '右下角（Windows）或右上角選單列（Mac）出現一個圓點，就裝好了。',
        ],
        more: [{ anchor: A.installHelper, label: '裝 NDI 小程序' }],
      },
      {
        id: 'preview-ae-output', title: 'AE 即時 ③：在 AE 打開 NDI 輸出（最重要）',
        lead: <>這一步讓 AE 把畫面送出去。打開 AE 的「視訊預覽（Video Preview）」設定。</>,
        actions: [
          <>Windows：<Ui>Edit 編輯</Ui> → <Ui>Preferences 偏好設定</Ui> → <Ui>Video Preview… 視訊預覽</Ui>。Mac：<Ui>After Effects</Ui> → <Ui>Settings 設定</Ui> → <Ui>Video Preview… 視訊預覽</Ui>。</>,
          <><strong>勾</strong> <Ui>Enable Mercury Transmit</Ui>。</>,
          <>在清單裡 <Ui>NDI output</Ui> 那一行，<strong>勾</strong> <Ui>Video Stream</Ui>。沒有這一行，表示 NDI Tools 還沒裝好，或裝完還沒重開 AE。</>,
          <><strong>不要勾</strong> <Ui>Disable video output when in the background</Ui>。勾了的話，你一點到瀏覽器，AE 就停止送畫面。</>,
          <>按 <Ui>OK</Ui>。</>,
        ],
        media: image('aeVideoPreviewWin'),
        more: [{ anchor: A.aeNdiOutput, label: '在 AE 打開 NDI 輸出' }],
      },
      {
        id: 'preview-ae-allow', title: 'AE 即時 ④：用 Chrome 打開，按「允許」',
        lead: <>用 <strong>Chrome</strong>（或 Edge、Firefox）打開動畫師工作站。<strong>Safari 不行</strong>（iPhone、iPad 也不行）。</>,
        actions: [
          <>上面選 <Ui>AE 即時</Ui>，3D 舞台上會出現卡片，按 <Ui>連接 AE 即時</Ui>。</>,
          <>瀏覽器左上角跳出小視窗問「{PERMISSION_PROMPT_TEXT}」，按 <Ui>允許</Ui>。</>,
          '每個網站只問一次，之後不會再問。',
        ],
        more: [{ anchor: A.chromeAllow, label: '用 Chrome 打開，按「允許」' }],
      },
      {
        id: 'preview-ae-use', title: 'AE 即時：每次使用',
        lead: '設定好之後，每次只要這樣：',
        actions: [
          '打開 AE 和你的專案（小程序開機就自己開了，不用管）。',
          '按空白鍵播放你的合成。AE 只有在畫面有變化時才會送新的畫面，停在同一格的話，LED 會停在最後一張。',
          <>用 Chrome 打開工作站，上面選 <Ui>AE 即時</Ui>。</>,
          <>3D 畫面上方出現綠色「<Ui>LIVE</Ui>」，LED 就是 AE 的畫面了。</>,
        ],
        media: image('studioLive'),
        more: [
          { anchor: A.use, label: '每次使用' },
          { anchor: A.aeLive, label: 'AE 即時預覽（整章）' },
        ],
      },
      {
        id: 'preview-ae-smooth', title: 'AE 預覽卡卡的時候',
        lead: 'AE 裡只做平面的畫布，不要放 Element 3D（E3D）的舞台：舞台交給網頁，AE 預覽慢，最大的原因就是它。',
        actions: [
          <>合成視窗下方的 <Ui>解析度</Ui> 選單，建議用 <Ui>Half（二分之一）</Ui>。畫布很大而且還是卡，才改 <Ui>Third（三分之一）</Ui>。</>,
          <>不要用 <Ui>Quarter（四分之一）</Ui>：LED 會糊、一格一格的。</>,
        ],
        more: [
          { anchor: A.resolution, label: '建議的預覽解析度' },
          { anchor: A.aeNoE3d, label: 'AE 裡不要放 E3D 舞台' },
          { anchor: A.aeSpeedTips, label: 'AE 預覽變順的小技巧' },
        ],
      },
      {
        id: 'preview-test', title: '用測試圖檢查對位',
        lead: <>LED 沒有畫面的時候（沒有影片、沒有 AE 即時、沒有本地檔案），會自動顯示<strong>測試圖</strong>：每塊 LED 自己的名字和位置，跟你 AE 合成裡的一樣。</>,
        actions: [
          '名字和位置跟你 AE 裡的一樣。',
          '四個角的記號在 LED 的四個角。',
          '字不是反的。三樣都對，就是對的。',
          <>LED 有畫面的時候也想檢查：<Ui>⋯</Ui> → 勾 <Ui>LED 顯示測試圖</Ui>（只有你這邊看得到）。</>,
        ],
        media: image('testPattern'),
        more: [{ anchor: A.animTestPattern, label: 'LED 顯示測試圖' }],
      },
      {
        id: 'preview-music', title: '沒有影片的歌：聽音樂對 cue 的時間',
        lead: '這首歌還沒有影片、製作或導演放了音樂的話，3D 畫面下面會多一條音樂播放列。cue 列和 3D 的機關會跟著音樂走，可以先看 cue 的時間對不對拍子。你只能聽、不能換。',
        actions: [
          '按播放列的播放鍵（空白鍵也可以）。',
          '點 cue 列的某個 cue，音樂就跳到那個 cue 的時間。',
          '有影片的歌（或 LED 放的是本地影片）聽的是影片的聲音，音樂不會播。',
        ],
        more: [{ anchor: A.animStudio, label: '工作站畫面（音樂）' }],
      },
    ],
  },
  {
    id: 'submit', number: 5, title: '交一版',
    summary: '輸出成 H.264 的 MP4，加影片，再提交審查。',
    steps: [
      {
        id: 'submit-export', title: 'AE 輸出設定',
        lead: <>交給導演的影片請用 <strong>H.264 的 MP4</strong>（每台電腦、每個瀏覽器都播得了的影片格式）。ProRes、HAP 瀏覽器播不了，交的時候會被擋下來。</>,
        actions: [
          <>格式：<Ui>H.264</Ui>（.mp4）。</>,
          <>大小：跟 LED 畫布一樣（<Ui>⋯</Ui> 選單最下面的「畫布 寬 × 高」）。</>,
          '影格速率：固定，跟合成一樣，不要用「可變影格速率」。',
          '位元速率：4K（3840 × 2160）大約 20–40 Mbps；1920 × 1080 大約 10–15 Mbps。',
          <>在 AE：<Ui>Composition 合成</Ui> → <Ui>Add to Adobe Media Encoder Queue…</Ui>，Format 選 <Ui>H.264</Ui>，Preset 選 <Ui>Match Source - High bitrate</Ui>。</>,
        ],
        more: [{ anchor: A.animAeExport, label: 'AE 輸出設定（交影片前）' }],
      },
      {
        id: 'submit-add', title: '加影片',
        lead: '交給導演看的影片，用「＋ 加影片」交。上傳中可以切到別首歌，但不要關掉整個分頁。',
        actions: [
          <>選歌，按 <Ui>＋ 加影片</Ui>。</>,
          '「說明」寫一句話（選填，例：修了第二段的轉場）。',
          '把影片拖到框裡，或點框選檔案（MP4 / MOV / WebM，最大 4 GB）。',
          '會先在你的電腦試播一下（檔案還沒傳出去），沒問題就開始傳。',
          <>進度條跑完會寫 <Ui>完成，變成 V3</Ui>（號碼是下一個版本），LED 換成新的一版。</>,
        ],
        media: image('addVideoUpload'),
        more: [
          { anchor: A.animAddVideo, label: '交影片（加影片）' },
          { anchor: A.qUpload, label: '上傳到一半中斷了' },
        ],
      },
      {
        id: 'submit-versions', title: '版本 V1、V2、V3',
        lead: '每交一次、好了就是下一個號碼：V1、V2、V3…。號碼不會變，點哪一版，LED 就放哪一版。',
        media: image('versionBar'),
        more: [{ anchor: A.animVersions, label: '版本 V1、V2…' }],
      },
      {
        id: 'submit-review', title: '提交審查',
        lead: '影片交好了，要請導演來看，就提交審查。',
        actions: [
          <>右邊點 <Ui>審查 / 留言</Ui> 分頁。</>,
          '留言框可以先寫一段給導演的話（例：請看 0:10 升降台上來那段）。',
          <>按 <Ui>提交審查</Ui> → 確認。狀態變成「審查中」，導演收到通知。</>,
        ],
        more: [{ anchor: A.animSubmit, label: '提交審查' }],
      },
    ],
  },
  {
    id: 'record', number: 6, title: '錄成影片給導演',
    summary: '把舞台連同 LED 上的動畫錄成一個影片檔，傳給導演或自己留著看。',
    steps: [
      {
        id: 'record-where', title: '在哪裡按',
        lead: <>LED 放的是影片的時候（這首歌交上來的影片，或本地檔案裡的影片），就可以按 <Ui>錄成影片</Ui>。<strong>AE 即時不能錄</strong>。</>,
        actions: [
          '歌曲影片：影片版本列旁邊有「錄成影片」，小播放器上也有一顆。',
          '本地影片：LED 下面的播放列上有一顆。',
          '要用電腦的 Chrome 或 Edge：手機、iPad 的瀏覽器常常不能錄。這個瀏覽器不能錄的時候，按鈕是灰的，滑鼠移上去會寫原因。',
        ],
        more: [{ anchor: A.animStudio, label: '工作站畫面' }],
      },
      {
        id: 'record-options', title: '選設定',
        lead: <>按 <Ui>錄成影片</Ui> 會打開設定視窗：</>,
        actions: [
          <><Ui>解析度</Ui>：{RES_LIST}。{RES_4K_NOTE}。</>,
          <><Ui>範圍</Ui>：<Ui>整首（從頭到尾）</Ui>，或 <Ui>從目前時間到結束</Ui>。</>,
          <><Ui>鏡頭</Ui>：現在的視角，或製作存好的專案視角。</>,
          '左下角疊 cue 名稱字幕（例如「Cue 3 副歌全開」）：預設是勾著的。',
          <>按 <Ui>開始錄</Ui>。</>,
        ],
        more: [{ anchor: A.animStudio, label: '工作站畫面（錄成影片）' }],
      },
      {
        id: 'record-wait', title: '錄的時候',
        lead: '會把影片播一遍錄下來，要等它播完。',
        actions: [
          '錄的時候播放控制會鎖住，請讓這個分頁留在最前面。',
          <>畫面下方會有進度條。想提早結束就按 <Ui>停止</Ui>，只會留下已經錄到的這一段。</>,
        ],
      },
      {
        id: 'record-save', title: '存到哪裡、怎麼給導演',
        lead: '錄完會存成一個影片檔（瀏覽器會把它下載下來），畫面上寫「已存成 …」。',
        actions: [
          '檔名是「專案-歌名-版本或檔名-日期.mp4」。',
          `這個瀏覽器只能存成 webm 的話，檔案會是 .webm：${WEBM_NOTE}。`,
          '可以直接傳 Google Drive 給導演，或自己留著看。',
        ],
      },
    ],
  },
  {
    id: 'feedback', number: 7, title: '導演有意見時',
    summary: '看意見、回覆、按「已改好」，再交一版，也可以把兩版拿來比較。',
    steps: [
      {
        id: 'feedback-see', title: '看導演的意見',
        lead: <>導演按了「需修改」，原因寫在留言裡。右邊的 <Ui>審查 / 留言</Ui> 分頁就是看這些的地方。</>,
        actions: [
          '「目前狀態」下面那一行，是導演上次的決定和原因。',
          <>留言清單裡有紅色 <Ui>需修改</Ui> 標籤的，就是原因。</>,
          '每則留言都標著是看哪一版時留的。有時間的（例：0:12）點一下，影片就跳到那一秒。',
          '點一則留言：換到那一版、跳到那一格，攝影機飛到導演留言時的 3D 視角，導演的畫記疊上去。',
        ],
        more: [
          { anchor: A.animFeedback, label: '看導演的意見、回覆、已改好' },
          { anchor: A.dirOpen, label: '打開留言' },
        ],
      },
      {
        id: 'feedback-reply', title: '回覆、改好了',
        lead: '看完意見，回覆一下，改好再交一版。',
        actions: [
          <>按留言下面的 <Ui>回覆</Ui>，對方會收到通知。打 @ 加名字可以提及某人。</>,
          <>改好了就按 <Ui>已改好（V2）</Ui>，會記下是哪一版改好的，留言變灰。導演覺得還沒好，可以按 <Ui>重新打開</Ui>。</>,
          <>交新版（<Ui>＋ 加影片</Ui>）會自動回到「審查中」；或改好後按 <Ui>修改完成，重新提交</Ui>。</>,
        ],
        more: [
          { anchor: A.animFeedback, label: '看導演的意見、回覆、已改好' },
          { anchor: A.animSubmit, label: '提交審查' },
        ],
      },
      {
        id: 'feedback-compare', title: '比較兩版（C 鍵）',
        lead: '想看這一版跟上一版差在哪：比較的時候，3D 畫面的 LED 也會跟著換。',
        actions: [
          <>小播放器下面 <Ui>比較</Ui> 選另一版（例：V1）。</>,
          <>按旁邊的按鈕，或鍵盤 <kbd>C</kbd>，在兩版之間切換，停在同一秒。</>,
          <>選 <Ui>不比較</Ui> 結束。</>,
        ],
        media: image('compare'),
        more: [{ anchor: A.animCompare, label: '比較兩版（C 鍵）' }],
      },
    ],
  },
  {
    id: 'stuck', number: 8, title: '卡住了',
    summary: '最常見的五種狀況，各有一個照做的解法。還是不行，就找邀請你進來的製作。',
    steps: [
      {
        id: 'stuck-black', title: 'LED 一片黑（AE 即時）',
        lead: '照順序檢查：',
        actions: [
          '先看 AE 裡的畫面：時間指示器是不是停在沒有東西的地方？',
          <>檢查 AE「視訊預覽」的三個勾，特別是 <Ui>Enable Mercury Transmit</Ui>（數字鍵盤的「<kbd>/</kbd>」會開關它）。</>,
          '點一下 AE 的合成視窗，再按空白鍵播放。',
          '還是黑的：把 AE 關掉重開（剛裝好 NDI Tools 一定要重開）。',
        ],
        more: [
          { anchor: A.faqBlack, label: 'LED 一片黑' },
          { anchor: A.faqWaitingFrames, label: '「已連上 AE，但 AE 沒在送畫面」' },
        ],
      },
      {
        id: 'stuck-align', title: 'LED 對不準',
        lead: '先打開測試圖看：名字和位置跟你 AE 裡的一樣、四個角的記號在 LED 的四個角、字不是反的，就是對的。',
        actions: [
          <>AE 合成的大小，要跟 LED 畫布一樣（<Ui>⋯</Ui> 選單最下面的「畫布 寬 × 高」）。</>,
          '大小都對還是對不上：通常是模型的 LED UV 擺錯，請找製作。',
        ],
        more: [{ anchor: A.animTestPattern, label: 'LED 顯示測試圖' }],
      },
      {
        id: 'stuck-upload', title: '上傳到一半斷掉',
        lead: '上傳是一段一段傳的，傳好的部分不會不見。',
        actions: [
          <>打開同一首歌，版本列下面會寫 <Ui>上傳到 44% 就停了</Ui> 這一類的字。</>,
          <>按 <Ui>繼續上傳（選同一個檔案）</Ui>，選當初傳的那個檔案（換一台電腦也可以）。</>,
          '會從斷掉的地方接著傳。',
        ],
        more: [{ anchor: A.qUpload, label: '上傳到一半中斷了' }],
      },
      {
        id: 'stuck-blocked', title: '瀏覽器擋住了',
        lead: <>之前瀏覽器問「{PERMISSION_PROMPT_TEXT}」的時候，按到了「封鎖」。照下面改回來：</>,
        actions: [
          ...permissionFixSteps('other'),
          '改好後會自動連上。',
        ],
        more: [
          { anchor: A.faqBlocked, label: '瀏覽器擋住了連到 NDI 小程序' },
          { anchor: A.qPermission, label: '瀏覽器問要不要「允許」' },
        ],
      },
      {
        id: 'stuck-safari', title: 'Safari 不能用 AE 即時',
        lead: <>Safari 會直接擋掉網頁連到小程序，沒辦法用。請改用 <strong>Chrome、Edge 或 Firefox</strong> 打開同一個連結。iPhone、iPad 上的瀏覽器也不行：AE 即時本來就要在跑 AE 的電腦上看。</>,
        more: [{ anchor: A.faqSafari, label: 'Safari 不支援 AE 即時畫面' }],
      },
      {
        id: 'stuck-ask', title: '還是不行',
        lead: '還是不行，找邀請你進來的製作。把畫面截圖傳給對方，問題最快解決。',
      },
    ],
  },
];
