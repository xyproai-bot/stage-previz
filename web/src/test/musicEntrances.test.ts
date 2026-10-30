// 守門測試：歌曲的音樂（沒有影片的歌用音樂當時間）在畫面上的入口和接線。
// 之後整理程式的時候不小心把按鈕、接線拿掉，這裡會抓到。每一條寫：哪個畫面、接了哪個動作。
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob([
  '../pages/{Preview,Studio,ProjectEditor}.tsx',
  '../components/{SongMusicField,MusicBar}.tsx',
  '../lib/songMusicUpload.ts',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function src(name: string): string {
  const hit = Object.entries(sources).find(([k]) => k.endsWith('/' + name));
  if (!hit) throw new Error(`找不到 ${name}`);
  return hit[1];
}

describe('編輯頁（製作）', () => {
  const s = src('ProjectEditor.tsx');
  it('歌單每首歌有「音樂」那一行（上傳 / 換 / 移除），製作和導演才能改', () => {
    expect(s).toContain('<SongMusicField');
    expect(s).toContain('s.hasMusic !== undefined');    // 舊版後台沒有這個功能 → 不顯示
    expect(s).toContain('canEdit={canEditMusic(editorRole)}');
  });
  it('有音樂、沒影片時 3D 下面有播放列，有「設在現在這一秒」和「停止」', () => {
    expect(s).toContain('<MusicBar');
    expect(s).toContain('songMusic.musicMode && songMusic.summary');
    expect(s).toContain('onStop={stopMusic}');
    expect(s).toContain('setNow={musicCtx.setNow');
  });
  it('機關時間軸的播放頭吃音樂的時鐘，3D 的機關跟著音樂的時間', () => {
    expect(s).toContain("from '../components/mechanisms/MechanismTimelineClocked'");
    expect(s).toContain('<EditorMusicContext.Provider value={musicCtx}>');
    expect(s).toContain('useMusicTimelineClock(songMusic.player, songMusic.musicMode)');
    expect(s).toContain('useMusicPreviewFeed({ enabled: songMusic.musicMode');
    expect(s).toContain('setPreviewTime: mech.setPreviewTime, resetKey: songMusic.summary?.id ?? null');   // 換歌 / 換音樂時預覽要清掉
  });
  it('「設在現在這一秒」只有製作能按、可以復原、有快捷鍵 M、cue 旁邊（物件狀態分頁）也有一顆', () => {
    expect(s).toContain('canSetCueTimeFromMusic(editorRole)');
    const fn = s.slice(s.indexOf('async function setCueToMusicNow'), s.indexOf('const setNowRef'));
    expect(fn).toContain('setNowBlocker({ cue, playerReady: songMusic.player.ready })');   // 音樂沒載好 / 沒選 cue 時快捷鍵 M 不能設
    expect(fn).toContain('cueTimeFromMusic(songMusic.player.video.currentTime)');
    expect(fn).toContain('historyRef.current.push(scope');
    expect(fn).toContain('undo: async');
    expect(fn).toContain('redo: async');
    expect(fn).toContain('toast.success(');
    expect(s).toContain('onMark: canSetNow');
    expect(s).toContain('useContext(EditorMusicContext)');
    expect(s).toContain('MUSIC_TEXT.setNow');
  });
});

describe('導演頁', () => {
  const s = src('Preview.tsx');
  it('影片版本列下面有「音樂」那一行：導演和製作可以改，動畫師只能聽；「用其他身分看」時按了只提醒', () => {
    expect(s).toContain('<SongMusicField');
    expect(s).toContain('canEdit={canEditMusic(projectRole) && !va.readOnly}');
    expect(s).toContain('song.hasMusic !== undefined');
    expect(s).toContain('guard={va.guard}');
  });
  it('導演頁沒有「設在現在這一秒」：不 import 設時間的權限、播放列沒給 setNow', () => {
    expect(s).not.toContain('canSetCueTimeFromMusic');
    expect(s).not.toContain('setNow=');
    expect(s).not.toContain('onStop=');
  });
  it('有影片放影片、沒影片有音樂放音樂：舞台 / cue 列 / 機關時間軸 / 3D 的機關都吃音樂的時間', () => {
    expect(s).toContain('hasVideo: !!selected || !!song.latestVideoId');
    expect(s).toContain('videosLoaded: versions.loadedSongId === song.id');
    expect(s).toContain('active: videoMode || musicMode');
    expect(s).toContain('video: musicMode ? musicPlayer.video : player.video');
    expect(s).toContain('seek: musicMode ? musicPlayer.seek : player.seek');
    expect(s).toContain('const clockPlayer = musicMode ? musicPlayer : player');
    expect(s).toContain('videoMode: videoMode || musicMode');
    expect(s).toContain('mechanismAtFrame: musicMechAtFrame');
    expect(s).toContain('<MusicBar');
  });
  it('全螢幕預演的小條：有影片是影片的播放 / 暫停 + 時間，沒影片、有音樂就是音樂的（不然全螢幕下只剩空白鍵能播）', () => {
    expect(s).toContain('musicPlayer.playing, time: musicPlayer.time, duration: musicPlayer.duration, onTogglePlay: musicPlayer.togglePlay');
    expect(s).toMatch(/transport: videoMode\s*\?[^]*?: musicMode\s*\?[^]*?: undefined/);
  });
  it('打開調整舞台時音樂也先停；空白鍵播放 / 暫停音樂', () => {
    expect(s).toContain('if (musicPlayer.playing) musicPlayer.pause();');
    expect(s).toContain('useMusicHotkeys({ enabled: musicMode && !adjust.on');
  });
  it('影片還是照舊：LED、小播放器、比較版本都用 player（影片播放器），沒有改成音樂', () => {
    expect(s).toContain('const player = useLocalVideo();');
    expect(s).toContain('player={player}');
  });
});

describe('動畫師工作站', () => {
  it('這一版沒有音樂（動畫師用自己的影片；只在導演頁、編輯頁聽）', () => {
    expect(src('Studio.tsx')).not.toContain('SongMusicField');
    expect(src('Studio.tsx')).not.toContain('useSongMusic');
  });
});

describe('兩個畫面共用的元件', () => {
  it('上傳 / 換 / 移除：畫面接到流程（runMusicUpload / runMusicRemove），流程用站內確認框，不用瀏覽器內建的', () => {
    const f = src('SongMusicField.tsx');
    expect(f).toContain('runMusicUpload(');
    expect(f).toContain('runMusicRemove(');
    expect(f).toContain('role="progressbar"');
    expect(f).not.toMatch(/(window\.)?(confirm|alert|prompt)\(/);
    const u = src('songMusicUpload.ts');
    expect(u).toContain("from '../components/dialogs'");
    expect(u).toContain('confirmDialog(');
    expect(u).toContain('uploadSongMusic');
    expect(u).toContain('deleteSongMusic');
    expect(u).not.toMatch(/(window\.)?(confirm|alert|prompt)\(/);
  });
  it('播放列有播放 / 暫停、可以拖的條、聲音', () => {
    const b = src('MusicBar.tsx');
    expect(b).toContain('player.togglePlay');
    expect(b).toContain('type="range"');
    expect(b).toContain('player.setMuted');
  });
});
