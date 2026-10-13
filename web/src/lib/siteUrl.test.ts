import { describe, it, expect } from 'vitest';
import { PUBLIC_SITE_URL, publicSiteOrigin, shareSlugUrl, shareTokenUrl } from './siteUrl';

describe('publicSiteOrigin', () => {
  it('正式站（新網域 / 舊 vercel 網址）→ 一律用新網域', () => {
    expect(PUBLIC_SITE_URL).toBe('https://previz.haimiaan.com');
    expect(publicSiteOrigin('https://previz.haimiaan.com')).toBe(PUBLIC_SITE_URL);
    expect(publicSiteOrigin('https://stage-previz.vercel.app')).toBe(PUBLIC_SITE_URL);
    expect(publicSiteOrigin('https://stage-previz-haimiaan-s-projects.vercel.app')).toBe(PUBLIC_SITE_URL);
  });
  it('測試站 / Vercel 預覽 / 本機 → 用目前網址', () => {
    expect(publicSiteOrigin('https://test.previz.haimiaan.com')).toBe('https://test.previz.haimiaan.com');
    expect(publicSiteOrigin('https://stage-previz-git-feat-live-stage-look-haimiaan-s-projects.vercel.app'))
      .toBe('https://stage-previz-git-feat-live-stage-look-haimiaan-s-projects.vercel.app');
    expect(publicSiteOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });
  it('看不懂的 → 新網域', () => {
    expect(publicSiteOrigin('not a url')).toBe(PUBLIC_SITE_URL);
  });
});

describe('分享網址', () => {
  it('舊式 /share/<連結碼>', () => {
    expect(shareTokenUrl('0123456789abcdef0123456789abcdef', 'https://stage-previz.vercel.app'))
      .toBe('https://previz.haimiaan.com/share/0123456789abcdef0123456789abcdef');
  });
  it('好讀 /s/<網址名稱>', () => {
    expect(shareSlugUrl('jinma2026-k7p2', 'https://previz.haimiaan.com'))
      .toBe('https://previz.haimiaan.com/s/jinma2026-k7p2');
    expect(shareSlugUrl('jinma2026-k7p2', 'https://test.previz.haimiaan.com'))
      .toBe('https://test.previz.haimiaan.com/s/jinma2026-k7p2');
  });
});
