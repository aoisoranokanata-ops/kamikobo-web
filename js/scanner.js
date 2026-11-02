'use strict';
/* 書類のスキャン: カメラで撮る（iPad は input の capture でカメラが開く・写真からも選べる）→ 紙の四隅を合わせる
   （自動で見つけて、指でずらせる。ずらす間は拡大鏡）→ 仕上げ（下の scanProcess の順。小さく作った下見を見ながら選ぶ）→ 入れる。
   何枚でも続けて撮り、最後に [{blob, w, h}] を返す（ノート・PDF にするのは呼んだ側）。写真をまとめて選ぶと全部おまかせで仕上げる。
   ライブラリは使わない。
   自動の四隅: 小さくした写真を大津の方法で明るい所と暗い所に分け、明るい所のいちばん大きなかたまりの x+y・x−y が最も大きい・小さい点。
   本の見開きはとじ目の影で紙が 2 つに分かれるので、同じくらいの大きさで横（縦）に並ぶかたまりも一緒にする。
   紙と背景の明るさが近い（白い机など）時は見つからないので、少し内側の四角から始めて手で合わせてもらう。 */

const SCAN_MODES = [['doc', '文書（白黒）'], ['color', 'カラー'], ['gray', 'グレー'], ['none', 'そのまま']];
const SCAN_MAX = 2400;        // まっすぐにした後の長い辺（px）

/* 写真を撮る（camera）・選ぶ。押した時の中で呼ぶ */
function pickPhotos(camera) {
  return new Promise((res) => {
    const inp = el('input', { type: 'file', accept: 'image/*', capture: camera ? 'environment' : null, multiple: camera ? null : true,
      style: { position: 'fixed', left: '-1000px' } });
    let done = false;
    inp.addEventListener('change', () => { done = true; res([...inp.files]); inp.remove(); });
    window.addEventListener('focus', () => setTimeout(() => { if (!done && !inp.files.length) { res([]); inp.remove(); } }, 1500), { once: true });
    document.body.append(inp);
    inp.click();
  });
}

// ================= 絵の処理
async function scanLoad(file) {
  const im = await loadImageEl(file);
  const W0 = im.naturalWidth || im.width, H0 = im.naturalHeight || im.height, k = Math.min(1, 3000 / Math.max(W0, H0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W0 * k)); c.height = Math.max(1, Math.round(H0 * k));
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  return c;
}
function scanRotate(c) {           // 右へ 90°
  const r = document.createElement('canvas');
  r.width = c.height; r.height = c.width;
  const g = r.getContext('2d');
  g.translate(r.width, 0); g.rotate(Math.PI / 2); g.drawImage(c, 0, 0);
  return r;
}
function quadArea(q) { let s = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
function defaultQuad(c) { const mx = c.width * 0.04, my = c.height * 0.04; return [[mx, my], [c.width - mx, my], [c.width - mx, c.height - my], [mx, c.height - my]]; }

/* 紙の四隅 [左上, 右上, 右下, 左下]（見つからなければ null） */
function scanDetect(c) {
  const k = 320 / Math.max(c.width, c.height), w = Math.max(2, Math.round(c.width * k)), h = Math.max(2, Math.round(c.height * k));
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  const tg = t.getContext('2d', { willReadFrequently: true });
  tg.drawImage(c, 0, 0, w, h);
  const d = tg.getImageData(0, 0, w, h).data, n = w * h, gray = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; gray[i] = v; hist[v]++; }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, th = 128;
  for (let i = 0; i < 256; i++) {           // 大津の方法
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (v > best) { best = v; th = i; }
  }
  const lab = new Int32Array(n).fill(-1), stack = new Int32Array(n), comps = [];
  for (let s = 0, id = 0; s < n; s++) {
    if (gray[s] <= th || lab[s] !== -1) continue;
    let top = 0, size = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[top++] = s; lab[s] = id;
    while (top) {
      const p = stack[--top], x = p % w, y = (p / w) | 0;
      size++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || lab[q] !== -1 || gray[q] <= th) continue;
        lab[q] = id; stack[top++] = q;
      }
    }
    comps.push({ id, size, x0, y0, x1, y1 });
    id++;
  }
  if (!comps.length) return null;
  comps.sort((a, b) => b.size - a.size);
  const big = comps[0];
  if (big.size < n * 0.12 * 0.5) return null;
  // 本の見開き: とじ目の影で紙が左右（上下）2 つに分かれる → 同じくらいの大きさで、横（縦）に並ぶかたまりも入れる
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1, Math.min(a1 - a0, b1 - b0));
  const take = new Set([big.id]);
  for (const c2 of comps.slice(1, 4)) {
    if (c2.size < big.size * 0.35) break;
    if (ov(big.y0, big.y1, c2.y0, c2.y1) > 0.6 || ov(big.x0, big.x1, c2.x0, c2.x1) > 0.6) take.add(c2.id);
  }
  let area = 0;
  for (const c2 of comps) if (take.has(c2.id)) area += c2.size;
  if (area < n * 0.12) return null;
  let tl, tr, br, bl, a1 = Infinity, a2 = -Infinity, b1 = -Infinity, b2 = Infinity;
  for (let p = 0; p < n; p++) {
    if (!take.has(lab[p])) continue;
    const x = p % w, y = (p / w) | 0, s1 = x + y, s2 = x - y;
    if (s1 < a1) { a1 = s1; tl = [x, y]; }
    if (s1 > a2) { a2 = s1; br = [x, y]; }
    if (s2 > b1) { b1 = s2; tr = [x, y]; }
    if (s2 < b2) { b2 = s2; bl = [x, y]; }
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [Math.min(c.width, (x + 0.5) / k), Math.min(c.height, (y + 0.5) / k)]);
  const qa = quadArea(q), all = c.width * c.height;
  return qa < all * 0.12 || qa > all * 0.97 ? null : q;      // 小さすぎ・ほぼ全体（背景と見分けられない）
}

/* dst の点 → src の点 の射影変換（3×3 の行列、最後は 1） */
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [X, Y] = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  for (let c = 0; c < 8; c++) {              // ガウスの消去法（部分ピボット）
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(8);
  for (let r = 7; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < 8; k++) s -= A[r][k] * h[k]; h[r] = s / A[r][r]; }
  return h.concat([1]);
}
/* 四隅 q をまっすぐな長方形に（大きさは辺の長さから。長い辺は SCAN_MAX まで）。
   斜めから撮ると縦横の比は正しく測れないので、snap なら A4・B5（1:√2）に近い時（15% 以内）はその比にそろえる。max = 長い辺の上限 */
function scanWarp(c, q, snap = false, max = SCAN_MAX) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  if (snap) {
    const long = Math.max(W, H), short = Math.min(W, H);
    if (Math.abs(long / short / Math.SQRT2 - 1) < 0.15) { if (H >= W) H = W * Math.SQRT2; else W = H * Math.SQRT2; }
  }
  const k = Math.min(1, max / Math.max(W, H));
  W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  const m = homography(q, [[0, 0], [W, 0], [W, H], [0, H]]);
  const sw = c.width, sh = c.height, S = c.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const og = out.getContext('2d'), od = og.createImageData(W, H), O = od.data;
  for (let y = 0; y < H; y++) {
    const v = y + 0.5;
    for (let x = 0; x < W; x++) {
      const u = x + 0.5, z = m[6] * u + m[7] * v + 1;
      let sx = (m[0] * u + m[1] * v + m[2]) / z - 0.5, sy = (m[3] * u + m[4] * v + m[5]) / z - 0.5;
      sx = sx < 0 ? 0 : sx > sw - 1.001 ? sw - 1.001 : sx; sy = sy < 0 ? 0 : sy > sh - 1.001 ? sh - 1.001 : sy;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i0 = (y0 * sw + x0) * 4, i1 = i0 + sw * 4, o = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = S[i0 + ch] + (S[i0 + 4 + ch] - S[i0 + ch]) * fx, b = S[i1 + ch] + (S[i1 + 4 + ch] - S[i1 + ch]) * fx;
        O[o + ch] = a + (b - a) * fy;
      }
      O[o + 3] = 255;
    }
  }
  og.putImageData(od, 0, 0);
  return out;
}
/* くっきり: 紙の色・影（小さくして明るい所を広げ＝文字を消し、ならした物）で割って白くし、字を濃く */
function scanEnhance(c, mode) {
  if (mode === 'none') return c;
  const W = c.width, H = c.height, g = c.getContext('2d');
  const sw = Math.max(16, Math.round(W / 24)), sh = Math.max(16, Math.round(H / 24));
  const s = document.createElement('canvas');
  s.width = sw; s.height = sh;
  const sg = s.getContext('2d', { willReadFrequently: true });
  sg.drawImage(c, 0, 0, sw, sh);
  const sd = sg.getImageData(0, 0, sw, sh);
  const pass = (fn) => {
    const a = sd.data, src = a.slice();
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) for (let ch = 0; ch < 3; ch++) {
      let mx = 0, sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(sw - 1, Math.max(0, x + dx)), yy = Math.min(sh - 1, Math.max(0, y + dy)), v = src[(yy * sw + xx) * 4 + ch];
        if (v > mx) mx = v; sum += v; cnt++;
      }
      a[(y * sw + x) * 4 + ch] = fn === 'max' ? mx : sum / cnt;
    }
  };
  pass('max'); pass('max'); pass('max'); pass('avg');
  sg.putImageData(sd, 0, 0);
  const b = document.createElement('canvas');
  b.width = W; b.height = H;
  const bg = b.getContext('2d');
  bg.imageSmoothingQuality = 'high';
  bg.drawImage(s, 0, 0, W, H);
  const B = bg.getImageData(0, 0, W, H).data, img = g.getImageData(0, 0, W, H), D = img.data;
  const curve = (v, lo, hi, gam) => { const t = (v - lo) / (hi - lo); return t <= 0 ? 0 : t >= 1 ? 255 : 255 * Math.pow(t, gam); };
  for (let i = 0; i < D.length; i += 4) {
    if (mode === 'color') {
      for (let ch = 0; ch < 3; ch++) D[i + ch] = curve((D[i + ch] / Math.max(24, B[i + ch])) * 255, 22, 238, 1.25);
    } else {
      const v = (D[i] * 77 + D[i + 1] * 150 + D[i + 2] * 29) >> 8, bv = Math.max(24, (B[i] * 77 + B[i + 1] * 150 + B[i + 2] * 29) >> 8);
      const r = (v / bv) * 255, out = mode === 'doc' ? curve(r, 45, 228, 1.6) : curve(r, 18, 245, 1.15);
      D[i] = D[i + 1] = D[i + 2] = out;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ---- 仕上げの部品
function lum(d, i) { return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; }
function smallCopy(c, max) {
  const k = Math.min(1, max / Math.max(c.width, c.height)), t = document.createElement('canvas');
  t.width = Math.max(2, Math.round(c.width * k)); t.height = Math.max(2, Math.round(c.height * k));
  const g = t.getContext('2d', { willReadFrequently: true });
  g.drawImage(c, 0, 0, t.width, t.height);
  return { t, g, k, d: g.getImageData(0, 0, t.width, t.height).data };
}
/* 紙の色（明るい方の 3 割の平均） */
function paperTone(c) {
  const { d } = smallCopy(c, 200), hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[lum(d, i)]++;
  let n = 0, th = 255;
  const want = (d.length / 4) * 0.3;
  for (; th > 0 && n < want; th--) n += hist[th];
  let r = 0, g = 0, b = 0, m = 0;
  for (let i = 0; i < d.length; i += 4) if (lum(d, i) >= th) { r += d[i]; g += d[i + 1]; b += d[i + 2]; m++; }
  return m ? `rgb(${Math.round(r / m)},${Math.round(g / m)},${Math.round(b / m)})` : '#ffffff';
}
/* 傾き（度）: 暗い点（字）を角度ごとに横の帯へ投げ、帯の数の 2 乗の和が最も大きい角度（行がそろう向き） */
function scanDeskewAngle(c) {
  const { t, d } = smallCopy(c, 700), w = t.width, h = t.height, hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[lum(d, i)]++;
  let acc = 0, med = 0;
  for (; med < 255 && acc < (w * h) / 2; med++) acc += hist[med];
  const xs = [], ys = [], th = med * 0.62;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lum(d, (y * w + x) * 4) < th) { xs.push(x - w / 2); ys.push(y - h / 2); }
  if (xs.length < w * h * 0.003) return 0;               // 字がほとんど無い
  const step = Math.max(1, Math.floor(xs.length / 40000)), nb = Math.ceil((w + h) / 1.5) + 4, bins = new Float64Array(nb);
  const score = (deg) => {
    const a = (deg * Math.PI) / 180, sn = Math.sin(a), cs = Math.cos(a);
    bins.fill(0);
    for (let i = 0; i < xs.length; i += step) bins[Math.floor((ys[i] * cs - xs[i] * sn + (w + h) / 2) / 1.5)]++;
    let s = 0;
    for (let i = 0; i < nb; i++) s += bins[i] * bins[i];
    return s;
  };
  let best = 0, bs = score(0);
  const zero = bs;
  for (let a = -8; a <= 8.001; a += 0.25) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  for (let a = best - 0.25; a <= best + 0.25; a += 0.05) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  return bs > zero * 1.03 ? Math.round(best * 100) / 100 : 0;
}
/* deg 度だけ回す（時計回りが正）。空いた角は fill の色 */
function rotateBy(c, deg, fill) {
  if (Math.abs(deg) < 0.05) return c;
  const r = document.createElement('canvas');
  r.width = c.width; r.height = c.height;
  const g = r.getContext('2d');
  g.fillStyle = fill; g.fillRect(0, 0, r.width, r.height);
  g.translate(r.width / 2, r.height / 2); g.rotate((deg * Math.PI) / 180); g.drawImage(c, -c.width / 2, -c.height / 2);
  return r;
}
/* 写り込んだ指: 肌の色で、紙の縁に触れている指くらいの大きさのかたまり。少し太らせた形（小さい解像度）を返す */
function findFingers(c) {
  const { t, d } = smallCopy(c, 480), w = t.width, h = t.height, n = w * h, skin = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    skin[p] = cr >= 138 && cr <= 178 && cb >= 77 && cb <= 128 && y > 45 && y < 235 && r - g > 15 && r - b > 40 ? 1 : 0;
  }
  const lab = new Int32Array(n).fill(-1), stack = new Int32Array(n), keep = new Uint8Array(n), band = Math.max(2, Math.round(Math.max(w, h) * 0.03));
  let count = 0;
  for (let s = 0, id = 0; s < n; s++) {
    if (!skin[s] || lab[s] !== -1) continue;
    let top = 0, size = 0, edge = false;
    const list = [];
    stack[top++] = s; lab[s] = id;
    while (top) {
      const p = stack[--top], x = p % w, y = (p / w) | 0;
      size++; list.push(p);
      if (x < band || y < band || x >= w - band || y >= h - band) edge = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || lab[q] !== -1 || !skin[q]) continue;
        lab[q] = id; stack[top++] = q;
      }
    }
    if (edge && size >= n * 0.0008 && size <= n * 0.12) { count++; for (const p of list) keep[p] = 1; }
    id++;
  }
  if (!count) return { count: 0 };
  const rad = Math.max(2, Math.round(Math.max(w, h) * 0.012)), tmp = new Uint8Array(n), out = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = -rad; k <= rad && !v; k++) { const xx = x + k; if (xx >= 0 && xx < w && keep[y * w + xx]) v = 1; } tmp[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = -rad; k <= rad && !v; k++) { const yy = y + k; if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1; } out[y * w + x] = v; }
  return { count, mask: out, w, h };
}
/* 形の所を紙の色で塗る（縁は少しぼかす） */
function fillMask(c, F, color) {
  const m = document.createElement('canvas');
  m.width = F.w; m.height = F.h;
  const g = m.getContext('2d'), id = g.createImageData(F.w, F.h);
  g.fillStyle = color; g.fillRect(0, 0, 1, 1);
  const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
  for (let p = 0; p < F.mask.length; p++) if (F.mask[p]) { id.data[p * 4] = r; id.data[p * 4 + 1] = gg; id.data[p * 4 + 2] = b; id.data[p * 4 + 3] = 255; }
  g.putImageData(id, 0, 0);
  const cg = c.getContext('2d');
  cg.imageSmoothingQuality = 'high';
  cg.drawImage(m, 0, 0, c.width, c.height);
}
/* 本のとじ目の影: 縦の列ごとの紙の明るさ（明るい方 15% の所）で割って、列ごとの明るさをそろえる */
function bookFlatten(c) {
  const W = c.width, H = c.height, g = c.getContext('2d'), img = g.getImageData(0, 0, W, H), D = img.data;
  const prof = new Float32Array(W), hist = new Uint32Array(256), rows = Math.max(1, Math.floor(H / 300));
  for (let x = 0; x < W; x++) {
    hist.fill(0);
    let n = 0;
    for (let y = 0; y < H; y += rows) { hist[lum(D, (y * W + x) * 4)]++; n++; }
    let acc = 0, v = 255;
    for (; v > 0 && acc < n * 0.15; v--) acc += hist[v];
    prof[x] = Math.max(20, v);
  }
  const rad = Math.max(2, Math.round(W / 80)), sm = new Float32Array(W);
  let top = 0;
  for (let x = 0; x < W; x++) { let s = 0, k = 0; for (let j = Math.max(0, x - rad); j <= Math.min(W - 1, x + rad); j++) { s += prof[j]; k++; } sm[x] = s / k; if (sm[x] > top) top = sm[x]; }
  for (let x = 0; x < W; x++) {
    const f = Math.min(4, top / sm[x]);
    if (f < 1.01) continue;
    for (let y = 0; y < H; y++) { const i = (y * W + x) * 4; D[i] = Math.min(255, D[i] * f); D[i + 1] = Math.min(255, D[i + 1] * f); D[i + 2] = Math.min(255, D[i + 2] * f); }
  }
  g.putImageData(img, 0, 0);
}
/* 縁に残った机など（紙より暗い帯）を切る割合 {l, t, r, b}（それぞれ 8% まで） */
function autoTrim(c) {
  const { t, d } = smallCopy(c, 400), w = t.width, h = t.height;
  const col = new Float32Array(w), row = new Float32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = lum(d, (y * w + x) * 4); col[x] += v / h; row[y] += v / w; }
  const mid = [...col.slice(Math.floor(w * 0.3), Math.ceil(w * 0.7))].sort((a, b) => a - b)[Math.floor(w * 0.2)] || 200;
  const cut = (arr, from, dir, lim) => { let k = 0; while (k < lim && arr[from + dir * k] < mid * 0.62) k++; return k; };
  return { l: cut(col, 0, 1, w * 0.08) / w, r: cut(col, w - 1, -1, w * 0.08) / w, t: cut(row, 0, 1, h * 0.08) / h, b: cut(row, h - 1, -1, h * 0.08) / h };
}
function cropCanvas(c, cr) {
  if (!cr || (cr.l + cr.t + cr.r + cr.b) < 0.001) return c;
  const x = Math.round(c.width * cr.l), y = Math.round(c.height * cr.t), w = Math.max(8, Math.round(c.width * (1 - cr.l - cr.r))), h = Math.max(8, Math.round(c.height * (1 - cr.t - cr.b)));
  const o = document.createElement('canvas');
  o.width = w; o.height = h;
  o.getContext('2d').drawImage(c, x, y, w, h, 0, 0, w, h);
  return o;
}
/* 明るさ・コントラスト（-50〜50） */
function scanAdjust(c, bright, contrast) {
  if (!bright && !contrast) return c;
  const g = c.getContext('2d'), img = g.getImageData(0, 0, c.width, c.height), D = img.data, k = 1 + contrast / 60, add = bright * 1.6;
  for (let i = 0; i < D.length; i += 4) for (let ch = 0; ch < 3; ch++) D[i + ch] = (D[i + ch] - 128) * k + 128 + add;
  g.putImageData(img, 0, 0);
  return c;
}
/* 見開きのとじ目（38〜62% の間で、紙がいちばん暗い縦の列）の割合。列の明るさは明るい方 15% の所（字に引っぱられない） */
function gutterAt(c) {
  const { t, d } = smallCopy(c, 500), w = t.width, h = t.height, col = new Float32Array(w), hist = new Uint32Array(256);
  for (let x = 0; x < w; x++) {
    hist.fill(0);
    for (let y = 0; y < h; y++) hist[lum(d, (y * w + x) * 4)]++;
    let acc = 0, v = 255;
    for (; v > 0 && acc < h * 0.15; v--) acc += hist[v];
    col[x] = v;
  }
  let bx = Math.round(w / 2), bv = Infinity;
  for (let x = Math.floor(w * 0.38); x <= Math.ceil(w * 0.62); x++) {
    let s = 0;
    for (let j = -3; j <= 3; j++) s += col[Math.min(w - 1, Math.max(0, x + j))];
    if (s < bv) { bv = s; bx = x; }
  }
  return bx / w;
}
function splitAt(c, f) {
  const x = Math.round(c.width * f);
  return [[0, x], [x, c.width]].map(([a, b]) => { const o = document.createElement('canvas'); o.width = b - a; o.height = c.height; o.getContext('2d').drawImage(c, a, 0, b - a, c.height, 0, 0, b - a, c.height); return o; });
}
/* 仕上げ: まっすぐ → 傾き → トリミング → 指 →（とじ目を探す）→ 本の影 → くっきり → 明るさ → 見開きを分ける。
   トリミングを先にするのは、縁に残った机を「本の影」として明るくしないため。とじ目は影を消す前に探す。
   o = {mode, snap, deskew, fingers, book, split, bright, contrast, tilt, crop}。cache に 1 枚ごとの自動の結果（傾き・トリミング・とじ目）を覚える
   （下見と仕上がりで同じにする）。noCrop = 下見（切る前の絵に枠を出す。raw = とじ目を探すための影を消す前の絵） */
function scanProcess(src, quad, o, max, cache, noCrop = false) {
  let c = scanWarp(src, quad, o.snap, max);
  if (o.deskew && cache.angle === undefined) cache.angle = scanDeskewAngle(c);
  const angle = (o.deskew ? cache.angle || 0 : 0) + (o.tilt || 0), tone = paperTone(c);
  if (cache.trim === undefined) {
    // 縁に残った机は回す前（まっすぐな帯のうち）に探す。回すと斜めになるので、机の残っていた辺だけ傾いた分も切る
    // （残っていない辺は、回して空いた角を紙の色で埋めるので切らなくてよい）
    const t = autoTrim(c), sn = Math.abs(Math.sin((angle * Math.PI) / 180)), ex = (c.height / 2) * sn / c.width, ey = (c.width / 2) * sn / c.height;
    cache.trim = { l: t.l ? t.l + ex : 0, r: t.r ? t.r + ex : 0, t: t.t ? t.t + ey : 0, b: t.b ? t.b + ey : 0 };
  }
  c = rotateBy(c, -angle, tone);
  if (!noCrop) c = cropCanvas(c, o.crop || cache.trim);
  let fingers = 0;
  if (o.fingers) { const F = findFingers(c); fingers = F.count; if (F.count) fillMask(c, F, tone); }
  let raw = null;
  if (o.split) {
    if (noCrop) { raw = document.createElement('canvas'); raw.width = c.width; raw.height = c.height; raw.getContext('2d').drawImage(c, 0, 0); }
    else if (cache.split === undefined) cache.split = gutterAt(c);
  }
  if (o.book) bookFlatten(c);
  c = scanEnhance(c, o.mode);
  scanAdjust(c, o.bright || 0, o.contrast || 0);
  if (noCrop) return { full: c, raw, fingers, angle };
  return { pages: o.split ? splitAt(c, cache.split) : [c], fingers, angle };
}

// ================= 画面
const SCAN_DEFAULTS = { mode: 'doc', snap: true, deskew: true, fingers: true, book: false, split: false, bright: 0, contrast: 0 };
const SCAN_PREVIEW = 1100;     // 仕上げの下見の長い辺（px）
const Scanner = {
  /* 撮ったページ [{blob, w, h}] を返す（やめたら []） */
  open(title = '書類をスキャン') {
    return new Promise((resolve) => {
      const o = loadJSON('scan', SCAN_DEFAULTS);
      // state: 'empty'（撮る前）| 'corners'（四隅）| 'review'（仕上げ）
      const S = { state: 'empty', pages: [], cur: null, quad: null, queue: [], drag: -1, busy: false, cache: {}, tilt: 0, crop: null, prev: null, msg: '' };
      const saveOpt = () => saveJSON('scan', { mode: o.mode, snap: o.snap, deskew: o.deskew, fingers: o.fingers, book: o.book, split: o.split, bright: o.bright, contrast: o.contrast });
      const head = el('div', { class: 'scan-head' }, el('b', {}, title));
      const count = el('span', { class: 'muted' });
      const done = el('button', { class: 'primary' });
      head.append(count, el('span', { class: 'scan-sp' }), el('button', { onclick: () => quit() }, 'やめる'), done);
      const main = el('div', { class: 'scan-main' });
      const cv = el('canvas', { class: 'scan-cv' });
      const hint = el('div', { class: 'scan-empty' });
      const tools = el('div', { class: 'scan-tools' });
      const strip = el('div', { class: 'scan-strip' });
      const box = el('div', { class: 'scan' }, head, main, tools, strip);
      document.body.append(box);

      const close = (v) => { box.remove(); removeEventListener('resize', fit); resolve(v); };
      const quit = async () => {
        if (S.pages.length && !await confirmBox('スキャンをやめる', `撮った ${S.pages.length} 枚を捨てます。`, '捨てる', true)) return;
        close([]);
      };
      done.addEventListener('click', () => { if (S.pages.length && !S.busy) { saveOpt(); close(S.pages.map(({ blob, w, h }) => ({ blob, w, h }))); } });

      // ---- 絵を出す（四隅: 写真と四隅の枠 ／ 仕上げ: 下見とトリミングの枠）
      let view = null;           // 出している絵の px → canvas の CSS px
      const shown = () => (S.state === 'review' ? S.prev && S.prev.full : S.cur);
      const fit = () => {
        const img = shown();
        if (!img) return;
        const r = main.getBoundingClientRect(), dpr = devicePixelRatio || 1, pad = 24;
        const k = Math.min((r.width - pad * 2) / img.width, (r.height - pad * 2) / img.height);
        cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
        cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
        view = { k, ox: (r.width - img.width * k) / 2, oy: (r.height - img.height * k) / 2, dpr, w: r.width, h: r.height, iw: img.width, ih: img.height };
        draw();
      };
      const toScr = (p) => [view.ox + p[0] * view.k, view.oy + p[1] * view.k];
      const cropPts = () => { const c = S.crop, W = view.iw, H = view.ih; return [[c.l * W, c.t * H], [(1 - c.r) * W, c.t * H], [(1 - c.r) * W, (1 - c.b) * H], [c.l * W, (1 - c.b) * H]]; };
      const draw = () => {
        const img = shown();
        if (!img || !view) return;
        const g = cv.getContext('2d'), { dpr, k, ox, oy } = view;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, view.w, view.h);
        g.drawImage(img, ox, oy, img.width * k, img.height * k);
        const pts = S.state === 'review' ? cropPts() : S.quad;
        const q = pts.map(toScr);
        g.beginPath();
        g.rect(ox, oy, img.width * k, img.height * k);
        g.moveTo(q[0][0], q[0][1]); for (let i = 3; i >= 0; i--) g.lineTo(q[i][0], q[i][1]);
        g.fillStyle = S.state === 'review' ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.5)'; g.fill('evenodd');
        g.beginPath(); g.moveTo(q[0][0], q[0][1]); for (const p of q) g.lineTo(p[0], p[1]); g.closePath();
        g.strokeStyle = '#4f86e8'; g.lineWidth = 2.5; g.stroke();
        if (S.state === 'review' && o.split && S.prev.split != null) {        // 見開きを分ける線
          const x = q[0][0] + (q[1][0] - q[0][0]) * S.prev.split;
          g.setLineDash([8, 6]); g.strokeStyle = '#ffd166'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(x, q[0][1]); g.lineTo(x, q[3][1]); g.stroke(); g.setLineDash([]);
        }
        for (const [i, p] of q.entries()) {
          g.beginPath(); g.arc(p[0], p[1], S.drag === i ? 16 : 13, 0, Math.PI * 2);
          g.fillStyle = 'rgba(79,134,232,.35)'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
        }
        if (S.drag >= 0) {           // 拡大鏡（指で隠れる角の辺りを 3 倍で）
          const p = pts[S.drag], R = 64, Z = 3, cx = q[S.drag][0] < view.w / 2 ? view.w - R - 16 : R + 16, cy = R + 16;
          g.save();
          g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
          g.fillStyle = '#000'; g.fillRect(cx - R, cy - R, R * 2, R * 2);
          const sz = R / (k * Z);
          g.drawImage(img, p[0] - sz, p[1] - sz, sz * 2, sz * 2, cx - R, cy - R, R * 2, R * 2);
          g.strokeStyle = '#4f86e8'; g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(cx - 12, cy); g.lineTo(cx + 12, cy); g.moveTo(cx, cy - 12); g.lineTo(cx, cy + 12); g.stroke();
          g.restore();
          g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke();
        }
      };
      cv.addEventListener('pointerdown', (e) => {
        if (!view || S.busy) return;
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const pts = S.state === 'review' ? cropPts() : S.quad;
        let bi = -1, bd = 44;
        pts.forEach((p, i) => { const [sx, sy] = toScr(p), d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; bi = i; } });
        if (bi < 0) return;
        e.preventDefault();
        S.drag = bi;
        try { cv.setPointerCapture(e.pointerId); } catch { /* */ }
        draw();
      });
      cv.addEventListener('pointermove', (e) => {
        if (S.drag < 0) return;
        const r = cv.getBoundingClientRect();
        const px = clamp((e.clientX - r.left - view.ox) / view.k, 0, view.iw), py = clamp((e.clientY - r.top - view.oy) / view.k, 0, view.ih);
        if (S.state === 'review') {          // トリミング: 角を動かす（向かいの辺は止まる。少なくとも 20% は残す）
          const c = S.crop, fx = px / view.iw, fy = py / view.ih;
          if (S.drag === 0 || S.drag === 3) c.l = clamp(fx, 0, 1 - c.r - 0.2); else c.r = clamp(1 - fx, 0, 1 - c.l - 0.2);
          if (S.drag === 0 || S.drag === 1) c.t = clamp(fy, 0, 1 - c.b - 0.2); else c.b = clamp(1 - fy, 0, 1 - c.t - 0.2);
          if (o.split && S.prev.raw) S.prev.split = gutterAt(cropCanvas(S.prev.raw, S.crop));
        } else S.quad[S.drag] = [px, py];
        draw();
      });
      const end = () => { if (S.drag >= 0) { S.drag = -1; draw(); } };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      addEventListener('resize', fit);

      // ---- 仕上げの下見（小さく作る。動かしている間はまとめて）
      const opts = () => ({ ...o, tilt: S.tilt, crop: S.crop });
      const preview = debounce(() => {
        if (S.state !== 'review') return;
        const r = scanProcess(S.cur, S.quad, opts(), SCAN_PREVIEW, S.cache, true);
        if (!S.crop) S.crop = { ...S.cache.trim };
        r.split = o.split && r.raw ? gutterAt(cropCanvas(r.raw, S.crop)) : null;
        S.prev = r;
        S.msg = [r.angle ? `傾き ${r.angle > 0 ? '+' : ''}${r.angle.toFixed(1)}° を直しました` : '', r.fingers ? `指を ${r.fingers} か所消しました` : ''].filter(Boolean).join('・');
        const m = tools.querySelector('.scan-msg');
        if (m) m.textContent = S.msg;
        fit();
      }, 120);

      // ---- 道具・一覧
      const chip = (label, on, fn, tip) => el('button', { class: 'chip' + (on ? ' on' : ''), title: tip || null, onclick: fn }, label);
      const slider = (label, key, min, max, step, fmt) => {
        const val = el('span', { class: 'scan-val' }, fmt(key === 'tilt' ? S.tilt : o[key]));
        const r = el('input', { type: 'range', min, max, step, value: key === 'tilt' ? S.tilt : o[key] });
        r.addEventListener('input', () => { const v = +r.value; if (key === 'tilt') S.tilt = v; else o[key] = v; val.textContent = fmt(v); preview(); });
        return el('label', { class: 'scan-slider' }, label, r, val);
      };
      const render = () => {
        count.textContent = S.pages.length ? `${S.pages.length} 枚` : '';
        done.textContent = `完了（${S.pages.length} 枚）`;
        done.disabled = !S.pages.length || S.busy;
        main.innerHTML = '';
        tools.innerHTML = '';
        tools.hidden = S.state === 'empty';
        if (S.state === 'empty') {
          hint.innerHTML = '';
          hint.append(
            el('button', { class: 'primary scan-big', disabled: S.busy, onclick: () => take(true) }, S.pages.length ? '📷 次のページを撮る' : '📷 カメラで撮る'),
            el('button', { class: 'scan-big', disabled: S.busy, onclick: () => take(false) }, '🖼 写真から選ぶ（1 枚ずつ直す）'),
            el('button', { class: 'scan-big', disabled: S.busy, onclick: () => batch() }, '⚡ 写真をまとめて自動で'),
            el('p', { class: 'muted small' }, S.msg || '書類を暗めの机などに置いて真上から撮ると、四隅が合いやすくなります。「まとめて自動で」は四隅・傾き・指・明るさを全部おまかせで仕上げます（今の仕上げの設定で）。'));
          main.append(hint);
        } else if (S.state === 'corners') {
          main.append(cv);
          tools.append(el('div', { class: 'scan-row' },
            el('span', { class: 'muted small' }, '① 四隅を紙の角に合わせる'),
            el('button', { class: 'small', title: '右へ回す', onclick: () => { S.cur = scanRotate(S.cur); S.quad = scanDetect(S.cur) || defaultQuad(S.cur); S.cache = {}; fit(); } }, '↻ 回転'),
            el('button', { class: 'small', onclick: () => { S.quad = scanDetect(S.cur) || defaultQuad(S.cur); draw(); } }, '四隅: 自動'),
            el('button', { class: 'small', onclick: () => { S.quad = [[0, 0], [S.cur.width, 0], [S.cur.width, S.cur.height], [0, S.cur.height]]; draw(); } }, '写真全体'),
            chip('A4・B5 の形に合わせる', o.snap, () => { o.snap = !o.snap; render(); }, '斜めから撮っても A4・B5 の縦横の比にそろえる（ほかの形の時はそのまま）'),
            el('span', { class: 'scan-sp' }),
            el('button', { onclick: () => { S.cur = null; S.state = 'empty'; next(); } }, S.queue.length ? 'この写真は使わない' : '撮り直す'),
            el('button', { class: 'primary', onclick: () => { S.state = 'review'; S.cache = {}; S.crop = null; S.tilt = 0; S.prev = null; render(); preview.flush(); } }, '② 仕上げへ →')));
          requestAnimationFrame(fit);
        } else {
          main.append(cv);
          const re = (fn) => () => { fn(); render(); preview(); };
          tools.append(
            el('div', { class: 'scan-row' }, el('span', { class: 'muted small' }, '② 仕上げ'),
              ...SCAN_MODES.map(([k, label]) => chip(label, o.mode === k, re(() => { o.mode = k; })))),
            el('div', { class: 'scan-row' },
              chip('傾きを自動で直す', o.deskew, re(() => { o.deskew = !o.deskew; })),
              chip('写り込んだ指を消す', o.fingers, re(() => { o.fingers = !o.fingers; })),
              chip('本のとじ目の影を消す', o.book, re(() => { o.book = !o.book; })),
              chip('見開きを 2 ページに', o.split, re(() => { o.split = !o.split; }), 'とじ目（真ん中のいちばん暗い所）で左右に分ける'),
              el('button', { class: 'small', onclick: () => { S.crop = { ...S.cache.trim }; draw(); } }, 'トリミング: 自動'),
              el('button', { class: 'small', onclick: () => { S.crop = { l: 0, t: 0, r: 0, b: 0 }; draw(); } }, '切らない')),
            el('div', { class: 'scan-row' },
              slider('明るさ', 'bright', -50, 50, 1, (v) => (v > 0 ? '+' : '') + v),
              slider('コントラスト', 'contrast', -50, 50, 1, (v) => (v > 0 ? '+' : '') + v),
              slider('傾きの手直し', 'tilt', -10, 10, 0.1, (v) => (v > 0 ? '+' : '') + (+v).toFixed(1) + '°')),
            el('div', { class: 'scan-row' }, el('span', { class: 'scan-msg muted small' }, S.msg), el('span', { class: 'scan-sp' }),
              el('button', { onclick: () => { S.state = 'corners'; render(); } }, '← 四隅へ'),
              el('button', { class: 'primary', disabled: S.busy, onclick: () => use() }, S.busy ? '仕上げています…' : '✓ このページを入れる')));
          requestAnimationFrame(fit);
        }
        strip.innerHTML = '';
        S.pages.forEach((p, i) => strip.append(el('div', { class: 'scan-thumb' }, el('img', { src: p.thumb, alt: '' }), el('span', {}, String(i + 1)),
          el('button', { class: 'scan-del', title: '外す', onclick: () => { S.pages.splice(i, 1); render(); } }, '×'))));
        strip.hidden = !S.pages.length;
      };
      /* 仕上がり（大きい方）の絵 → 入れる */
      const push = async (canvases) => {
        for (const out of canvases) {
          const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.88));
          const t = document.createElement('canvas'), tk = 120 / Math.max(out.width, out.height);
          t.width = Math.round(out.width * tk); t.height = Math.round(out.height * tk);
          t.getContext('2d').drawImage(out, 0, 0, t.width, t.height);
          S.pages.push({ blob, w: out.width, h: out.height, thumb: t.toDataURL('image/jpeg', 0.8) });
        }
      };
      const load = async (file) => {
        try {
          S.cur = await scanLoad(file);
          S.quad = scanDetect(S.cur) || defaultQuad(S.cur);
          S.state = 'corners';
        } catch (e) { toast(`${file.name || '写真'}: ${e.message || e}`, { error: true }); S.cur = null; S.state = 'empty'; }
        render();
      };
      const next = () => { const f = S.queue.shift(); if (f) load(f); else { S.state = 'empty'; render(); } };
      const take = async (camera) => {
        const files = await pickPhotos(camera);
        if (!files.length) return;
        S.queue.push(...files);
        next();
      };
      const use = async () => {
        if (S.busy) return;
        S.busy = true; render();
        await new Promise((r) => setTimeout(r, 30));          // 「仕上げています」を先に出す
        try {
          if (o.split && S.prev) S.cache.split = S.prev.split;        // 下見で見せた所で分ける
          const r = scanProcess(S.cur, S.quad, opts(), SCAN_MAX, S.cache);
          await push(r.pages);
          toast(r.pages.length > 1 ? `${r.pages.length} ページ（見開き）を入れました` : `${S.pages.length} 枚目を入れました`);
          S.cur = null; S.msg = '';
          saveOpt();
        } catch (e) { toast('仕上げられませんでした: ' + (e.message || e), { error: true }); }
        S.busy = false;
        next();
      };
      /* 写真をまとめて: 四隅（見つからなければ写真全体）・傾き・指・明るさ・トリミングを全部おまかせ */
      const batch = async () => {
        const files = await pickPhotos(false);
        if (!files.length) return;
        S.busy = true;
        let n = 0, fail = 0;
        for (const f of files) {
          S.msg = `${n + 1} / ${files.length} 枚目を仕上げています…`; render();
          await new Promise((r) => setTimeout(r, 20));
          try {
            const c = await scanLoad(f);
            const q = scanDetect(c) || [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]];
            await push(scanProcess(c, q, { ...o, tilt: 0, crop: null }, SCAN_MAX, {}).pages);
          } catch { fail++; }
          n++;
        }
        S.busy = false;
        S.msg = `${files.length - fail} 枚を仕上げました${fail ? `（${fail} 枚は読めませんでした）` : ''}。下の一覧で要らない物は × で外せます。`;
        saveOpt();
        render();
      };
      render();
    });
  },
};
