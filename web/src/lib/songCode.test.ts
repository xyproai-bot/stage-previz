import { describe, it, expect } from 'vitest';
import { normalizeSongCode, songCodeKey, songCodeTakenBy, songTitle } from './songCode';
import { detectVideoLink, videoLinkHint } from './videoLink';

describe('歌曲代號', () => {
  it('存成大寫、去空白；字母數字和中間的 -', () => {
    expect(normalizeSongCode(' s03 ')).toEqual({ code: 'S03' });
    expect(normalizeSongCode('enc-1')).toEqual({ code: 'ENC-1' });
    expect(normalizeSongCode('OP')).toEqual({ code: 'OP' });
  });

  it('格式不對 → 白話中文', () => {
    expect(normalizeSongCode('')).toEqual({ error: '代號不能是空的' });
    expect(normalizeSongCode('S01_A')).toHaveProperty('error');
    expect(normalizeSongCode('S 01')).toHaveProperty('error');
    expect(normalizeSongCode('-S1')).toHaveProperty('error');
    expect(normalizeSongCode('S1-')).toHaveProperty('error');
    expect(normalizeSongCode('ABCDEFGHIJKLM')).toEqual({ error: '代號最多 12 個字' });
  });

  it('S1 和 S01 算同一個；自己那首不算撞到', () => {
    expect(songCodeKey('S001')).toBe(songCodeKey('s1'));
    const songs = [{ id: 'a', name: '開場', code: 'S01' }, { id: 'b', name: '主題曲', code: 'S02' }];
    expect(songCodeTakenBy('S1', songs, 'b')?.name).toBe('開場');
    expect(songCodeTakenBy('S01', songs, 'a')).toBeNull();
    expect(songCodeTakenBy('S09', songs, 'a')).toBeNull();
  });

  it('歌名前面加代號', () => {
    expect(songTitle({ name: '主題曲', code: 'S03' })).toBe('S03 主題曲');
    expect(songTitle({ name: '主題曲', code: null })).toBe('主題曲');
  });
});

describe('貼連結：看起來是哪一種', () => {
  it('認得 Drive / Dropbox / OneDrive / 直接網址', () => {
    expect(detectVideoLink('https://drive.google.com/file/d/abc/view')).toBe('drive');
    expect(detectVideoLink('https://www.dropbox.com/scl/fi/x/a.mp4?dl=0')).toBe('dropbox');
    expect(detectVideoLink('https://1drv.ms/v/s!abc')).toBe('onedrive');
    expect(detectVideoLink('https://contoso.sharepoint.com/:v:/g/x')).toBe('onedrive');
    expect(detectVideoLink('https://cdn.example.com/S01.MOV')).toBe('direct');
    expect(detectVideoLink('https://example.com/watch')).toBe('other');
  });

  it('空的 / 不是網址', () => {
    expect(detectVideoLink('  ')).toBe('empty');
    expect(detectVideoLink('abc')).toBe('invalid');
    expect(detectVideoLink('ftp://x.com/a.mp4')).toBe('invalid');
    expect(videoLinkHint('invalid')).toContain('https://');
  });
});
