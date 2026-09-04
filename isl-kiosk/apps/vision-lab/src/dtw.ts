export type Landmark = { x: number; y: number; z?: number };
export type Frame = number[];
const LANDMARKS_PER_HAND = 21;
const COORDS_PER_LANDMARK = 2;
const FEATURES_PER_HAND = LANDMARKS_PER_HAND * COORDS_PER_LANDMARK;
export const POSE_FEATURE_LENGTH = FEATURES_PER_HAND * 2;
function normalizeHand(landmarks: Landmark[]): number[] {
  const wrist = landmarks[0];
  const mid = landmarks[9];
  const scale = Math.max(Math.hypot(mid.x - wrist.x, mid.y - wrist.y), 1e-4);
  const out: number[] = [];
  for (const p of landmarks) out.push((p.x - wrist.x) / scale, (p.y - wrist.y) / scale);
  return out;
}
export function flattenLandmarks(hands: Landmark[][]): Frame {
  const out: number[] = [];
  for (let h = 0; h < 2; h++) out.push(...(hands[h] ? normalizeHand(hands[h]) : new Array(FEATURES_PER_HAND).fill(0)));
  return out;
}
export function interpolateGaps(seq: (Frame | null)[], maxGap = 4): Frame[] {
  const out: Frame[] = [];
  let lastGood: { frame: Frame; index: number } | null = null;
  for (let i = 0; i < seq.length; i++) {
    const f = seq[i];
    if (f) { lastGood = { frame: f, index: i }; out.push(f); continue; }
    let next: { frame: Frame; index: number } | null = null;
    for (let j = i + 1; j < Math.min(seq.length, i + 1 + maxGap); j++) { const g = seq[j]; if (g) { next = { frame: g, index: j }; break; } }
    if (lastGood && next) { const t = (i - lastGood.index) / (next.index - lastGood.index); out.push(lastGood.frame.map((v, k) => v + (next!.frame[k] - v) * t)); }
    else if (lastGood) out.push(lastGood.frame);
    else out.push(new Array(POSE_FEATURE_LENGTH).fill(0));
  }
  return out;
}
function withVelocity(seq: Frame[]): Frame[] {
  return seq.map((frame, i) => { const prev = i === 0 ? frame : seq[i - 1]; return [...frame, ...frame.map((v, k) => v - prev[k])]; });
}
function frameDistance(a: Frame, b: Frame): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}
export function dtwDistance(seqA: Frame[], seqB: Frame[], band = 15): number {
  const n = seqA.length, m = seqB.length;
  if (n === 0 || m === 0) return Infinity;
  const w = Math.max(band, Math.abs(n - m));
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - w); j <= Math.min(m, i + w); j++) {
      dp[i][j] = frameDistance(seqA[i - 1], seqB[j - 1]) + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[n][m] / (n + m);
}
export interface Reference { label: string; sequence: Frame[]; }
export function matchBest(live: Frame[], references: Reference[]): { label: string; distance: number } | null {
  if (references.length === 0 || live.length === 0) return null;
  const liveAug = withVelocity(live);
  let best: { label: string; distance: number } | null = null;
  for (const ref of references) {
    const d = dtwDistance(liveAug, withVelocity(ref.sequence));
    if (!best || d < best.distance) best = { label: ref.label, distance: d };
  }
  return best;
}
