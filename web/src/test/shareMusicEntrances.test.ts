// 守門測試：分享頁（Share.tsx）聽歌曲的音樂在畫面上的接線。
// 之後整理程式的時候不小心把播放列、接線拿掉，或不小心給訪客上傳 / 換 / 移除的按鈕，這裡會抓到。
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob([
  '../pages/Share.tsx',
  '../lib/{useShareSongMusic,shareMusicApi}.ts',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function src(name: string): string {
  const hit = Object.entries(sources).find(([k]) => k.endsWith('/' + name));
  if (!hit) throw new Error(`找不到 ${name}`);
  return hit[1];
}

describe('分享頁：沒有影片、有音樂的歌用音樂當歌的時間（訪客只能聽）', () => {
  const s = src('Share.tsx');

  it('用分享用的 hook（問分享的路、帶分享的通行證），不是成員用的 useSongMusic', () => {
    expect(s).toContain("from '../lib/useShareSongMusic'");
    expect(s).toContain('useShareSongMusic({');
    expect(s).not.toContain('useSongMusic');
    expect(s).not.toContain('getSongMusic');
    expect(s).toContain('shareRef, accessToken, song: shareSong');
    // 通行證過期（401）也交給分享頁換新的
    expect(s).toContain('onAuthError: (e) => onShareFetchErrorRef.current(e)');
  });

  it('有影片放影片、沒影片有音樂放音樂：歌單上有影片、版本清單有、正在放這台電腦的影片，都算有影片；版本清單讀完才確定', () => {
    expect(s).toContain('hasVideo: hasVideo || fileVideoMode || !!shareSong?.latestVideo');
    expect(s).toContain('videosLoaded: selectedSongId !== null && versions.loadedSongId === selectedSongId');
  });

  it('舞台 / cue 列 / 機關都吃音樂的時間：點 cue 讓音樂跳過去，3D 的機關跟著音樂走', () => {
    expect(s).toContain('active: videoMode || musicMode');
    expect(s).toContain('video: musicMode ? musicPlayer.video : local.video');
    expect(s).toContain('time: musicMode ? musicPlayer.time : local.time');
    expect(s).toContain('seek: musicMode ? musicPlayer.seek : local.seek');
    expect(s).toContain('cues: mech.plannedCues');     // 含暫排的時間
    expect(s).toContain('{...(musicMode ? { mechanismAtFrame: musicMechAtFrame } : null)}');
    expect(s).toContain('musicTimelineRef.current?.valuesAt(musicPlayer.video.currentTime)');
  });

  it('3D 下面有音樂播放列；空白鍵播放 / 暫停；全螢幕預演的小條也能播放 / 暫停音樂', () => {
    expect(s).toContain('<MusicBar player={musicPlayer} label={shareMusic.summary.filename} onReload={shareMusic.reload} loadError={shareMusic.error} />');
    expect(s).toContain('musicMode && shareMusic.summary');
    expect(s).toContain('useMusicHotkeys({ enabled: musicMode, onToggle: musicPlayer.togglePlay })');
    expect(s).toContain('musicPlayer.playing, time: musicPlayer.time, duration: musicPlayer.duration, onTogglePlay: musicPlayer.togglePlay');
    expect(s).toMatch(/transport: videoMode\s*\?[^]*?: musicMode\s*\?[^]*?: undefined/);
  });

  it('訪客不能改音樂：沒有上傳 / 換 / 移除 / 設時間 / 停止回開頭的東西', () => {
    for (const forbidden of ['SongMusicField', 'uploadSongMusic', 'deleteSongMusic', 'canEditMusic', 'canSetCueTimeFromMusic', 'setNow=', 'onStop=', 'musicUpload']) {
      expect(s, forbidden).not.toContain(forbidden);
    }
  });

  it('影片還是照舊：LED、小播放器、留言都用 local（影片播放器），沒有改成音樂', () => {
    expect(s).toContain('const local = useLocalVideo();');
    expect(s).toContain('ledVideo={videoMode && local.ready ? local.video : null}');
    expect(s).toContain('player: local, videoActive: versionVideoMode');
    expect(s).toContain('player={local}');
  });
});

describe('分享用的呼叫：不碰成員的網址和登入', () => {
  it('只打分享的路（shareApiPath），帶通行證 header，沒有登入 header', () => {
    const a = src('shareMusicApi.ts');
    expect(a).toContain('shareApiPath(ref)');
    expect(a).toContain('shareAccessHeaders(access)');
    expect(a).not.toContain('getSessionToken');
    expect(a).not.toContain('Authorization');
    expect(a).not.toContain('/api/projects/');
    expect(a).not.toContain('/api/music/');
  });
  it('hook 不呼叫成員的 getSongMusic', () => {
    const h = src('useShareSongMusic.ts');
    expect(h).not.toContain('getSongMusic');
    expect(h).toContain('getShareSongMusic(');
  });
});
