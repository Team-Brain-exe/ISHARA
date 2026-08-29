// Minimal Dynamic Time Warping for comparing two sequences of hand-landmark frames.
// Each frame is a flattened array of (x, y) for 21 landmarks = 42 numbers.

export type Frame = number[]; // length 42

export function flattenLandmarks(landmarks: { x: number; y: number }[]): Frame {
  const out: number[] = [];
  for (const p of landmarks) {
    out.push(p.x, p.y);
  }
  return out;
}

function frameDistance(a: Frame, b: Frame): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// Returns the DTW distance between two sequences (lower = more similar).
// Normalized by path length so sequences of different lengths compare fairly.
export function dtwDistance(seqA: Frame[], seqB: Frame[]): number {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(Infinity)
  );
  dp[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = frameDistance(seqA[i - 1], seqB[j - 1]);
      dp[i][j] =
        cost + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[n][m] / (n + m); // normalize by path length
}

export interface Reference {
  label: string;
  sequence: Frame[];
}

export function matchBest(
  live: Frame[],
  references: Reference[]
): { label: string; distance: number } | null {
  if (references.length === 0) return null;
  let best: { label: string; distance: number } | null = null;
  for (const ref of references) {
    const d = dtwDistance(live, ref.sequence);
    if (!best || d < best.distance) {
      best = { label: ref.label, distance: d };
    }
  }
  return best;
}
