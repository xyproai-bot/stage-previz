import { describe, expect, it } from 'vitest';
import {
  formatWatermarkStamp, identityText, isRealEmail, linkIdLabel, sameIdentity, watermarkLines,
  type WatermarkIdentity,
} from './text';
import {
  MOVE_PERIOD_MS, STAMP_PERIOD_MS, minuteIndex, moveIndex, moveOffset, msUntilNextMinute, msUntilNextMove,
  nextTickDelay, offsetPx, ringDistance, seedFraction,
} from './schedule';
import { TILE_ANGLE_DEG, buildWatermarkTile, escapeXml, estimateTextWidth, watermarkScale } from './tile';
import { applyVideoGuards, isMediaSurface, shouldBlockMediaEvent } from './downloadGuard';
import {
  LEGACY_LINK_PROTECTION, MEMBER_WATERMARK_DEFAULT, NEW_LINK_PROTECTION, canSetMemberWatermark, memberWatermarkOn,
  protectionOfRow, resolveLinkProtectionPatch, resolveNewLinkProtection, shouldWatermarkGuest, shouldWatermarkMember,
} from './policy';
import * as copy from './copy';

// ── 字 ──

describe('浮水印的字：誰在看', () => {
  it('成員：名字；有真的 email 就接在後面', () => {
    expect(identityText({ kind: 'member', name: '阿凱' })).toBe('阿凱');
    expect(identityText({ kind: 'member', name: '阿凱', email: 'kai@studio.com' })).toBe('阿凱 · kai@studio.com');
  });
  it('系統自己塞的假 email、亂寫的 email 不印', () => {
    expect(identityText({ kind: 'member', name: '阿凱', email: 'u_ab12@auto.local' })).toBe('阿凱');
    expect(identityText({ kind: 'member', name: '阿凱', email: 'x@x.test' })).toBe('阿凱');
    expect(identityText({ kind: 'member', name: '阿凱', email: 'not-an-email' })).toBe('阿凱');
    expect(identityText({ kind: 'member', name: '阿凱', email: null })).toBe('阿凱');
    expect(isRealEmail('a@b.co')).toBe(true);
    expect(isRealEmail(undefined)).toBe(false);
  });
  it('成員沒有名字也不會印出空白', () => {
    expect(identityText({ kind: 'member', name: '   ' })).toBe('成員');
  });
  it('訪客寫過名字：名字 + 連結編號', () => {
    const id: WatermarkIdentity = { kind: 'guest', guestName: '小明', linkName: '給經紀人', linkId: 'a1b2c3' };
    expect(identityText(id)).toBe('小明 · 連結 #A1B2C3');
  });
  it('訪客沒寫過名字：「分享連結：連結名稱」+ 編號；沒有連結名稱就只有編號', () => {
    expect(identityText({ kind: 'guest', linkName: '給經紀人', linkId: 'A1B2C3' })).toBe('分享連結：給經紀人 · #A1B2C3');
    expect(identityText({ kind: 'guest', guestName: '  ', linkName: '給經紀人', linkId: 'A1B2C3' })).toBe('分享連結：給經紀人 · #A1B2C3');
    expect(identityText({ kind: 'guest', linkName: null, linkId: 'A1B2C3' })).toBe('分享連結 · #A1B2C3');
    expect(identityText({ kind: 'guest', linkId: '' })).toBe('分享連結');
  });
  it('太長的名字截短、換行和控制字元拿掉（一行放得下）', () => {
    const long = '很長的名字'.repeat(20);
    const t = identityText({ kind: 'member', name: long });
    expect(Array.from(t).length).toBeLessThanOrEqual(24);
    expect(identityText({ kind: 'member', name: '阿\n凱\t' })).toBe('阿 凱');
  });
  it('連結編號統一大寫、補 #', () => {
    expect(linkIdLabel('ab12cd')).toBe('#AB12CD');
    expect(linkIdLabel('#ab12cd')).toBe('#AB12CD');
    expect(linkIdLabel(null)).toBe('');
  });
  it('兩個身分一樣就不重畫', () => {
    const a: WatermarkIdentity = { kind: 'member', name: '阿凱' };
    expect(sameIdentity(a, { kind: 'member', name: '阿凱' })).toBe(true);
    expect(sameIdentity(a, { kind: 'member', name: '小美' })).toBe(false);
    expect(sameIdentity(a, null)).toBe(false);
    expect(sameIdentity(null, null)).toBe(true);
  });
});

describe('浮水印的字：日期時間', () => {
  it('精準到分，補零', () => {
    expect(formatWatermarkStamp(new Date(2026, 9, 8, 4, 5, 59))).toBe('2026-10-08 04:05');
    expect(formatWatermarkStamp(new Date(2026, 11, 31, 23, 59, 0))).toBe('2026-12-31 23:59');
  });
  it('兩行：誰在看 / 日期時間', () => {
    expect(watermarkLines({ kind: 'member', name: '阿凱' }, new Date(2026, 9, 18, 14, 5))).toEqual(['阿凱', '2026-10-18 14:05']);
  });
});

// ── 時間表 ──

describe('浮水印的時間表', () => {
  it('每分鐘換字、每 45 秒換位置', () => {
    expect(STAMP_PERIOD_MS).toBe(60_000);
    expect(MOVE_PERIOD_MS).toBeGreaterThanOrEqual(30_000);
    expect(MOVE_PERIOD_MS).toBeLessThanOrEqual(60_000);
    expect(minuteIndex(59_999)).toBe(0);
    expect(minuteIndex(60_000)).toBe(1);
    expect(moveIndex(MOVE_PERIOD_MS - 1)).toBe(0);
    expect(moveIndex(MOVE_PERIOD_MS)).toBe(1);
  });
  it('離下一次要動還有多久：整點時間是一整個時段，不是 0', () => {
    expect(msUntilNextMinute(0)).toBe(60_000);
    expect(msUntilNextMinute(59_000)).toBe(1_000);
    expect(msUntilNextMove(0)).toBe(MOVE_PERIOD_MS);
    expect(msUntilNextMove(MOVE_PERIOD_MS - 10)).toBe(10);
    // 下一次要動 = 換字或換位置哪個先到
    expect(nextTickDelay(44_000)).toBe(1_000 + 50);
    expect(nextTickDelay(50_000)).toBe(10_000 + 50);
    for (const t of [0, 1, 44_999, 45_000, 59_999, 123_456_789]) {
      const d = nextTickDelay(t);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(MOVE_PERIOD_MS + 50);
    }
  });
  it('同一個起點、同一個時段永遠同一個位置；換起點位置不同', () => {
    expect(moveOffset(5, 'a')).toEqual(moveOffset(5, 'a'));
    expect(moveOffset(5, 'a')).not.toEqual(moveOffset(5, 'b'));
    expect(seedFraction('abc')).toBe(seedFraction('abc'));
    const f = seedFraction('abc');
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });
  it('每次換位置都跳得夠遠（相鄰兩次在兩個方向都差 0.35 以上），不會原地不動', () => {
    for (const seed of ['小明 · 連結 #A1B2C3', '分享連結：給經紀人 · #ZZZ999', '阿凱']) {
      let prev = moveOffset(0, seed);
      for (let i = 1; i < 500; i++) {
        const cur = moveOffset(i, seed);
        expect(ringDistance(cur.fx, prev.fx)).toBeGreaterThan(0.35);
        expect(ringDistance(cur.fy, prev.fy)).toBeGreaterThan(0.35);
        prev = cur;
      }
    }
  });
  it('一段時間內各處都走得到（四個象限都踩過），而且都在 0 到 1 之間', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { fx, fy } = moveOffset(i, 'x');
      expect(fx).toBeGreaterThanOrEqual(0); expect(fx).toBeLessThan(1);
      expect(fy).toBeGreaterThanOrEqual(0); expect(fy).toBeLessThan(1);
      seen.add(`${fx < 0.5 ? 'L' : 'R'}${fy < 0.5 ? 'T' : 'B'}`);
    }
    expect(seen.size).toBe(4);
  });
  it('換成像素位置：落在一塊圖樣裡', () => {
    const p = offsetPx(7, 'x', { width: 300, height: 200 });
    expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(300);
    expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(200);
  });
});

// ── 圖樣 ──

describe('浮水印的圖樣（SVG）', () => {
  const tile = buildWatermarkTile(['小明 · 連結 #A1B2C3', '2026-10-18 14:05'], 13);
  it('斜的、白字黑邊、錯半格重複（亮的暗的 LED 畫面上都看得到）', () => {
    expect(TILE_ANGLE_DEG).toBeLessThan(0);
    expect(tile.svg).toContain(`rotate(${TILE_ANGLE_DEG})`);
    expect(tile.svg).toContain('fill="#fff"');
    expect(tile.svg).toContain('stroke="#000"');
    expect(tile.svg).toContain('2026-10-18 14:05');
    // 上面一個、下面左右各半個
    expect((tile.svg.match(/<text /g) || []).length).toBe(6);
    expect(tile.height % 2).toBe(0);   // 兩排（第二排錯半格）
    expect(tile.width).toBeGreaterThan(100);
  });
  it('名字裡的 < > & 引號不會弄壞 SVG', () => {
    const t = buildWatermarkTile(['<b>"x"&\'y\'</b>', 'ok'], 13);
    expect(t.svg).not.toContain('<b>');
    expect(t.svg).toContain('&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
    expect(escapeXml('<&>')).toBe('&lt;&amp;&gt;');
    // data URL 整串都編碼過，放進 CSS url("…") 不會被截斷
    expect(t.url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(t.url).not.toMatch(/["<> ]/);
  });
  it('字越長、字級越大，一塊越大', () => {
    const small = buildWatermarkTile(['阿凱', '2026-10-18 14:05'], 13);
    const longer = buildWatermarkTile(['很長很長的名字 · 很長的 email@example-studio.com', '2026-10-18 14:05'], 13);
    const bigger = buildWatermarkTile(['阿凱', '2026-10-18 14:05'], 20);
    expect(longer.width).toBeGreaterThan(small.width);
    expect(bigger.width).toBeGreaterThan(small.width);
    expect(estimateTextWidth('阿凱', 10)).toBe(20);
    expect(estimateTextWidth('ab', 10)).toBeCloseTo(11.6);
  });
  it('畫面越寬字越大；小播放器固定小', () => {
    expect(watermarkScale(375, false)).toBeLessThan(watermarkScale(800, false));
    expect(watermarkScale(800, false)).toBeLessThan(watermarkScale(2000, false));
    expect(watermarkScale(0, false)).toBe(1);
    expect(watermarkScale(2000, true)).toBe(watermarkScale(300, true));
    expect(watermarkScale(300, true)).toBeLessThan(1);
  });
});

// ── 禁止下載的前端 ──

describe('禁止下載：哪裡不給右鍵另存', () => {
  const el = (tagName: string, closestHit = false) => ({ tagName, closest: () => (closestHit ? {} : null) });
  it('影片、畫布、圖片、3D 舞台 / 小播放器 / 浮水印裡面的東西都擋', () => {
    expect(isMediaSurface(el('VIDEO'))).toBe(true);
    expect(isMediaSurface(el('canvas'))).toBe(true);
    expect(isMediaSurface(el('IMG'))).toBe(true);
    expect(isMediaSurface(el('DIV', true))).toBe(true);
    expect(shouldBlockMediaEvent(el('SPAN', true))).toBe(true);
  });
  it('留言框、輸入欄、一般文字照常能按右鍵（才貼得上文字）', () => {
    expect(isMediaSurface(el('TEXTAREA'))).toBe(false);
    expect(isMediaSurface(el('P'))).toBe(false);
    expect(isMediaSurface(null)).toBe(false);
    expect(shouldBlockMediaEvent(undefined)).toBe(false);
  });
  it('<video> 屬性：禁止下載 → 沒有下載鈕；有浮水印或禁止下載 → 不能浮出去', () => {
    const attrs = new Map<string, string>();
    const video = {
      disablePictureInPicture: false, disableRemotePlayback: false,
      setAttribute: (k: string, v: string) => { attrs.set(k, v); },
      removeAttribute: (k: string) => { attrs.delete(k); },
    } as unknown as HTMLVideoElement;
    applyVideoGuards(video, { noDownload: true, watermark: false });
    expect(attrs.get('controlsList')).toContain('nodownload');
    expect(video.disablePictureInPicture).toBe(true);
    expect((video as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback).toBe(true);
    applyVideoGuards(video, { noDownload: false, watermark: true });
    expect(attrs.has('controlsList')).toBe(false);
    expect(video.disablePictureInPicture).toBe(true);
    applyVideoGuards(video, { noDownload: false, watermark: false });
    expect(video.disablePictureInPicture).toBe(false);
    expect((video as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback).toBe(false);
  });
});

// ── 預設值和權限 ──

describe('浮水印 / 禁止下載的預設值和權限', () => {
  it('新連結浮水印關、禁止下載開；舊連結兩個都關；成員看片預設關', () => {
    expect({ ...NEW_LINK_PROTECTION }).toEqual({ watermark: false, noDownload: true });
    expect({ ...LEGACY_LINK_PROTECTION }).toEqual({ watermark: false, noDownload: false });
    expect(MEMBER_WATERMARK_DEFAULT).toBe(false);
    expect(protectionOfRow({ watermark: 0, no_download: 0 })).toEqual({ watermark: false, noDownload: false });
    expect(resolveNewLinkProtection({}).ok && (resolveNewLinkProtection({}) as { fields: unknown }).fields).toEqual({ watermark: 0, no_download: 1 });
    expect(resolveLinkProtectionPatch({ noDownload: false })).toEqual({ ok: true, fields: { no_download: 0 } });
  });
  it('成員看片浮水印：只有製作能改；專案開了就加（不分角色）', () => {
    expect(canSetMemberWatermark('admin')).toBe(true);
    expect(canSetMemberWatermark('director')).toBe(false);
    expect(canSetMemberWatermark('animator')).toBe(false);
    expect(canSetMemberWatermark(null)).toBe(false);
    expect(memberWatermarkOn(undefined)).toBe(false);
    expect(shouldWatermarkMember(true)).toBe(true);
    expect(shouldWatermarkMember(false)).toBe(false);
    expect(shouldWatermarkGuest({ watermark: true })).toBe(true);
    expect(shouldWatermarkGuest(null)).toBe(false);
  });
});

describe('說明文字', () => {
  it('誠實：寫出擋不住螢幕錄影、浮水印追得到是誰；舊連結不會自動開；連結名稱會印出來', () => {
    expect(copy.PROTECTION_LIMIT_NOTE).toContain('擋不住螢幕錄影');
    expect(copy.PROTECTION_LIMIT_NOTE).toContain('浮水印能追到是誰外流');
    expect(copy.LEGACY_LINK_NOTE).toContain('不會自動打開');
    expect(copy.LABEL_ON_WATERMARK_NOTE).toContain('名稱');
    expect(copy.SHARE_PAGE_WATERMARK_NOTE).toBe('此連結已加浮水印');
    expect(copy.MEMBER_WATERMARK_LABEL).toBe('成員看片也加浮水印');
  });
});
