// 動態 near / far：鏡頭離舞台遠時把 near 拉大，深度精度才夠（不然貼很近的兩個面會閃爍、出現條紋）。
// near 約為「鏡頭到看向點距離」的 1/150，限制在 0.05～1 公尺；far 包住整個場景再加鏡頭距離。

export const CLIP_NEAR_MIN = 0.05;
export const CLIP_NEAR_MAX = 1;
export const CLIP_FAR_MIN = 200;

export function computeClipPlanes(camToTarget: number, sceneDiag: number): { near: number; far: number } {
  const dist = Number.isFinite(camToTarget) ? Math.max(camToTarget, 0) : 0;
  const diag = Number.isFinite(sceneDiag) ? Math.max(sceneDiag, 0) : 0;
  const near = Math.min(CLIP_NEAR_MAX, Math.max(CLIP_NEAR_MIN, dist / 150));
  const far = Math.max(CLIP_FAR_MIN, diag * 3 + dist * 2);
  return { near, far };
}

/** 只有數字真的變了才回傳 true（呼叫端才需要 updateProjectionMatrix） */
export function applyClipPlanes(
  cam: { near: number; far: number },
  camToTarget: number,
  sceneDiag: number,
): boolean {
  const { near, far } = computeClipPlanes(camToTarget, sceneDiag);
  if (Math.abs(cam.near - near) < cam.near * 0.02 && Math.abs(cam.far - far) < cam.far * 0.02) return false;
  cam.near = near;
  cam.far = far;
  return true;
}
