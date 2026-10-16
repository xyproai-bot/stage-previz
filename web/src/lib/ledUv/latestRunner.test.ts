// 3D 預覽的節流：邊拖邊更新，但同一時間只算一次、兩次之間隔一下、永遠算最新的
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLatestRunner } from './latestRunner';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

/** 一個要算 ms 毫秒的工作（可以控制什麼時候算完） */
function slowTask(ms: number) {
  const starts: number[] = [];
  const task = vi.fn(async () => {
    starts.push(Date.now());
    await new Promise<void>(r => setTimeout(r, ms));
  });
  return { task, starts };
}

describe('createLatestRunner', () => {
  it('第一次 trigger 馬上算；很多次 trigger 只算一次', async () => {
    const { task } = slowTask(0);
    const r = createLatestRunner(task, { gapMs: 200 });
    for (let i = 0; i < 50; i++) r.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('連續拖曳（每 16 毫秒 trigger 一次，持續 1 秒，每次算 50 毫秒）：開始的間隔至少 200 毫秒，不會同時算兩個，拖完會補算最後一次', async () => {
    const { task, starts } = slowTask(50);
    const r = createLatestRunner(task, { gapMs: 200 });
    let active = 0, maxActive = 0;
    task.mockImplementation(async () => {
      starts.push(Date.now());
      active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>(res => setTimeout(res, 50));
      active--;
    });
    for (let t = 0; t < 1000; t += 16) {
      r.trigger();
      await vi.advanceTimersByTimeAsync(16);
    }
    const lastTrigger = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    expect(maxActive).toBe(1);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(200);
    expect(starts.length).toBeGreaterThanOrEqual(4);
    expect(starts.length).toBeLessThanOrEqual(7);
    // 最後一次 trigger 以後一定又算了一次（拿到的是最新的排法）
    expect(starts[starts.length - 1]).toBeGreaterThanOrEqual(lastTrigger - 16);
    expect(r.running).toBe(false);
  });

  it('沒有新的 trigger 就不會再算；算的途中來的 trigger 在算完以後補一次', async () => {
    const { task } = slowTask(100);
    const r = createLatestRunner(task, { gapMs: 0 });
    r.trigger();
    await vi.advanceTimersByTimeAsync(10);
    expect(r.running).toBe(true);
    r.trigger();
    r.trigger();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('工作丟錯不會卡住後面的；dispose 以後什麼都不跑', async () => {
    let n = 0;
    const task = vi.fn(async () => { n++; if (n === 1) throw new Error('壞了'); });
    const r = createLatestRunner(task, { gapMs: 0 });
    r.trigger();
    await vi.advanceTimersByTimeAsync(0);
    r.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
    r.trigger();
    r.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    r.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
