import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MusicBar from './MusicBar';
import SongMusicField from './SongMusicField';
import MechanismTimelineClocked from './mechanisms/MechanismTimelineClocked';
import { EditorMusicContext } from '../lib/editorMusicContext';
import { STAGE_TIMELINE_TEXT, type TimelineClock, type TimelineMech } from '../lib/mechanisms/stageTimeline';
import { buildMechanismTimeline } from '../lib/mechanisms/motion';
import type { Mechanism, MechanismValues } from '../lib/mechanisms/model';
import type { LocalVideoState } from '../lib/localVideo';
import type { Cue } from '../lib/api';
import type { SongMusicSummary } from '../lib/musicApi';
import { MUSIC_TEXT } from '../lib/songMusic';

const music: SongMusicSummary = { id: 'sm_1', filename: 'S01 開場.mp3', mime: 'audio/mpeg', sizeBytes: 5 * 1024 * 1024, durationSec: 215.4, uploadedAt: 't' };

describe('SongMusicField：歌的「音樂」那一行', () => {
  const render = (props: Partial<Parameters<typeof SongMusicField>[0]> = {}) => renderToStaticMarkup(
    <SongMusicField projectId="p1" songId="s1" music={null} canEdit onChange={() => {}} {...props} />,
  );
  it('製作 / 導演、還沒有音樂：寫「還沒有音樂」+「上傳音樂」，有選檔的欄位', () => {
    const html = render();
    expect(html).toContain(MUSIC_TEXT.none);
    expect(html).toContain(MUSIC_TEXT.upload);
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".mp3,.wav,.m4a,.aac,.flac');
    expect(html).not.toContain(MUSIC_TEXT.replace);
  });
  it('製作 / 導演、已經有音樂：檔名、長度、大小 + 「換音樂」「移除」', () => {
    const html = render({ music });
    expect(html).toContain('S01 開場.mp3');
    expect(html).toContain('3:35 · 5 MB');
    expect(html).toContain(MUSIC_TEXT.replace);
    expect(html).toContain(MUSIC_TEXT.remove);
    expect(html).not.toContain(MUSIC_TEXT.upload);
  });
  it('動畫師（只能聽）：看得到檔名和長度，沒有上傳 / 換 / 移除，也沒有選檔的欄位', () => {
    const html = render({ music, canEdit: false });
    expect(html).toContain('S01 開場.mp3');
    expect(html).not.toContain(MUSIC_TEXT.replace);
    expect(html).not.toContain(MUSIC_TEXT.remove);
    expect(html).not.toContain(MUSIC_TEXT.upload);
    expect(html).not.toContain('type="file"');
  });
  it('動畫師、這首歌沒有音樂：什麼都不顯示', () => {
    expect(render({ canEdit: false })).toBe('');
  });
  it('有影片：註明聽影片的聲音、音樂不會播（沒有音樂時不用寫）', () => {
    expect(render({ music, hasVideo: true })).toContain(MUSIC_TEXT.hasVideoNote);
    expect(render({ music, hasVideo: false })).not.toContain(MUSIC_TEXT.hasVideoNote);
    expect(render({ hasVideo: true })).not.toContain(MUSIC_TEXT.hasVideoNote);
  });
});

describe('MusicBar：音樂播放列', () => {
  const player = (over: Partial<LocalVideoState> = {}) => ({
    video: { currentTime: 0 } as HTMLVideoElement, ready: true, playing: false, duration: 215.4, muted: false, error: null,
    togglePlay: () => {}, seek: () => {}, setMuted: () => {}, ...over,
  } as unknown as LocalVideoState);
  const render = (props: Partial<Parameters<typeof MusicBar>[0]> = {}) => renderToStaticMarkup(<MusicBar player={player()} label="S01 開場.mp3" {...props} />);

  it('播放鍵、時間、總長度、可以拖的條、聲音、檔名', () => {
    const html = render();
    expect(html).toContain('aria-label="播放"');
    expect(html).toContain('0:00.0');
    expect(html).toContain('/ 3:35');
    expect(html).toContain('type="range"');
    expect(html).toContain('max="215.4"');
    expect(html).toContain('aria-label="關掉聲音"');
    expect(html).toContain('S01 開場.mp3');
  });
  it('播放中變成暫停鍵；靜音時是「打開聲音」；沒載好的時候按鈕按不下去', () => {
    expect(render({ player: player({ playing: true }) })).toContain('aria-label="暫停"');
    expect(render({ player: player({ muted: true }) })).toContain('aria-label="打開聲音"');
    const loading = render({ player: player({ ready: false, duration: 0 }) });
    expect(loading).toMatch(/aria-label="播放"[^>]*disabled|disabled[^>]*aria-label="播放"/);
  });
  it('導演頁：沒有「設在現在這一秒」，沒有「停止」', () => {
    const html = render();
    expect(html).not.toContain(MUSIC_TEXT.setNow);
    expect(html).not.toContain('aria-label="停止"');
  });
  it('編輯頁（製作）：有「設在現在這一秒」，旁邊寫是哪個 cue；沒選 cue 按不下去', () => {
    const html = render({ onStop: () => {}, setNow: { cueLabel: 'Cue 3「開場」', busy: false, onClick: () => {} } });
    expect(html).toContain(MUSIC_TEXT.setNow);
    expect(html).toContain('→ Cue 3「開場」');
    expect(html).toContain('aria-label="停止"');
    const none = render({ setNow: { cueLabel: null, busy: false, onClick: () => {} } });
    expect(none).toContain(MUSIC_TEXT.setNowNoCue);
    expect(none).toMatch(/disabled=""[^>]*title="先選一個 cue，才能設時間"|title="先選一個 cue，才能設時間"[^>]*disabled=""/);
  });
  it('載入失敗：顯示說明 + 「重新載入」', () => {
    const html = render({ player: player({ error: MUSIC_TEXT.loadFailed }), onReload: () => {} });
    expect(html).toContain(MUSIC_TEXT.loadFailed);
    expect(html).toContain(MUSIC_TEXT.reload);
  });
});

// ── 編輯頁的機關時間軸：音樂是這首歌的時間時播放頭跟音樂走 ──
const lift = {
  id: 'lift', name: '中央升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 3, defaultValue: 0,
  maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0, metadata: null, cueCount: 2, updatedAt: '',
} as Mechanism;
const motionCue = (id: string, order: number, videoTimeSec: number | null, crossfadeSeconds: number) => ({ id, order, videoTimeSec, crossfadeSeconds, status: 'master' as const });
const values: Record<string, MechanismValues> = { a: { lift: 0 }, b: { lift: 3 } };
const timeline = buildMechanismTimeline([lift], [motionCue('a', 0, 0, 0), motionCue('b', 1, 30, 20)], id => values[id])!;
const cues = [{ ...motionCue('a', 0, 0, 0), name: '開場' }, { ...motionCue('b', 1, 30, 20), name: '升起來' }] as unknown as Cue[];
const mech: TimelineMech = {
  timeline, mechanisms: [lift], groups: [], focusedId: null, setFocusedId: () => {}, setPreviewTime: () => {}, previewTimeRef: { current: null }, commitTiming: async () => {},
};
const clock: TimelineClock = { now: () => 5, playing: false, toggle: () => {}, seek: () => {}, duration: 215 };
const renderTl = (clockInCtx: TimelineClock | null, props: Partial<Parameters<typeof MechanismTimelineClocked>[0]> = {}) => renderToStaticMarkup(
  <EditorMusicContext.Provider value={{ clock: clockInCtx, setNow: null }}>
    <MechanismTimelineClocked mech={mech} cues={cues} selectedCueId="b" onSelectCue={() => {}} onClose={() => {}} {...props} />
  </EditorMusicContext.Provider>,
);

describe('編輯頁的機關時間軸跟音樂', () => {
  it('音樂是這首歌的時間 → 時間軸吃音樂的 clock（播放鍵控制音樂，時間尺至少畫到音樂的長度）', () => {
    const html = renderTl(clock);
    expect(html).toContain(STAGE_TIMELINE_TEXT.playVideoTitle);
    expect(html).toContain(STAGE_TIMELINE_TEXT.rulerTipVideo);
    expect(html).not.toContain('停止預覽');
  });
  it('沒有音樂 → 跟原本的編輯頁時間軸一樣（自己播、有停止預覽）', () => {
    const html = renderTl(null);
    expect(html).not.toContain(STAGE_TIMELINE_TEXT.playVideoTitle);
    expect(html).toContain('停止預覽');
  });
  it('Cue 庫裡看單一個 cue 的時間軸不跟音樂走', () => {
    const html = renderTl(clock, { single: { label: '30', name: '主牆' } });
    expect(html).not.toContain(STAGE_TIMELINE_TEXT.playVideoTitle);
    expect(html).toContain('停止預覽');
  });
  it('時間軸上的文字寫「沒影片的歌是音樂」，不會只說影片', () => {
    for (const t of [STAGE_TIMELINE_TEXT.readOnlyHintVideo, STAGE_TIMELINE_TEXT.rulerTipVideo, STAGE_TIMELINE_TEXT.playVideoTitle, STAGE_TIMELINE_TEXT.pauseVideoTitle]) {
      expect(t).toContain('音樂');
    }
  });
});
