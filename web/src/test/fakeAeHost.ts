// 測試用的假 After Effects：用來把產生的 .jsx 整支跑一遍（aeCompScript.test.ts、aeTemplateScript.test.ts 共用）。
// 只做腳本會碰到的那幾個 AE 物件（合成、圖層、屬性、檔案、prompt / alert）。

export interface FakeLayer {
  kind: 'shape' | 'text' | 'footage';
  name: string;
  label?: number;
  guideLayer: boolean;
  locked: boolean;
  comment?: string;
  blendingMode?: string;
  root: FakeProp;
  property: (n: string) => FakeProp;
}

export class FakeProp {
  value: unknown;
  name = '';
  children = new Map<string, FakeProp>();
  added: { type: string; prop: FakeProp }[] = [];
  constructor(public type: string) {}
  setValue(v: unknown) { this.value = v; }
  property(n: string): FakeProp {
    let p = this.children.get(n);
    if (!p) { p = new FakeProp(n); this.children.set(n, p); }
    return p;
  }
  addProperty(n: string): FakeProp {
    const p = new FakeProp(n);
    this.added.push({ type: n, prop: p });
    return p;
  }
}

export function runInFakeAe(script: string, opts: { answers: (string | null)[]; canWrite?: boolean }) {
  const alerts: string[] = [];
  const prompts: { msg: string; def: string }[] = [];
  const files = new Map<string, string>();
  const comps: Record<string, unknown>[] = [];
  const layers: FakeLayer[] = [];
  const answers = [...opts.answers];
  const makeLayer = (kind: FakeLayer['kind']): FakeLayer => {
    const root = new FakeProp('root');
    const l: FakeLayer = { kind, name: '', guideLayer: false, locked: false, root, property: (n: string) => root.property(n) };
    layers.unshift(l);
    return l;
  };
  const folderObj = (fsName: string) => ({ fsName, exists: true });
  class File {
    fsName: string;
    encoding = 'UTF-8';
    constructor(path: string) { this.fsName = path; }
    get parent() { return folderObj(this.fsName.replace(/[\\/][^\\/]*$/, '')); }
    get exists() { return files.has(this.fsName); }
    get length() { return files.get(this.fsName)?.length ?? 0; }
    open() { files.set(this.fsName, ''); return true; }
    write(s: string) { files.set(this.fsName, (files.get(this.fsName) ?? '') + s); }
    close() {}
  }
  const app = {
    project: {
      items: {
        addFolder: (name: string) => ({ name, remove() {} }),
        addComp: (name: string, width: number, height: number, par: number, duration: number, fps: number) => {
          const comp = {
            name, width, height, par, duration, fps, comment: '', parentFolder: null as unknown, opened: false, removed: false,
            layers: {
              addShape: () => makeLayer('shape'),
              addText: (text: string) => {
                const l = makeLayer('text');
                l.property('ADBE Text Properties').property('ADBE Text Document').value = { text };
                return l;
              },
              add: () => makeLayer('footage'),
            },
            openInViewer() { this.opened = true; },
            remove() { this.removed = true; },
          };
          comps.push(comp);
          return comp;
        },
      },
      importFile: (io: { file: File }) => ({ file: io.file, parentFolder: null }),
    },
    preferences: { getPrefAsLong: () => (opts.canWrite === false ? 0 : 1) },
    beginUndoGroup() {},
    endUndoGroup() {},
  };
  const env = {
    app,
    alert: (m: string) => { alerts.push(m); },
    prompt: (msg: string, def: string) => { prompts.push({ msg, def }); return answers.length ? answers.shift()! : null; },
    $: { os: 'Windows 10', fileName: 'C:/Users/me/Downloads/AE合成腳本.jsx' },
    File,
    Folder: { myDocuments: folderObj('C:/Users/me/Documents'), temp: folderObj('C:/Temp') },
    Shape: class { vertices: unknown; closed = false },
    ImportOptions: class { constructor(public file: File) {} },
    BlendingMode: { SCREEN: 'screen' },
    ParagraphJustification: { LEFT_JUSTIFY: 'left' },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...names, script.replace(/^\uFEFF/, ''))(...names.map(n => (env as Record<string, unknown>)[n]));
  return { alerts, prompts, files, comps, layers };
}
