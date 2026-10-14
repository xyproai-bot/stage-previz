import { describe, expect, it } from 'vitest';
import { classifyLink, findLinks, linkCards, safeLinkUrl, shortenUrl, splitLinks, trimUrlEnd } from './commentLinks';

const links = (s: string) => splitLinks(s).filter(p => p.type === 'link').map(p => (p as { url: string }).url);

describe('找出留言裡的網址', () => {
  it('中文緊貼著網址：網址只到英數和網址符號', () => {
    expect(links('參考這個https://youtu.be/dQw4w9WgXcQ很好看')).toEqual(['https://youtu.be/dQw4w9WgXcQ']);
    expect(links('影片在 https://vimeo.com/123456 第二段')).toEqual(['https://vimeo.com/123456']);
  });

  it('結尾的標點不算：」。，、！？ . , ) 都斷開', () => {
    expect(links('「https://a.com/x」')).toEqual(['https://a.com/x']);
    expect(links('看 https://a.com/x。')).toEqual(['https://a.com/x']);
    expect(links('看 https://a.com/x.')).toEqual(['https://a.com/x']);
    expect(links('(https://a.com/x)')).toEqual(['https://a.com/x']);
    expect(links('https://a.com/x，然後 https://b.com/y！')).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(links('https://a.com/a?b=1&c=2, 好')).toEqual(['https://a.com/a?b=1&c=2']);
  });

  it('全形字：全形標點、空白會斷開；全形英文的網址不算', () => {
    expect(links('連結：https://a.com/x（第二版）')).toEqual(['https://a.com/x']);
    expect(links('https://a.com/x　下一句')).toEqual(['https://a.com/x']);
    expect(links('ｈｔｔｐｓ：／／ａ．ｃｏｍ')).toEqual([]);
  });

  it('成對的括號留著（維基百科那種網址）', () => {
    expect(links('https://en.wikipedia.org/wiki/Stage_(theatre) 這篇')).toEqual(['https://en.wikipedia.org/wiki/Stage_(theatre)']);
    expect(trimUrlEnd('https://a.com/x).')).toBe('https://a.com/x');
  });

  it('只認 http / https；沒有網域、有帳號密碼的不變成連結', () => {
    expect(links('javascript:alert(1) data:text/html,x ftp://a.com')).toEqual([]);
    expect(links('https://')).toEqual([]);
    expect(links('https://youtube.com@evil.example/x')).toEqual([]);
    expect(safeLinkUrl('https://a.com/<script>')).toBe('https://a.com/%3Cscript%3E');
  });

  it('切成字 / 連結，接起來跟原文一樣', () => {
    const s = '第 3 個 cue 參考 https://youtu.be/dQw4w9WgXcQ?t=42，還有 https://drive.google.com/file/d/abc/view。';
    const parts = splitLinks(s);
    expect(parts.map(p => p.text).join('')).toBe(s);
    expect(parts.filter(p => p.type === 'link')).toHaveLength(2);
    expect(findLinks(`${s} https://youtu.be/dQw4w9WgXcQ?t=42`)).toHaveLength(2);
  });
});

describe('長網址縮短', () => {
  it('拿掉 https://、www.，太長的中間用「…」', () => {
    expect(shortenUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube.com/watch?v=dQw4w9WgXcQ');
    const long = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/view?usp=sharing';
    const s = shortenUrl(long);
    expect(s.length).toBeLessThanOrEqual(42);
    expect(s).toContain('…');
    expect(s.startsWith('drive.google.com/')).toBe(true);
    expect(s.endsWith('sp=sharing')).toBe(true);
  });
});

describe('認得的影片 / 參考網站 → 小卡片', () => {
  it('YouTube：watch、youtu.be、shorts、embed 都拿得到影片 id', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      const c = classifyLink(u);
      expect(c?.kind).toBe('youtube');
      expect(c?.youtubeId).toBe('dQw4w9WgXcQ');
    }
    expect(classifyLink('https://www.youtube.com/@someone')?.youtubeId).toBeUndefined();
    expect(classifyLink('https://youtube.com/shorts/dQw4w9WgXcQ')?.what).toBe('短影片');
  });

  it('其他網站', () => {
    expect(classifyLink('https://vimeo.com/76979871')?.label).toBe('Vimeo');
    expect(classifyLink('https://drive.google.com/drive/folders/abc')?.what).toBe('資料夾');
    expect(classifyLink('https://docs.google.com/presentation/d/abc')?.kind).toBe('drive');
    expect(classifyLink('https://www.dropbox.com/scl/fi/abc/x.mp4?dl=0')?.kind).toBe('dropbox');
    expect(classifyLink('https://www.instagram.com/reel/Cx123/')?.what).toBe('Reels 影片');
    expect(classifyLink('https://www.bilibili.com/video/BV1xx411c7mD')?.label).toBe('Bilibili');
    expect(classifyLink('https://b23.tv/abc')?.kind).toBe('bilibili');
    expect(classifyLink('https://v.youku.com/v_show/id_X.html')?.label).toBe('優酷');
  });

  it('不認得的、長得像的假網域不給卡片', () => {
    expect(classifyLink('https://example.com/video')).toBeNull();
    expect(classifyLink('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(classifyLink('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('一則最多 3 張卡片，同一個網址一張', () => {
    const t = 'https://youtu.be/dQw4w9WgXcQ https://youtu.be/dQw4w9WgXcQ https://vimeo.com/1 https://b23.tv/a https://v.youku.com/x https://example.com';
    expect(linkCards(t).map(c => c.kind)).toEqual(['youtube', 'vimeo', 'bilibili']);
  });
});
