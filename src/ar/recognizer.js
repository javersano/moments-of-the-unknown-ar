// Artwork recognizer: which of N artworks is the camera looking at?
//
// MindAR can verify + track one artwork cheaply, but its detector compares a
// frame against every target one by one, so it collapses at hundreds of
// targets. This module answers "which one?" first, using the very same FREAK
// descriptors MindAR computes, quantized through a vocabulary tree into visual
// words and scored with tf-idf against every artwork at once (Nistér &
// Stewénius, 2006). Cost is independent of collection size; the top few
// candidates are then handed to MindAR for geometric verification + tracking.
//
// Isomorphic: the build pipeline (Node) trains + writes the index, the viewer
// (browser) loads it and scores camera frames.

export const DESC_WORDS = 21; // FREAK: 666 bits packed in 21 x uint32

// ---------- hamming ----------
function popcnt(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
function hamming(a, ao, b, bo) {
  let d = 0;
  for (let i = 0; i < DESC_WORDS; i++) d += popcnt(a[ao + i] ^ b[bo + i]);
  return d;
}

// ---------- vocabulary tree (k-majority on binary descriptors) ----------
// Tree is complete K-ary of depth L, node centers stored level by level.
// Two trees: one for DoG maxima, one for minima (MindAR never matches across).

function nearestChild(centers, base, K, desc, dOff) {
  let best = 0, bestD = 1e9;
  for (let k = 0; k < K; k++) {
    const d = hamming(centers, (base + k) * DESC_WORDS, desc, dOff);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** Quantize one descriptor to a leaf index in [0, K^L). */
export function quantize(tree, desc, dOff = 0) {
  const { K, L, centers } = tree;
  let node = 0;       // index within level
  let levelBase = 0;  // first node index of current level
  let levelSize = K;
  for (let l = 0; l < L; l++) {
    const k = nearestChild(centers, levelBase + node * K, K, desc, dOff);
    node = node * K + k;
    levelBase += levelSize;
    levelSize *= K;
  }
  return node;
}

// Node-only training (uses a seeded RNG for reproducible builds).
export function trainTree(descs, count, K, L, seed = 1) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const totalNodes = (K ** (L + 1) - K) / (K - 1);
  const centers = new Uint32Array(totalNodes * DESC_WORDS);
  // level-by-level: each item carries the node it belongs to at this level
  let members = [Array.from({ length: count }, (_, i) => i)];
  let levelBase = 0;
  for (let l = 0; l < L; l++) {
    const next = [];
    for (let n = 0; n < members.length; n++) {
      const idx = members[n];
      const base = levelBase + n * K;
      const groups = kMajority(descs, idx, K, rand, centers, base);
      for (const g of groups) next.push(g);
    }
    members = next;
    levelBase += K ** (l + 1);
  }
  return { K, L, centers };
}

function kMajority(descs, idx, K, rand, centers, base, iters = 6) {
  const W = DESC_WORDS;
  // init: random members as centers (or random bits if too few)
  for (let k = 0; k < K; k++) {
    const o = (base + k) * W;
    if (idx.length) {
      const pick = idx[Math.floor(rand() * idx.length)] * W;
      for (let i = 0; i < W; i++) centers[o + i] = descs[pick + i];
    } else {
      for (let i = 0; i < W; i++) centers[o + i] = (rand() * 4294967296) >>> 0;
    }
  }
  let assign = new Int32Array(idx.length);
  const counts = new Int32Array(K * W * 32);
  for (let it = 0; it < iters && idx.length; it++) {
    for (let j = 0; j < idx.length; j++) assign[j] = nearestChild(centers, base, K, descs, idx[j] * W);
    counts.fill(0);
    const sizes = new Int32Array(K);
    for (let j = 0; j < idx.length; j++) {
      const k = assign[j], o = idx[j] * W;
      sizes[k]++;
      for (let i = 0; i < W; i++) {
        let v = descs[o + i];
        const c = (k * W + i) * 32;
        for (let b = 0; v && b < 32; b++, v >>>= 1) if (v & 1) counts[c + b]++;
      }
    }
    for (let k = 0; k < K; k++) {
      const o = (base + k) * W;
      if (!sizes[k]) { // empty cluster: reseed
        const pick = idx[Math.floor(rand() * idx.length)] * W;
        for (let i = 0; i < W; i++) centers[o + i] = descs[pick + i];
        continue;
      }
      const half = sizes[k] / 2;
      for (let i = 0; i < W; i++) {
        let v = 0;
        const c = (k * W + i) * 32;
        for (let b = 0; b < 32; b++) if (counts[c + b] > half) v |= 1 << b;
        centers[o + i] = v >>> 0;
      }
    }
  }
  const groups = Array.from({ length: K }, () => []);
  for (let j = 0; j < idx.length; j++) groups[assign[j]].push(idx[j]);
  return groups;
}

// ---------- index ----------
// words: maxima leaf -> [0, V), minima leaf -> [V, 2V)
export function pointWord(index, p) {
  const desc = p.descriptors instanceof Uint32Array ? p.descriptors : Uint32Array.from(p.descriptors);
  const tree = p.maxima ? index.treeMax : index.treeMin;
  return (p.maxima ? 0 : index.V) + quantize(tree, desc, 0);
}

/** Build per-target bag of words: Map word -> count. */
export function bagOfWords(index, points) {
  const bag = new Map();
  for (const p of points) {
    const w = pointWord(index, p);
    bag.set(w, (bag.get(w) || 0) + 1);
  }
  return bag;
}

/** Finalize: idf weights, normalized target vectors, inverted lists. */
export function finalizeIndex(index, bags) {
  const nW = 2 * index.V, N = bags.length;
  const df = new Float32Array(nW);
  for (const bag of bags) for (const w of bag.keys()) df[w]++;
  const idf = new Float32Array(nW);
  for (let w = 0; w < nW; w++) idf[w] = df[w] ? Math.log(N / df[w]) : 0;
  // inverted: CSR arrays
  const start = new Uint32Array(nW + 1);
  for (let w = 0; w < nW; w++) start[w + 1] = start[w] + df[w];
  const tgt = new Uint16Array(start[nW]);
  const wgt = new Float32Array(start[nW]);
  const fill = start.slice(0, nW);
  bags.forEach((bag, t) => {
    let norm = 0;
    for (const [w, c] of bag) norm += c * idf[w];
    for (const [w, c] of bag) {
      const i = fill[w]++;
      tgt[i] = t; wgt[i] = norm ? (c * idf[w]) / norm : 0;
    }
  });
  Object.assign(index, { idf, start, tgt, wgt, N });
  return index;
}

/**
 * Score a query bag (Map word -> count, possibly accumulated over frames).
 * Returns Float32Array[N] of similarities in [0, 1] (L1 tf-idf overlap).
 */
export function scoreBag(index, qbag) {
  const { idf, start, tgt, wgt, N } = index;
  let norm = 0;
  for (const [w, c] of qbag) norm += c * idf[w];
  const scores = new Float32Array(N);
  if (!norm) return scores;
  for (const [w, c] of qbag) {
    const q = (c * idf[w]) / norm;
    if (!q) continue;
    for (let i = start[w]; i < start[w + 1]; i++) {
      const d = wgt[i];
      scores[tgt[i]] += q < d ? q : d;
    }
  }
  return scores;
}

export function topK(scores, k) {
  const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
  return order.slice(0, k).map((i) => ({ index: i, score: scores[i] }));
}

// ---------- serialization ----------
// Layout: [u32 headerLen][header JSON][pad to 4][treeMax centers][treeMin centers]
//         [u32 targetCount] then per target: [u32 nWords][u32 words...][u8 counts... pad4]
export function serializeIndex(index, bags, ids) {
  const shared = index.treeMin === index.treeMax;
  const header = JSON.stringify({ v: 1, K: index.treeMax.K, L: index.treeMax.L, V: index.V, shared, ids });
  const hb = new TextEncoder().encode(header);
  const hpad = (4 - ((4 + hb.length) % 4)) % 4;
  const parts = [];
  const u32 = (n) => new Uint8Array(Uint32Array.of(n).buffer);
  parts.push(u32(hb.length), hb, new Uint8Array(hpad));
  parts.push(new Uint8Array(index.treeMax.centers.buffer.slice(0)));
  if (!shared) parts.push(new Uint8Array(index.treeMin.centers.buffer.slice(0)));
  parts.push(u32(bags.length));
  for (const bag of bags) {
    const words = [...bag.keys()].sort((a, b) => a - b);
    const counts = new Uint8Array(words.length + ((4 - (words.length % 4)) % 4));
    words.forEach((w, i) => { counts[i] = Math.min(255, bag.get(w)); });
    parts.push(u32(words.length), new Uint8Array(Uint32Array.from(words).buffer), counts);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function deserializeIndex(buffer) {
  const buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const dv = new DataView(buf);
  let o = 0;
  const hl = dv.getUint32(o, true); o += 4;
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o, hl))); o += hl;
  o += (4 - (o % 4)) % 4;
  const { K, L, V, ids, shared } = header;
  const nNodes = (K ** (L + 1) - K) / (K - 1);
  const treeMax = { K, L, centers: new Uint32Array(buf, o, nNodes * DESC_WORDS) }; o += nNodes * DESC_WORDS * 4;
  let treeMin = treeMax;
  if (!shared) { treeMin = { K, L, centers: new Uint32Array(buf, o, nNodes * DESC_WORDS) }; o += nNodes * DESC_WORDS * 4; }
  const n = dv.getUint32(o, true); o += 4;
  const bags = [];
  for (let t = 0; t < n; t++) {
    const nw = dv.getUint32(o, true); o += 4;
    const words = new Uint32Array(buf, o, nw); o += nw * 4;
    const counts = new Uint8Array(buf, o, nw); o += nw + ((4 - (nw % 4)) % 4);
    const bag = new Map();
    for (let i = 0; i < nw; i++) bag.set(words[i], counts[i]);
    bags.push(bag);
  }
  const index = { treeMax, treeMin, V, ids };
  return finalizeIndex(index, bags);
}
