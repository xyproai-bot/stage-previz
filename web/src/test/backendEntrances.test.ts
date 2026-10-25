// 守門測試：後台早就能做的事，畫面上要有入口（docs/backend-ui-gaps.md）。
// 之後整理程式的時候不小心把按鈕拿掉，這裡會抓到。每一條寫：哪個畫面、接了哪個動作。
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob([
  '../pages/{Preview,Studio,ShowDetail,Users,Admin}.tsx',
  '../components/{SongVersionBar,SongVideosDialog,ProjectCard,ActivityDrawer,SystemStatusSection}.tsx',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function src(name: string): string {
  const hit = Object.entries(sources).find(([k]) => k.endsWith('/' + name));
  if (!hit) throw new Error(`找不到 ${name}`);
  return hit[1];
}

describe('畫面入口：改影片版本的說明', () => {
  it('版本列有「改說明 / 寫說明」，條件跟刪除一樣（canDelete）', () => {
    const s = src('SongVersionBar.tsx');
    expect(s).toContain('onEditNote');
    expect(s).toContain("'改說明' : '寫說明'");
    expect(s).toMatch(/onEditNote && canDelete\?\.\(selected\)/);
  });

  it('導演頁、動畫師工作站的版本列有接上', () => {
    expect(src('Preview.tsx')).toContain('onEditNote={handleEditNote}');
    expect(src('Studio.tsx')).toContain('onEditNote={handleEditNote}');
    expect(src('Preview.tsx')).toContain('editVersionNote(');
    expect(src('Studio.tsx')).toContain('editVersionNote(');
  });

  it('編輯頁的「影片版本」視窗每一版有「改說明」', () => {
    const s = src('SongVideosDialog.tsx');
    expect(s).toContain('editVersionNote(');
    expect(s).toContain("'改說明' : '寫說明'");
  });
});

describe('畫面入口：其他', () => {
  it('Show 頁有「改說明 / 寫說明」', () => {
    const s = src('ShowDetail.tsx');
    expect(s).toContain('editShowDescription(');
    expect(s).toContain("'改說明' : '寫說明'");
  });

  it('用戶頁每個人有「顏色」，新增用戶和換顏色用同一組顏色', () => {
    const s = src('Users.tsx');
    expect(s).toContain('AvatarColorDialog');
    expect(s).toContain('avatarColor');
    expect(s).toContain('AVATAR_COLORS');
    expect(s).toContain('> 顏色</button>');
  });

  it('專案卡片選單有「標成審查中 / 改回進行中」，首頁接上', () => {
    expect(src('ProjectCard.tsx')).toContain('onToggleReview');
    expect(src('ProjectCard.tsx')).toContain('review.menuLabel');
    expect(src('Admin.tsx')).toContain('onToggleReview={handleToggleReview}');
    expect(src('Admin.tsx')).toContain('{ status: t.next }');
  });

  it('最近活動有「看更早的紀錄」', () => {
    const s = src('ActivityDrawer.tsx');
    expect(s).toContain('看更早的紀錄');
    expect(s).toContain('canLoadEarlierActivity');
  });

  it('系統狀態有「看全部備份」，每一份能下載', () => {
    const s = src('SystemStatusSection.tsx');
    expect(s).toContain('看全部備份');
    expect(s).toContain('listBackups');
    expect(s).toContain('onDownload(b.file)');
  });
});
