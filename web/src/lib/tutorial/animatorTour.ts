// web/src/lib/tutorial/animatorTour.ts
// 動畫師工作站「帶著做」：步驟內容和規則（純函式，好測）。
//   畫面：components/TourOverlay.tsx；掛載和 data-tour 標記：pages/Studio.tsx。
//   看過與否記在這台電腦（localStorage）；步驟大改就把鍵名的版本號加一，讓大家再看一次。
import type { ProjectRole } from '../mockData';

export const ANIMATOR_TOUR_SEEN_KEY = 'sp_tour_animator_v1';
export const ANIMATOR_TUTORIAL_PATH = '/tutorial/animator';

/** 工作站裡 data-tour="..." 的元素 */
export type TourTarget = 'songs-mine' | 'stage' | 'source-file' | 'cue-bar' | 'add-video' | 'source-ae' | 'record' | 'help';
export type TourStepId =
  | 'welcome' | 'songs' | 'stage' | 'test-pattern' | 'local-file' | 'cues' | 'add-video' | 'ae-live' | 'record' | 'help';

export interface TourStep {
  id: TourStepId;
  title: string;
  body: string;
  /** 要亮的地方；null = 不亮、說明框放中間 */
  target: TourTarget | null;
  /** 要亮的東西現在找不到（窄畫面收進「⋯」、這首歌現在沒有這個按鈕）時，說明框放中間、多加這一句 */
  missingHint?: string;
  /** 要他動手的步驟：stage-drag 做到就自動往下；local-file 做到就換成 done 的字。不做也能按「下一步」 */
  waitFor?: 'stage-drag' | 'local-file';
  done?: { title: string; body: string };
}

export interface TourContext {
  /** LED 現在有畫面（影片、本地檔案、AE 即時有在送）→ 看不到測試圖 */
  ledHasPicture: boolean;
  /** 這個專案的製作名字 */
  producerNames: readonly string[];
}

/** 「卡住了找誰」：最多列三個名字；沒有就請他找邀請他的人 */
export function producerContactText(names: readonly string[]): string {
  const clean = names.map(n => n.trim()).filter(Boolean);
  if (clean.length === 0) return '邀請你進來的製作';
  if (clean.length <= 3) return `這個專案的製作 ${clean.join('、')}`;
  return `這個專案的製作 ${clean.slice(0, 3).join('、')} 等人`;
}

export function animatorTourSteps(ctx: TourContext): TourStep[] {
  return [
    {
      id: 'welcome', target: null,
      title: '歡迎來到動畫師工作站',
      body: '你在 AE 裡的做法一點都不用改。這裡是把你的動畫貼到真的舞台上看的地方，不用跑現場就知道 LED 上長什麼樣子。跟著走一遍大約 5 分鐘，隨時可以跳過。',
    },
    {
      id: 'songs', target: 'songs-mine',
      title: '這是你的歌',
      body: '「我的」是指派給你的歌。點一首，舞台就換成那首歌的樣子。',
    },
    {
      id: 'stage', target: 'stage', waitFor: 'stage-drag',
      title: '轉轉看舞台',
      body: '按住拖拉可以轉，滾輪可以放大縮小。轉亂了沒關係，按攝影機圖示的「重置攝影機」就回來。試著拖一下。',
    },
    {
      id: 'test-pattern', target: 'stage',
      title: 'LED 上的測試圖',
      body: ctx.ledHasPicture
        ? 'LED 沒放東西的時候會顯示測試圖：每塊 LED 自己的名字和位置，跟你 AE 合成裡的一樣。你的動畫就是照這些位置貼上去的。'
        : '現在 LED 上的格子圖叫測試圖：每塊 LED 自己的名字和位置，跟你 AE 合成裡的一樣。你的動畫就是照這些位置貼上去的。',
    },
    {
      id: 'local-file', target: 'source-file', waitFor: 'local-file',
      title: '把你的動畫放上去',
      body: '點「本地檔案」，把一支你從 AE 輸出的影片拖進來（整張 LED 畫布大小的那支）。只放在你這台電腦，不會上傳，別人看不到。',
      done: { title: '成功了', body: '這就是你的動畫在舞台上的樣子。按「下一步」繼續。' },
    },
    {
      id: 'cues', target: 'cue-bar',
      title: '播放和 cue',
      body: '小播放器可以播放、暫停、拉時間。這一排是 cue：點一個，舞台換成那個 cue 的樣子，影片也跳到那個時間。',
    },
    {
      id: 'add-video', target: 'add-video',
      title: '要給導演看的時候',
      body: '按「＋ 加影片」把影片交上來，導演就會收到。現在不用按，知道在這裡就好。',
    },
    {
      id: 'ae-live', target: 'source-ae',
      title: '想要 AE 一動，LED 就跟著動',
      body: '選「AE 即時」，你在 AE 裡改什麼，舞台上的 LED 馬上跟著變，不用先輸出。第一次要先裝兩個免費的小程式，上手教學裡有一步一步的做法。',
    },
    {
      id: 'record', target: 'record',
      title: '錄成影片',
      body: '放影片的時候，按「錄成影片」可以把舞台連同 LED 上的動畫錄成一個影片檔，直接傳給導演，或自己留著看。',
      missingHint: '放影片（或本地影片）的時候，這附近會出現「錄成影片」。',
    },
    {
      id: 'help', target: 'help',
      title: '卡住了怎麼辦',
      body: `每個區塊旁邊的「?」會打開那一段的說明；「上手教學」有整套一步一步的做法。還是不行，找${producerContactText(ctx.producerNames)}。`,
      missingHint: '「使用說明」在右上角「⋯」裡。',
    },
  ];
}

export function shouldAutoStartTour(o: { projectRole: ProjectRole | null; viewAsActive: boolean; seen: boolean }): boolean {
  return o.projectRole === 'animator' && !o.viewAsActive && !o.seen;
}

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

/** 瀏覽器不給讀（無痕、擋掉）→ 當作看過：記不住的話每次都跳出來太煩 */
export function readTourSeen(storage: ReadStore | null): boolean {
  if (!storage) return true;
  try { return storage.getItem(ANIMATOR_TOUR_SEEN_KEY) === '1'; } catch { return true; }
}

export function markTourSeen(storage: WriteStore | null): void {
  if (!storage) return;
  try { storage.setItem(ANIMATOR_TOUR_SEEN_KEY, '1'); } catch { /* 記不住就算了 */ }
}
