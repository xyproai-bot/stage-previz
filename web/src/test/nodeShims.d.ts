// 測試在 node 裡讀檔用（這個專案沒有裝 @types/node，只宣告用到的幾個）
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
  export function existsSync(path: string | URL): boolean;
}
