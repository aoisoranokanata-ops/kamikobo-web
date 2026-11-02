'use strict';
/* 書類のスキャン: カメラで撮る（iPad は input の capture でカメラが開く・写真からも選べる）→ 紙の四隅を合わせる
   （自動で見つけて、指でずらせる。ずらす間は拡大鏡）→ まっすぐに（射影変換）→ くっきり（背景＝紙の色・影を割って取る）。
   何枚でも続けて撮り、最後に [{blob, w, h}] を返す（ノートにするのは呼んだ側）。ライブラリは使わない。
   自動の四隅: 小さくした写真を大津の方法で明るい所と暗い所に分け、明るい所のいちばん大きなかたまりの x+y・x−y が最も大きい・小さい点。
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
  const lab = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  let bestId = -1, bestSize = 0;
  for (let s = 0, id = 0; s < n; s++) {
    if (gray[s] <= th || lab[s] !== -1) continue;
    let top = 0, size = 0;
    stack[top++] = s; lab[s] = id;
    while (top) {
      const p = stack[--top], x = p % w;
      size++;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || lab[q] !== -1 || gray[q] <= th) continue;
        lab[q] = id; stack[top++] = q;
      }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestSize < n * 0.12) return null;
  let tl, tr, br, bl, a1 = Infinity, a2 = -Infinity, b1 = -Infinity, b2 = Infinity;
  for (let p = 0; p < n; p++) {
    if (lab[p] !== bestId) continue;
    const x = p % w, y = (p / w) | 0, s1 = x + y, s2 = x - y;
    if (s1 < a1) { a1 = s1; tl = [x, y]; }
    if (s1 > a2) { a2 = s1; br = [x, y]; }
    if (s2 > b1) { b1 = s2; tr = [x, y]; }
    if (s2 < b2) { b2 = s2; bl = [x, y]; }
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [Math.min(c.width, (x + 0.5) / k), Math.min(c.height, (y + 0.5) / k)]);
  const area = quadArea(q), all = c.width * c.height;
  return area < all * 0.12 || area > all * 0.97 ? null : q;      // 小さすぎ・ほぼ全体（背景と見分けられない）
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
   斜めから撮ると縦横の比は正しく測れないので、snap なら A4・B5（1:√2）に近い時（15% 以内）はその比にそろえる */
function scanWarp(c, q, snap = false) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  if (snap) {
    const long = Math.max(W, H), short = Math.min(W, H);
    if (Math.abs(long / short / Math.SQRT2 - 1) < 0.15) { if (H >= W) H = W * Math.SQRT2; else W = H * Math.SQRT2; }
  }
  const k = Math.min(1, SCAN_MAX / Math.max(W, H));
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

// ================= 画面
const Scanner = {
  /* 撮ったページ [{blob, w, h}] を返す（やめたら []） */
  open(title = '書類をスキャン') {
    return new Promise((resolve) => {
      const conf = loadJSON('scan', { mode: 'doc', snap: true });
      const S = { pages: [], cur: null, quad: null, mode: conf.mode, snap: conf.snap, queue: [], drag: -1, busy: false };
      const head = el('div', { class: 'scan-head' }, el('b', {}, title));
      const count = el('span', { class: 'muted' });
      const done = el('button', { class: 'primary' });
      head.append(count, el('span', { class: 'scan-sp' }), el('button', { onclick: () => quit() }, 'やめる'), done);
      const main = el('div', { class: 'scan-main' });
      const cv = el('canvas', { class: 'scan-cv' });
      const hint = el('div', { class: 'scan-empty' },
        el('button', { class: 'primary scan-big', onclick: () => take(true) }, '📷 カメラで撮る'),
        el('button', { class: 'scan-big', onclick: () => take(false) }, '🖼 写真から選ぶ'),
        el('p', { class: 'muted small' }, '書類を暗めの机などに置いて、真上から撮ると四隅を自動で合わせやすくなります。撮った後に四隅を指で動かせます。'));
      const tools = el('div', { class: 'scan-tools' });
      const strip = el('div', { class: 'scan-strip' });
      const box = el('div', { class: 'scan' }, head, main, tools, strip);
      document.body.append(box);

      const close = (v) => { box.remove(); removeEventListener('resize', fit); resolve(v); };
      const quit = async () => {
        if (S.pages.length && !await confirmBox('スキャンをやめる', `撮った ${S.pages.length} 枚を捨てます。`, '捨てる', true)) return;
        close([]);
      };
      done.addEventListener('click', () => { if (S.pages.length) { saveJSON('scan', { mode: S.mode, snap: S.snap }); close(S.pages.map(({ blob, w, h }) => ({ blob, w, h }))); } });

      // ---- 写真を出す・四隅を描く
      let view = null;           // {k, ox, oy}: 写真の px → canvas の CSS px
      const fit = () => {
        if (!S.cur) return;
        const r = main.getBoundingClientRect(), dpr = devicePixelRatio || 1, pad = 24;
        const k = Math.min((r.width - pad * 2) / S.cur.width, (r.height - pad * 2) / S.cur.height);
        cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
        cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
        view = { k, ox: (r.width - S.cur.width * k) / 2, oy: (r.height - S.cur.height * k) / 2, dpr, w: r.width, h: r.height };
        draw();
      };
      const toScr = (p) => [view.ox + p[0] * view.k, view.oy + p[1] * view.k];
      const draw = () => {
        if (!S.cur || !view) return;
        const g = cv.getContext('2d'), { dpr, k, ox, oy } = view;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, view.w, view.h);
        g.drawImage(S.cur, ox, oy, S.cur.width * k, S.cur.height * k);
        const q = S.quad.map(toScr);
        g.beginPath();
        g.rect(ox, oy, S.cur.width * k, S.cur.height * k);
        g.moveTo(q[0][0], q[0][1]); for (let i = 3; i >= 0; i--) g.lineTo(q[i][0], q[i][1]);
        g.fillStyle = 'rgba(0,0,0,.5)'; g.fill('evenodd');
        g.beginPath(); g.moveTo(q[0][0], q[0][1]); for (const p of q) g.lineTo(p[0], p[1]); g.closePath();
        g.strokeStyle = '#4f86e8'; g.lineWidth = 2.5; g.stroke();
        for (const [i, p] of q.entries()) {
          g.beginPath(); g.arc(p[0], p[1], S.drag === i ? 16 : 13, 0, Math.PI * 2);
          g.fillStyle = 'rgba(79,134,232,.35)'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
        }
        if (S.drag >= 0) {           // 拡大鏡（指で隠れる角の辺りを 3 倍で）
          const p = S.quad[S.drag], R = 64, Z = 3, cx = q[S.drag][0] < view.w / 2 ? view.w - R - 16 : R + 16, cy = R + 16;
          g.save();
          g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
          g.fillStyle = '#000'; g.fillRect(cx - R, cy - R, R * 2, R * 2);
          const s = R / (k * Z);
          g.drawImage(S.cur, p[0] - s, p[1] - s, s * 2, s * 2, cx - R, cy - R, R * 2, R * 2);
          g.strokeStyle = '#4f86e8'; g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(cx - 12, cy); g.lineTo(cx + 12, cy); g.moveTo(cx, cy - 12); g.lineTo(cx, cy + 12); g.stroke();
          g.restore();
          g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke();
        }
      };
      cv.addEventListener('pointerdown', (e) => {
        if (!view) return;
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        let bi = -1, bd = 44;
        S.quad.forEach((p, i) => { const [sx, sy] = toScr(p), d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; bi = i; } });
        if (bi < 0) return;
        e.preventDefault();
        S.drag = bi;
        try { cv.setPointerCapture(e.pointerId); } catch { /* */ }
        draw();
      });
      cv.addEventListener('pointermove', (e) => {
        if (S.drag < 0) return;
        const r = cv.getBoundingClientRect();
        S.quad[S.drag] = [clamp((e.clientX - r.left - view.ox) / view.k, 0, S.cur.width), clamp((e.clientY - r.top - view.oy) / view.k, 0, S.cur.height)];
        draw();
      });
      const end = () => { if (S.drag >= 0) { S.drag = -1; draw(); } };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      addEventListener('resize', fit);

      // ---- 道具・一覧
      const render = () => {
        count.textContent = S.pages.length ? `${S.pages.length} 枚` : '';
        done.textContent = `完了（${S.pages.length} 枚）`;
        done.disabled = !S.pages.length || S.busy;
        main.innerHTML = '';
        tools.innerHTML = '';
        if (!S.cur) {
          main.append(hint);
          hint.querySelector('.scan-big').textContent = S.pages.length ? '📷 次のページを撮る' : '📷 カメラで撮る';
        } else {
          main.append(cv);
          const chips = el('div', { class: 'scan-modes' }, ...SCAN_MODES.map(([k, label]) =>
            el('button', { class: 'chip' + (S.mode === k ? ' on' : ''), onclick: () => { S.mode = k; render(); } }, label)));
          tools.append(chips,
            el('button', { class: 'chip' + (S.snap ? ' on' : ''), title: '斜めから撮っても A4・B5 の縦横の比にそろえる（ほかの形の時はそのまま）', onclick: () => { S.snap = !S.snap; render(); } }, 'A4・B5 の形に合わせる'),
            el('button', { class: 'small', title: '右へ回す', onclick: () => { S.cur = scanRotate(S.cur); S.quad = scanDetect(S.cur) || defaultQuad(S.cur); fit(); } }, '↻ 回転'),
            el('button', { class: 'small', onclick: () => { S.quad = scanDetect(S.cur) || defaultQuad(S.cur); draw(); } }, '四隅: 自動'),
            el('button', { class: 'small', onclick: () => { S.quad = [[0, 0], [S.cur.width, 0], [S.cur.width, S.cur.height], [0, S.cur.height]]; draw(); } }, '写真全体'),
            el('span', { class: 'scan-sp' }),
            el('button', { onclick: () => { S.cur = null; next(); } }, S.queue.length ? 'この写真は使わない' : '撮り直す'),
            el('button', { class: 'primary', disabled: S.busy, onclick: () => use() }, S.busy ? 'まっすぐにしています…' : '✓ このページを入れる'));
          requestAnimationFrame(fit);
        }
        strip.innerHTML = '';
        S.pages.forEach((p, i) => strip.append(el('div', { class: 'scan-thumb' }, el('img', { src: p.thumb, alt: '' }), el('span', {}, String(i + 1)),
          el('button', { class: 'scan-del', title: '外す', onclick: () => { S.pages.splice(i, 1); render(); } }, '×'))));
        strip.hidden = !S.pages.length;
      };
      const load = async (file) => {
        try {
          S.cur = await scanLoad(file);
          S.quad = scanDetect(S.cur) || defaultQuad(S.cur);
        } catch (e) { toast(`${file.name || '写真'}: ${e.message || e}`, { error: true }); S.cur = null; }
        render();
      };
      const next = () => { const f = S.queue.shift(); if (f) load(f); else render(); };
      const take = async (camera) => {
        const files = await pickPhotos(camera);
        if (!files.length) return;
        S.queue.push(...files);
        next();
      };
      const use = async () => {
        if (S.busy) return;
        S.busy = true; render();
        await new Promise((r) => setTimeout(r, 30));          // 「まっすぐにしています」を先に出す
        try {
          const out = scanEnhance(scanWarp(S.cur, S.quad, S.snap), S.mode);
          const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.88));
          const t = document.createElement('canvas'), tk = 120 / Math.max(out.width, out.height);
          t.width = Math.round(out.width * tk); t.height = Math.round(out.height * tk);
          t.getContext('2d').drawImage(out, 0, 0, t.width, t.height);
          S.pages.push({ blob, w: out.width, h: out.height, thumb: t.toDataURL('image/jpeg', 0.8) });
          S.cur = null;
          toast(`${S.pages.length} 枚目を入れました`);
        } catch (e) { toast('まっすぐにできませんでした: ' + (e.message || e), { error: true }); }
        S.busy = false;
        next();
      };
      render();
    });
  },
};
