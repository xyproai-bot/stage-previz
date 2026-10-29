// 測試用：沒有瀏覽器（jsdom）也能把 React hook 跑起來。
// 自己接一個最小的 hook 執行環境（useState / useRef / useMemo / useCallback / useEffect），
// 這樣可以直接測真的 hook（例如 useMusicPlayer）：丟事件進去、看它回傳的狀態。
//
//   const h = renderHook((p: { id: string }) => useThing(p.id), { id: 'a' });
//   h.result            最新一次 render 的回傳
//   h.rerender({ id: 'b' })   換參數再 render（會跑 effect）
//   h.unmount()         跑所有 effect 的清理
// 狀態更新（setState）會馬上重新 render，effect 跑完如果又改了狀態也會接著 render。
import * as React from 'react';

type Cleanup = void | (() => void);
interface EffectSlot { kind: 'effect'; deps: unknown[] | undefined; create: () => Cleanup; cleanup: Cleanup; ran: boolean }
interface StateSlot { kind: 'state'; value: unknown; set: (v: unknown) => void }
interface RefSlot { kind: 'ref'; ref: { current: unknown } }
interface MemoSlot { kind: 'memo'; deps: unknown[] | undefined; value: unknown }
type Slot = EffectSlot | StateSlot | RefSlot | MemoSlot;

const internals = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } } })
  .__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;

const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

export function renderHook<P, R>(useIt: (props: P) => R, initial: P) {
  const slots: Slot[] = [];
  let idx = 0;
  let props = initial;
  let rendering = false;
  let again = false;
  let current!: R;
  let unmounted = false;

  function useMemoImpl(factory: () => unknown, deps?: unknown[]) {
    const i = idx++;
    const slot = slots[i] as MemoSlot | undefined;
    if (slot && sameDeps(slot.deps, deps)) return slot.value;
    const value = factory();
    slots[i] = { kind: 'memo', deps, value };
    return value;
  }

  const dispatcher = {
    useState(init: unknown) {
      const i = idx++;
      let slot = slots[i] as StateSlot | undefined;
      if (!slot) {
        const s: StateSlot = {
          kind: 'state', value: typeof init === 'function' ? (init as () => unknown)() : init,
          set: (v) => {
            const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(s.value) : v;
            if (Object.is(next, s.value)) return;
            s.value = next;
            if (!unmounted) schedule();
          },
        };
        slots[i] = s;
        slot = s;
      }
      return [slot.value, slot.set];
    },
    useRef(init: unknown) {
      const i = idx++;
      if (!slots[i]) slots[i] = { kind: 'ref', ref: { current: init } };
      return (slots[i] as RefSlot).ref;
    },
    useMemo: useMemoImpl,
    useCallback(fn: unknown, deps?: unknown[]) {
      return useMemoImpl(() => fn, deps);
    },
    useEffect(create: () => Cleanup, deps?: unknown[]) {
      const i = idx++;
      const slot = slots[i] as EffectSlot | undefined;
      if (!slot) { slots[i] = { kind: 'effect', deps, create, cleanup: undefined, ran: false }; return; }
      if (sameDeps(slot.deps, deps)) return;
      slot.deps = deps;
      slot.create = create;
      slot.ran = false;
    },
  } as Record<string, unknown>;
  dispatcher.useLayoutEffect = dispatcher.useEffect;

  function renderOnce() {
    const prev = internals.current;
    internals.current = dispatcher;
    idx = 0;
    try { current = useIt(props); } finally { internals.current = prev; }
    // effect：依賴變了的先清理舊的、再跑新的
    for (const s of slots) {
      if (s.kind !== 'effect' || s.ran) continue;
      if (typeof s.cleanup === 'function') s.cleanup();
      s.cleanup = undefined;
      s.ran = true;
      s.cleanup = s.create();
    }
  }

  function schedule() {
    if (rendering) { again = true; return; }
    rendering = true;
    try {
      let guard = 0;
      do {
        again = false;
        renderOnce();
        if (++guard > 50) throw new Error('hook 一直重新 render（無限迴圈？）');
      } while (again);
    } finally { rendering = false; }
  }

  schedule();
  return {
    get result(): R { return current; },
    rerender(next: P) { props = next; schedule(); },
    unmount() {
      unmounted = true;
      for (const s of slots) if (s.kind === 'effect' && typeof s.cleanup === 'function') { s.cleanup(); s.cleanup = undefined; }
    },
  };
}
