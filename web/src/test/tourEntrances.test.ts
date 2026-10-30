// 守門測試：動畫師工作站「帶著做」在畫面上的入口和接線。
// 之後整理程式的時候不小心把標記、選單項目、自動出現的判斷拿掉，這裡會抓到。
import { describe, expect, it } from 'vitest';
import { animatorTourSteps, ANIMATOR_TUTORIAL_PATH } from '../lib/tutorial/animatorTour';

const sources = import.meta.glob([
  '../pages/Studio.tsx',
  '../components/{LedSourceSwitch,SongVersionBar,OverflowMenu,TourOverlay}.tsx',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function src(name: string): string {
  const hit = Object.entries(sources).find(([k]) => k.endsWith('/' + name));
  if (!hit) throw new Error(`找不到 ${name}`);
  return hit[1];
}

const studio = src('Studio.tsx');
const allMarkers = [studio, src('LedSourceSwitch.tsx'), src('SongVersionBar.tsx'), src('OverflowMenu.tsx')].join('\n');

describe('工作站：要亮的地方都有標記', () => {
  const targets = [...new Set(animatorTourSteps({ ledHasPicture: false, producerNames: [] }).map(s => s.target).filter((t): t is NonNullable<typeof t> => t !== null))];

  it('步驟用到八個地方', () => {
    expect([...targets].sort()).toEqual(['add-video', 'cue-bar', 'help', 'record', 'songs-mine', 'source-ae', 'source-file', 'stage']);
  });

  it('每個地方在原始碼裡都有 data-tour 標記', () => {
    for (const t of targets) expect(allMarkers, t).toMatch(new RegExp(`['"]${t}['"]`));
  });

  it('Studio 自己標的：我的、舞台、cue 列、錄成影片、使用說明', () => {
    expect(studio).toContain('data-tour="songs-mine"');
    expect(studio).toContain('data-tour="stage"');
    expect(studio).toContain('data-tour="cue-bar"');
    expect(studio).toContain('data-tour="record"');
    expect(studio).toContain("dataTour: 'help'");
  });

  it('來源切換、加影片的標記在共用的元件裡', () => {
    expect(src('LedSourceSwitch.tsx')).toContain("data-tour={s === 'file' ? 'source-file' : s === 'ndi' ? 'source-ae' : undefined}");
    expect(src('SongVersionBar.tsx')).toContain('data-tour="add-video"');
    expect(src('OverflowMenu.tsx')).toContain('data-tour={trigger?.dataTour}');
  });
});

describe('工作站：選單和自動出現', () => {
  it('使用說明選單（寬畫面）和「⋯」（窄畫面）都有 使用說明 / 上手教學 / 帶我走一遍', () => {
    expect(studio).toContain("label: '上手教學'");
    expect(studio).toContain('href: ANIMATOR_TUTORIAL_PATH');
    expect(studio).toContain("label: '帶我走一遍'");
    expect(studio).toContain('onSelect: () => setTourIndex(0)');
    // 同一份項目給兩個選單用
    expect(studio).toContain('items={helpMenuItems}');
    expect(studio).toContain('...helpMenuItems');
    expect(ANIMATOR_TUTORIAL_PATH).toBe('/tutorial/animator');
  });

  it('第一次進來自動出現：只有動畫師、不是用動畫師的畫面看、沒看過；出現時馬上記下來', () => {
    expect(studio).toContain('shouldAutoStartTour({ projectRole, viewAsActive: va.active, seen: readTourSeen(store) })');
    expect(studio).toContain('markTourSeen(store)');
    expect(studio).toContain('tourAutoRef');
    // 等專案資料、角色、歌單都載好才判斷
    expect(studio).toContain("nameStatus === 'ready' && myRole !== undefined && !songsLoading && !!selectedSongId");
  });

  it('說明框掛在工作站上，錄影中不顯示、開始錄影就關掉', () => {
    expect(studio).toContain('<TourOverlay');
    expect(studio).toContain('tourIndex !== null && !recorder.locked');
    expect(studio).toContain('if (recorder.locked) setTourIndex(null)');
    expect(studio).toContain('tutorialHref={ANIMATOR_TUTORIAL_PATH}');
  });

  it('要他動手的步驟：AE 沒在送畫面就換本地檔案、拖舞台自動往下、放上檔案變成功', () => {
    expect(studio).toContain("if (source === 'ndi' && !ndiGuide?.hasFrame) chooseSource('file')");
    expect(studio).toContain('Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 20');
    expect(studio).toContain('600)');
    expect(studio).toContain("tourStepId === 'local-file' && source === 'file' && !!media.active");
  });

  it('LED 有沒有畫面，用跟舞台決定測試圖同一個條件', () => {
    expect(studio).toContain("(videoMode && player.ready)");
    expect(studio).toContain("source === 'ndi' && !!ndiGuide?.hasFrame");
  });
});

describe('說明框', () => {
  const overlay = src('TourOverlay.tsx');
  it('整層不擋滑鼠、Esc 跳過、說明框裡的按鍵不被播放快捷鍵吃掉', () => {
    expect(overlay).toContain("document.addEventListener('keydown'");
    expect(overlay).toContain('onKeyDown={(e) => handleBubbleKey(e, onClose)}');
    expect(overlay).toContain('e.stopPropagation();');
    expect(overlay).toContain('requestAnimationFrame');
  });
});
