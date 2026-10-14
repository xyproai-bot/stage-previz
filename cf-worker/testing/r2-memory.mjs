// 測試用：記憶體裡的假 R2（env.MODELS），夠備份 / 下載檔 / 模型檔的測試用
//   put（Uint8Array / ArrayBuffer / 字串 / ReadableStream；storageClass）、get（range、onlyIf: If-None-Match）、head、list（prefix / cursor / limit）、delete（一個或一串）
//   分段上傳 createMultipartUpload / resumeMultipartUpload（uploadPart / complete / abort；storageClass）
import { createHash } from 'node:crypto';

async function toBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (typeof value.getReader === 'function') return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error('fake R2: unsupported body');
}

function objectMeta(key, rec) {
  return {
    key,
    size: rec.bytes.byteLength,
    etag: rec.etag,
    httpEtag: `"${rec.etag}"`,
    uploaded: rec.uploaded,
    storageClass: rec.storageClass || 'Standard',
    httpMetadata: { ...rec.httpMetadata },
    customMetadata: { ...rec.customMetadata },
    writeHttpMetadata(headers) {
      if (rec.httpMetadata.contentType) headers.set('Content-Type', rec.httpMetadata.contentType);
      if (rec.httpMetadata.contentDisposition) headers.set('Content-Disposition', rec.httpMetadata.contentDisposition);
    },
  };
}

export function memoryR2({ clock = () => Date.now() } = {}) {
  const store = new Map();
  const calls = { put: 0, get: 0, head: 0, list: 0, delete: 0 };
  const uploads = new Map();
  let mpuSeq = 0;
  return {
    store,
    calls,
    uploads,
    keys() { return [...store.keys()].sort(); },
    bytes(key) { return store.get(key)?.bytes ?? null; },
    async put(key, value, opts = {}) {
      calls.put++;
      const bytes = await toBytes(value);
      const etag = createHash('md5').update(bytes).digest('hex');
      const rec = { bytes, etag, uploaded: new Date(clock()), httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {}, storageClass: opts.storageClass || 'Standard' };
      store.set(key, rec);
      return objectMeta(key, rec);
    },
    async createMultipartUpload(key, opts = {}) {
      calls.mpuCreate = (calls.mpuCreate || 0) + 1;
      const uploadId = 'mpu_' + (++mpuSeq);
      uploads.set(uploadId, { key, opts, parts: new Map() });
      return this.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      const bucket = this;
      return {
        key, uploadId,
        async uploadPart(n, value) {
          const u = uploads.get(uploadId);
          if (!u || u.key !== key) throw new Error('fake R2: no such upload');
          const bytes = await toBytes(value);
          const etag = createHash('md5').update(bytes).digest('hex');
          u.parts.set(n, { bytes, etag });
          return { partNumber: n, etag };
        },
        async complete(list) {
          const u = uploads.get(uploadId);
          if (!u || u.key !== key) throw new Error('fake R2: no such upload');
          const chunks = list.map(({ partNumber, etag }) => {
            const p = u.parts.get(partNumber);
            if (!p || p.etag !== etag) throw new Error('fake R2: bad part');
            return p.bytes;
          });
          const total = chunks.reduce((a, c) => a + c.byteLength, 0);
          const all = new Uint8Array(total);
          let o = 0;
          for (const c of chunks) { all.set(c, o); o += c.byteLength; }
          uploads.delete(uploadId);
          return bucket.put(key, all, u.opts);
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
    async head(key) {
      calls.head++;
      const rec = store.get(key);
      return rec ? objectMeta(key, rec) : null;
    },
    async get(key, opts = {}) {
      calls.get++;
      const rec = store.get(key);
      if (!rec) return null;
      const meta = objectMeta(key, rec);
      const inm = opts.onlyIf && typeof opts.onlyIf.get === 'function' ? opts.onlyIf.get('if-none-match') : null;
      if (inm && inm.split(',').map(s => s.trim().replace(/^W\//, '')).includes(meta.httpEtag)) return meta;  // 沒有 body = 條件不成立
      let bytes = rec.bytes;
      if (opts.range) {
        const { offset = 0, length, suffix } = opts.range;
        if (suffix !== undefined) bytes = bytes.slice(Math.max(0, bytes.byteLength - suffix));
        else bytes = bytes.slice(offset, length === undefined ? undefined : offset + length);
      }
      const copy = new Uint8Array(bytes);
      return {
        ...meta,
        body: new Response(copy).body,
        async arrayBuffer() { return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength); },
        async text() { return new TextDecoder().decode(copy); },
        async json() { return JSON.parse(new TextDecoder().decode(copy)); },
      };
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      calls.list++;
      const all = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return {
        objects: slice.map(k => objectMeta(k, store.get(k))),
        truncated,
        cursor: truncated ? String(start + limit) : undefined,
        delimitedPrefixes: [],
      };
    },
    async delete(keys) {
      calls.delete++;
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}
