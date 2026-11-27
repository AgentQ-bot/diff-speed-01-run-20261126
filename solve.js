// A faster drop-in for makefun-diff 1.0.0: run(input) returns the same patch string the reference
// returns for input { old, new }, byte for byte, in less CPU time.
//
// The rule implemented (make.fun's, stated in the house baseline's header): a text is cut after every
// "\n" (the only separator; a "\r" belongs to its line), and a last line with no "\n" is a line too;
// two lines are equal only as the same code units, newline or its absence included. The longest common
// line prefix is kept, then the longest common suffix of what is left; between them Myers's greedy
// search keeps, on each diagonal k = x - y, the path reaching furthest into the old text, preferring
// the deletion's path when a deletion and an insertion reach the same point, never stepping past
// either text's end, pruning no edge diagonal, and following every run of equal lines as far as it
// goes; the first path to reach both ends is the script. The patch lists each change run's deletions
// before its insertions, shows up to 3 kept lines either side, and shares a hunk between runs at
// most 6 kept lines apart; a line ending its text without a newline is written with one and followed
// by a "%" line; identical texts are the header line alone.
//
// Speed comes from representation only: lines are interned to small integer ids (a newline-terminated
// line and a bare line of the same content get different ids, so equality stays exact), the search
// keeps furthest-x values in a flat Int32Array history instead of path objects, and the script is
// recovered by backtracking that history with the same candidate comparison the forward pass used.
// The search also skips diagonals that cannot reach the final diagonal within an upper bound on the
// edit distance (from a long common subsequence): every shortest path stays inside that band and
// both predecessors of a band diagonal lie in the previous row's band, so the furthest-x values the
// reference computes on the band — and the path backtracked from them — are unchanged.

/** Kept lines shown before and after each change run. */
const CONTEXT = 3;

// Run kinds in the recovered script.
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * Interns one text's lines to integer ids. Returns the split parts (for writing the patch), the ids,
 * and the line count. Terminated lines and the bare last line use separate maps over one id counter,
 * so "a\n" and a final "a" never share an id.
 */
function internLines(text, terminated, bare, counter) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const hasBare = parts[last] !== '';
  const n = last + (hasBare ? 1 : 0);
  const ids = new Int32Array(n);
  for (let i = 0; i < last; i++) {
    const key = parts[i];
    let id = terminated.get(key);
    if (id === undefined) {
      id = counter.next++;
      terminated.set(key, id);
    }
    ids[i] = id;
  }
  if (hasBare) {
    const key = parts[last];
    let id = bare.get(key);
    if (id === undefined) {
      id = counter.next++;
      bare.set(key, id);
    }
    ids[last] = id;
  }
  return { parts, last, ids, n };
}

/**
 * The length of a long common subsequence of A[0..N) and B[0..M): lines occurring once in each text
 * anchor it (their longest increasing subsequence), and a greedy earliest-match scan fills the gaps
 * between anchors. Any common subsequence of length L bounds the edit distance by N + M - 2L.
 */
function subsequenceLength(A, N, B, M, numIds) {
  const cntA = new Int32Array(numIds);
  const cntB = new Int32Array(numIds);
  for (let i = 0; i < N; i++) cntA[A[i]]++;
  for (let j = 0; j < M; j++) cntB[B[j]]++;
  const startB = new Int32Array(numIds + 1);
  for (let id = 0; id < numIds; id++) startB[id + 1] = startB[id] + cntB[id];
  const posB = new Int32Array(M);
  const fill = new Int32Array(numIds);
  for (let id = 0; id < numIds; id++) fill[id] = startB[id];
  for (let j = 0; j < M; j++) posB[fill[B[j]]++] = j;

  // Anchors: A positions whose line occurs once in each text, paired with its B position; keep a
  // longest strictly increasing subsequence of the B positions.
  const aI = [];
  const aJ = [];
  for (let i = 0; i < N; i++) {
    const id = A[i];
    if (cntA[id] === 1 && cntB[id] === 1) {
      aI.push(i);
      aJ.push(posB[startB[id]]);
    }
  }
  const tails = [];
  const tailIdx = [];
  const prevIdx = new Int32Array(aJ.length).fill(-1);
  for (let t = 0; t < aJ.length; t++) {
    const v = aJ[t];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIdx[lo] = t;
    prevIdx[t] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const anchors = [];
  for (let t = tails.length > 0 ? tailIdx[tails.length - 1] : -1; t >= 0; t = prevIdx[t]) anchors.push(t);
  anchors.reverse();

  // Greedy earliest-match within each gap between anchors (and before the first / after the last).
  // ptr[id] walks id's B occurrences; the matched B position only moves forward, so it never rewinds.
  const ptr = new Int32Array(numIds);
  for (let id = 0; id < numIds; id++) ptr[id] = startB[id];
  let length = anchors.length;
  let lastJ = -1;
  let fromI = 0;
  const fillGap = (toI, toJ) => {
    for (let i = fromI; i < toI; i++) {
      const id = A[i];
      const end = startB[id] + cntB[id];
      let p = ptr[id];
      while (p < end && posB[p] <= lastJ) p++;
      ptr[id] = p;
      if (p < end && posB[p] < toJ) {
        length++;
        lastJ = posB[p];
      }
    }
  };
  for (const t of anchors) {
    fillGap(aI[t], aJ[t]);
    lastJ = aJ[t];
    fromI = aI[t] + 1;
  }
  fillGap(N, M);
  return length;
}

/**
 * Myers's greedy search over A[a0..a0+N) and B[b0..b0+M) (line ids), returning the edit script as
 * parallel arrays of kinds and counts, in order. The furthest-x history is a flat triangular
 * Int32Array: row d holds x for k = -d, -d+2, ..., d at index d*(d+1)/2 + (k+d)/2, with -1 for a
 * diagonal no path reaches. Only the band |k - (N - M)| <= Dlim - d is computed, where Dlim bounds
 * the edit distance (see subsequenceLength): a shortest path never leaves the band, and both
 * predecessors of a band diagonal are in the previous row's band, so band values match the
 * reference's. Diagonals outside [-M, N] are likewise skipped: no path can sit on them.
 */
function editScript(A, a0, N, B, b0, M, numIds) {
  const kinds = [];
  const counts = [];
  if (N === 0 && M === 0) return { kinds, counts };
  const Av = A.subarray(a0, a0 + N);
  const Bv = B.subarray(b0, b0 + M);
  const kFinal = N - M;
  const bound = Math.max(subsequenceLength(Av, N, Bv, M, numIds), subsequenceLength(Bv, M, Av, N, numIds));
  const Dlim = N + M - 2 * bound;
  // No fill: every slot the search or the backtrack reads was written by the row before (band
  // predecessors lie in the previous band), and the k > -M / k < N guards keep the two diagonals
  // just outside [-M, N] — whose slots are never written — from being taken as predecessors.
  const hist = new Int32Array(((Dlim + 1) * (Dlim + 2)) / 2);

  // d = 0: only the snake from the origin.
  let x = 0;
  const xMax0 = N < M ? N : M;
  while (x < xMax0 && Av[x] === Bv[x]) x++;
  hist[0] = x;
  let foundD = x === N && x === M ? 0 : -1;

  for (let d = 1; foundD < 0 && d <= Dlim; d++) {
    const prevStart = (d * (d - 1)) / 2;
    const curStart = (d * (d + 1)) / 2;
    const rem = Dlim - d;
    let kLo = kFinal - rem;
    if (kLo < -d) kLo = -d;
    if (kLo < -M) kLo = -M;
    if (((kLo + d) & 1) !== 0) kLo++;
    let kHi = kFinal + rem;
    if (kHi > d) kHi = d;
    if (kHi > N) kHi = N;
    if (((kHi + d) & 1) !== 0) kHi--;
    const jLo = (kLo + d) >> 1;
    const jHi = (kHi + d) >> 1;
    let pi = prevStart + jLo;
    let ci = curStart + jLo;
    // xv carries the previous row's index j-1 (the deletion predecessor); each step's insertion
    // predecessor (index j) becomes the next step's xv.
    let xv = jLo >= 1 ? hist[pi - 1] : -1;
    for (let j = jLo, k = kLo; j <= jHi; j++, k += 2, pi++, ci++) {
      const yv = j < d ? hist[pi] : -1;
      // Deletion candidate: from diagonal k-1, one old line further (needs xv < N and k-1 >= -M).
      let xDel = -1;
      if (xv >= 0 && xv < N && k > -M) xDel = xv + 1;
      // Insertion candidate: from diagonal k+1, one new line further (needs its y < M and k+1 <= N).
      let xIns = -1;
      if (yv >= 0 && yv - (k + 1) < M && k < N) xIns = yv;
      xv = yv;
      if (xDel < 0 && xIns < 0) {
        hist[ci] = -1;
        continue;
      }
      // Furthest into the old text; the deletion wins a tie (xDel >= xIns).
      x = xDel >= xIns ? xDel : xIns;
      const xMax = k + M < N ? k + M : N;
      while (x < xMax && Av[x] === Bv[x - k]) x++;
      hist[ci] = x;
      if (x === N && k === kFinal) {
        foundD = d;
        break;
      }
    }
  }
  if (foundD < 0) throw new Error('diff: the search ended without reaching both ends');

  // Backtrack: at (d, k) the stored x and the same candidate comparison as the forward pass give
  // the snake length and the edit that led here. Collected in reverse, merged as they reverse.
  const revKinds = [];
  const revCounts = [];
  let k = N - M;
  x = N;
  for (let d = foundD; d > 0; d--) {
    const curStart = (d * (d + 1)) / 2;
    const prevStart = (d * (d - 1)) / 2;
    const j = (k + d) >> 1;
    const xd = hist[curStart + j];
    let xDel = -1;
    let xv = -1;
    if (j >= 1 && k > -M) {
      xv = hist[prevStart + j - 1];
      if (xv >= 0 && xv < N) xDel = xv + 1;
    }
    let xIns = -1;
    let yv = -1;
    if (j < d && k < N) {
      yv = hist[prevStart + j];
      if (yv >= 0 && yv - (k + 1) < M) xIns = yv;
    }
    let snake;
    let edit;
    if (xDel >= xIns) {
      snake = xd - xDel;
      edit = DELETE;
      k = k - 1;
      x = xv;
    } else {
      snake = xd - xIns;
      edit = INSERT;
      k = k + 1;
      x = yv;
    }
    if (snake > 0) {
      revKinds.push(KEEP);
      revCounts.push(snake);
    }
    revKinds.push(edit);
    revCounts.push(1);
  }
  if (x > 0) {
    revKinds.push(KEEP);
    revCounts.push(x);
  }
  for (let i = revKinds.length - 1; i >= 0; i--) {
    const kind = revKinds[i];
    const lastIdx = kinds.length - 1;
    if (lastIdx >= 0 && kinds[lastIdx] === kind) counts[lastIdx] += revCounts[i];
    else {
      kinds.push(kind);
      counts.push(revCounts[i]);
    }
  }
  return { kinds, counts };
}

/** makefun-diff 1.0.0's answer for one case's input { old, new }: the patch string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const terminated = new Map();
  const bare = new Map();
  const counter = { next: 0 };
  const oldSide = internLines(input.old, terminated, bare, counter);
  const newSide = internLines(input.new, terminated, bare, counter);
  const A = oldSide.ids;
  const B = newSide.ids;
  const n = oldSide.n;
  const m = newSide.n;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;

  const mid = editScript(A, prefix, n - prefix - suffix, B, prefix, m - prefix - suffix, counter.next);

  // The change runs: stretches of deletions/insertions between kept lines, each at old line o and
  // new line p. Adjacent edit runs with no kept line between them merge into one change.
  const chO = [];
  const chP = [];
  const chD = [];
  const chI = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  const applyRun = (kind, count) => {
    if (kind === KEEP) {
      o += count;
      p += count;
      return;
    }
    let idx = chO.length - 1;
    if (idx < 0 || chO[idx] + chD[idx] !== o || chP[idx] + chI[idx] !== p) {
      chO.push(o);
      chP.push(p);
      chD.push(0);
      chI.push(0);
      idx++;
    }
    if (kind === DELETE) {
      chD[idx] += count;
      o += count;
      deleted += count;
    } else {
      chI[idx] += count;
      p += count;
      inserted += count;
    }
  };
  if (prefix > 0) applyRun(KEEP, prefix);
  for (let i = 0; i < mid.kinds.length; i++) applyRun(mid.kinds[i], mid.counts[i]);
  if (suffix > 0) applyRun(KEEP, suffix);

  // Hunks: change runs at most 2*CONTEXT kept lines apart share one. hunkStarts holds the change
  // index each hunk begins at.
  const hunkStarts = [];
  for (let i = 0; i < chO.length; i++) {
    if (i === 0) {
      hunkStarts.push(0);
      continue;
    }
    const gap = chO[i] - (chO[i - 1] + chD[i - 1]);
    if (gap > 2 * CONTEXT) hunkStarts.push(i);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunkStarts.length} deleted=${deleted} inserted=${inserted}\n`];
  const oldParts = oldSide.parts;
  const oldLast = oldSide.last;
  const newParts = newSide.parts;
  const newLast = newSide.last;
  const writeOld = (op, i) => {
    if (i < oldLast) out.push(op, oldParts[i], '\n');
    else out.push(op, oldParts[i], '\n%\n');
  };
  const writeNew = (op, i) => {
    if (i < newLast) out.push(op, newParts[i], '\n');
    else out.push(op, newParts[i], '\n%\n');
  };

  for (let h = 0; h < hunkStarts.length; h++) {
    const h0 = hunkStarts[h];
    const h1 = h + 1 < hunkStarts.length ? hunkStarts[h + 1] : chO.length;
    const lastIdx = h1 - 1;
    const oldStart = Math.max(0, chO[h0] - CONTEXT);
    const newStart = chP[h0] - (chO[h0] - oldStart);
    const after = Math.min(CONTEXT, n - (chO[lastIdx] + chD[lastIdx]));
    const oldEnd = chO[lastIdx] + chD[lastIdx] + after;
    const newEnd = chP[lastIdx] + chI[lastIdx] + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let ci = h0; ci < h1; ci++) {
      for (; at < chO[ci]; at++) writeOld('=', at);
      for (let i = 0; i < chD[ci]; i++) writeOld('-', chO[ci] + i);
      for (let i = 0; i < chI[ci]; i++) writeNew('+', chP[ci] + i);
      at = chO[ci] + chD[ci];
    }
    for (; at < oldEnd; at++) writeOld('=', at);
  }
  return out.join('');
}
