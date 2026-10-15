import { useRef } from 'react';
import { Grid3x3, ImagePlus, Layers, Trash2, TriangleAlert } from 'lucide-react';
import Icon from './Icon';
import { toast } from './dialogs';
import type { CanvasSize } from '../lib/ledMap';
import { BACKDROP_ACCEPT, backdropSizeNote } from '../lib/ledTemplateBackdrop';
import type { TemplateBackdrop } from '../lib/useTemplateBackdrop';

/**
 * 版型畫布上方的一排開關：
 *   「對位圖內容」開 / 關 —— 每塊螢幕的框裡畫這塊螢幕的測試圖（跟 3D 上的 LED 對得起來）
 *   「底圖」開 / 關 + 不透明度 + 載入 / 換一張 / 拿掉 —— 墊在最底下的參考圖（例如客戶給的對位圖），只存在這台電腦
 * 底圖跟版型畫布大小不一樣時，多一行問怎麼擺（照畫布大小拉伸 / 照原尺寸放左上）。
 */

interface Props {
  contentOn: boolean;
  onContentOn: (on: boolean) => void;
  /** 對位圖內容的狀況（畫圖中、等 3D 載好、畫不出來）；沒事 = '' */
  contentNote: string;
  /** 框裡對位圖內容的不透明度（0～1） */
  contentOpacity: number;
  onContentOpacity: (o: number) => void;
  backdrop: TemplateBackdrop;
  /** 版型畫布 */
  canvas: CanvasSize;
}

export default function LedTemplateLayers({ contentOn, onContentOn, contentNote, contentOpacity, onContentOpacity, backdrop, canvas }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const pic = backdrop.picture;
  const { prefs } = backdrop;
  const sizeNote = pic ? backdropSizeNote(pic, canvas) : null;
  const shown = !!pic && prefs.visible;

  async function onFile(files: FileList | null) {
    const file = files?.[0];
    if (fileRef.current) fileRef.current.value = '';   // 同一個檔案再選一次也要有反應
    if (!file) return;
    const err = await backdrop.load(file);
    if (err) toast.error(`底圖沒載進來：${err}`);
  }

  function removePicture() {
    backdrop.remove();
    toast.info('底圖拿掉了（只清掉這台電腦存的那份，原本的圖檔沒動）');
  }

  return (
    <div className="ltc__layerbox">
      <div className="ltc__layers" role="group" aria-label="畫布底層">
        <button
          className="ltc__btn"
          onClick={() => onContentOn(!contentOn)}
          aria-pressed={contentOn}
          title="每塊螢幕的框裡畫出這塊螢幕在整張畫布上的測試圖（名字、位置大小、格線、彩條），照轉動、翻轉擺進來，跟 3D 上的 LED 一樣"
        >
          <Icon icon={Grid3x3} /> 對位圖內容
        </button>
        {contentOn && (
          <label className="ltc__opacity" title="框裡對位圖內容的不透明度：調低就能透出下面的底圖，對著底圖排">
            <span>框不透明度</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(contentOpacity * 100)}
              onChange={(e) => onContentOpacity(Number(e.target.value) / 100)}
              aria-label="框裡對位圖內容的不透明度"
            />
            <output>{Math.round(contentOpacity * 100)}%</output>
          </label>
        )}
        {contentOn && contentNote && <span className="ltc__layers-note muted">{contentNote}</span>}
        <span className="ltc__sep" />
        <button
          className="ltc__btn"
          onClick={() => backdrop.setVisible(!prefs.visible)}
          aria-pressed={shown}
          disabled={!pic}
          title={pic ? '顯示 / 隱藏底圖' : '先載入一張底圖'}
        >
          <Icon icon={Layers} /> 底圖
        </button>
        <label className="ltc__opacity" title="底圖的不透明度">
          <span>不透明度</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(prefs.opacity * 100)}
            disabled={!pic}
            onChange={(e) => backdrop.setOpacity(Number(e.target.value) / 100)}
            aria-label="底圖不透明度"
          />
          <output>{Math.round(prefs.opacity * 100)}%</output>
        </label>
        <button className="ltc__btn" onClick={() => fileRef.current?.click()} title="載入一張本機圖片（PNG、JPG、WebP）墊在版型畫布最底下，例如客戶給的這個排法的對位圖">
          <Icon icon={ImagePlus} /> {pic ? '換一張底圖' : '載入底圖…'}
        </button>
        {pic && (
          <>
            <span className="ltc__layers-file" title={`${pic.name}（${pic.width}×${pic.height}）`}>{pic.name} · {pic.width}×{pic.height}</span>
            <button className="ltc__btn" onClick={removePicture} title="拿掉底圖（只清掉這台電腦存的那份）" aria-label="拿掉底圖"><Icon icon={Trash2} /></button>
          </>
        )}
        <input ref={fileRef} type="file" accept={BACKDROP_ACCEPT} hidden onChange={(e) => void onFile(e.target.files)} />
        <span className="ltc__layers-note muted">底圖只存在這台電腦，不會上傳{backdrop.memoryOnly ? '（這個瀏覽器不讓網頁存檔，關掉就沒了）' : ''}</span>
      </div>
      {pic && sizeNote && (
        <div className="ltc__layers ltc__layers--size" role="status">
          <Icon icon={TriangleAlert} size="xs" />
          <span>{sizeNote}。底圖要怎麼擺？</span>
          <span className="ltc__seg" role="group" aria-label="底圖怎麼擺">
            <button className={prefs.fit === 'stretch' ? 'is-on' : ''} aria-pressed={prefs.fit === 'stretch'} onClick={() => backdrop.setFit('stretch')}>照畫布大小拉伸</button>
            <button className={prefs.fit === 'native' ? 'is-on' : ''} aria-pressed={prefs.fit === 'native'} onClick={() => backdrop.setFit('native')}>照原尺寸放左上</button>
          </span>
        </div>
      )}
    </div>
  );
}
