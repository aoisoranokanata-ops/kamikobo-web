'use strict';
/* 手書きの線（ベクター）: 形を作る・描く・当たり判定・消しゴム（線ごと／部分）・変形。
   線 = {id, tool:'pen'|'hl', pen:'ball'|'fountain'|'brush', color, w(太さ pt), op(不透明度), t0(書き始めの時刻 ms),
         pts: Float32Array [x, y, 筆圧, 書き始めからの ms, ...]}
   表示用のキャッシュ（保存しない）: _path(Path2D), _bb([x0,y0,x1,y1])。 */

const PEN_KINDS = {
  ball: { label: 'ボールペン', min: 0.85 },
  fountain: { label: '万年筆', min: 0.42 },
  brush: { label: '筆ペン', min: 0.12 },
};

function newStroke(tool, pen, color, w, op) {
  return { id: uid('s'), tool, pen, color, w, op: op == null ? 1 : op, t0: Date.now(), pts: new Float32Array(0) };
}

function strokeBBox(s) {
  if (s._bb) return s._bb;
  const p = s.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const m = s.w;
  s._bb = [x0 - m, y0 - m, x1 + m, y1 + m];
  return s._bb;
}

function bbHits(bb, x0, y0, x1, y1) { return !(bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1); }

/* 筆圧 → 半径 */
function strokeRadius(s, p, i, n) {
  const k = PEN_KINDS[s.pen] || PEN_KINDS.ball;
  let f = k.min + (1 - k.min) * Math.pow(clamp(p, 0, 1), 0.85);
  if (s.pen === 'brush') {                       // 入り・抜きを細く
    const taper = Math.min(1, (i + 1) / 6, (n - i) / 6);
    f *= 0.35 + 0.65 * taper;
  }
  return (s.w / 2) * f;
}

/* 点が粗い所を Catmull-Rom で埋める（曲線をなめらかに）。戻り値 [x,y,r,...] */
function densify(s) {
  const p = s.pts, n = p.length / 4;
  const out = [];
  const R = (i) => strokeRadius(s, p[i * 4 + 2], i, n);
  for (let i = 0; i < n; i++) {
    const x = p[i * 4], y = p[i * 4 + 1], r = R(i);
    out.push(x, y, r);
    if (i === n - 1) break;
    const x2 = p[(i + 1) * 4], y2 = p[(i + 1) * 4 + 1], r2 = R(i + 1);
    const d = Math.hypot(x2 - x, y2 - y), step = Math.max(0.35, Math.min(r, r2) * 0.6);
    if (d <= step) continue;
    const i0 = Math.max(0, i - 1), i3 = Math.min(n - 1, i + 2);
    const x0 = p[i0 * 4], y0 = p[i0 * 4 + 1], x3 = p[i3 * 4], y3 = p[i3 * 4 + 1];
    const m = Math.min(40, Math.floor(d / step));
    for (let k = 1; k < m; k++) {
      const t = k / m, t2 = t * t, t3 = t2 * t;
      const cx = 0.5 * (2 * x + (-x0 + x2) * t + (2 * x0 - 5 * x + 4 * x2 - x3) * t2 + (-x0 + 3 * x - 3 * x2 + x3) * t3);
      const cy = 0.5 * (2 * y + (-y0 + y2) * t + (2 * y0 - 5 * y + 4 * y2 - y3) * t2 + (-y0 + 3 * y - 3 * y2 + y3) * t3);
      out.push(cx, cy, r + (r2 - r) * t);
    }
  }
  return out;
}

/* 線の形（Path2D）。ボールペン・蛍光ペンは「なぞる線」、万年筆・筆ペンは「塗る形」（_fill = true） */
function strokePath(s) {
  if (s._path) return s._path;
  const p = s.pts, n = p.length / 4;
  const path = new Path2D();
  if (n === 0) { s._path = path; return path; }
  if (s.tool === 'hl' || s.pen === 'ball') {
    s._fill = false;
    path.moveTo(p[0], p[1]);
    if (n === 1) path.lineTo(p[0] + 0.01, p[1]);
    else if (n === 2) path.lineTo(p[4], p[5]);
    else {
      for (let i = 1; i < n - 1; i++) {
        const mx = (p[i * 4] + p[(i + 1) * 4]) / 2, my = (p[i * 4 + 1] + p[(i + 1) * 4 + 1]) / 2;
        path.quadraticCurveTo(p[i * 4], p[i * 4 + 1], mx, my);
      }
      path.lineTo(p[(n - 1) * 4], p[(n - 1) * 4 + 1]);
    }
  } else {
    s._fill = true;
    const d = densify(s);
    const m = d.length / 3;
    for (let i = 0; i < m; i++) {
      const x = d[i * 3], y = d[i * 3 + 1], r = Math.max(0.15, d[i * 3 + 2]);
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
      if (i === m - 1) break;
      const x2 = d[(i + 1) * 3], y2 = d[(i + 1) * 3 + 1], r2 = Math.max(0.15, d[(i + 1) * 3 + 2]);
      const L = Math.hypot(x2 - x, y2 - y);
      if (L < 1e-3) continue;
      // 2 つの円をつなぐ接線の台形（半径の差が小さい前提の近似）
      const ux = (x2 - x) / L, uy = (y2 - y) / L, nx = -uy, ny = ux;
      path.moveTo(x + nx * r, y + ny * r);
      path.lineTo(x2 + nx * r2, y2 + ny * r2);
      path.lineTo(x2 - nx * r2, y2 - ny * r2);
      path.lineTo(x - nx * r, y - ny * r);
      path.closePath();
    }
  }
  s._path = path;
  return path;
}

function invalidate(s) { s._path = null; s._bb = null; }

/* 線を描く（g はページの座標）。sel = 選ばれている線の id の Set（薄く強調） */
function drawStroke(g, s, opt = {}) {
  const path = strokePath(s);
  g.save();
  if (s.tool === 'hl') {
    g.globalAlpha = (s.op == null ? 0.35 : s.op) * (opt.alpha || 1);
    g.globalCompositeOperation = opt.noMultiply ? 'source-over' : 'multiply';
    g.strokeStyle = s.color;
    g.lineWidth = Math.max(s.w, opt.minW || 0);
    g.lineCap = 'butt';
    g.lineJoin = 'round';
    g.stroke(path);
  } else {
    g.globalAlpha = (s.op == null ? 1 : s.op) * (opt.alpha || 1);
    if (s._fill) {
      g.fillStyle = s.color; g.fill(path, 'nonzero');
      // 縮めて表示したとき細い線が消えないよう、輪郭もなぞる
      if (opt.minW && s.w * 0.6 < opt.minW) { g.strokeStyle = s.color; g.lineWidth = opt.minW * 0.6; g.stroke(path); }
    } else {
      g.strokeStyle = s.color;
      g.lineWidth = Math.max(s.w, opt.minW || 0);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke(path);
    }
  }
  g.restore();
}

/* 蛍光ペンを先に、ペンを後に（蛍光ペンが字の下になる） */
function drawStrokes(g, strokes, clip, opt) {
  for (const pass of ['hl', 'pen']) {
    for (const s of strokes) {
      if (s.tool !== pass) continue;
      if (clip && !bbHits(strokeBBox(s), clip[0], clip[1], clip[2], clip[3])) continue;
      drawStroke(g, s, opt);
    }
  }
}

// ---- 当たり判定・消しゴム
function strokeHit(s, x, y, r) {
  const bb = strokeBBox(s);
  if (!bbHits(bb, x - r, y - r, x + r, y + r)) return false;
  const p = s.pts, n = p.length / 4, rr = r + s.w / 2;
  if (n === 1) return Math.hypot(p[0] - x, p[1] - y) <= rr;
  for (let i = 0; i < n - 1; i++) if (distToSeg(x, y, p[i * 4], p[i * 4 + 1], p[i * 4 + 4], p[i * 4 + 5]) <= rr) return true;
  return false;
}

/* 部分消し: (x,y) から r 以内の点を抜いて線を分ける。触れていなければ null、全部消えたら []。 */
function strokeEraseAt(s, x, y, r) {
  if (!strokeHit(s, x, y, r)) return null;
  const p = s.pts, n = p.length / 4, rr = r + s.w * 0.3;
  const pieces = [];
  let cur = [];
  for (let i = 0; i < n; i++) {
    const inside = Math.hypot(p[i * 4] - x, p[i * 4 + 1] - y) <= rr;
    if (inside) { if (cur.length >= 8) pieces.push(cur); cur = []; continue; }
    // 消しゴムの円をまたぐ線分は、円の手前で切る
    if (cur.length && i > 0 && distToSeg(x, y, p[i * 4 - 4], p[i * 4 - 3], p[i * 4], p[i * 4 + 1]) <= rr) {
      if (cur.length >= 8) pieces.push(cur);
      cur = [];
    }
    cur.push(p[i * 4], p[i * 4 + 1], p[i * 4 + 2], p[i * 4 + 3]);
  }
  if (cur.length >= 8) pieces.push(cur);
  if (pieces.length === 1 && pieces[0].length === p.length) return null;
  return pieces.map((arr) => ({ ...strokeRecord(s), id: uid('s'), t0: s.t0, pts: new Float32Array(arr) }));
}

/* 変形（m = {a,b,c,d,e,f}）。太さは面積の比の平方根で */
function strokeTransformed(s, m, keepId = false) {
  const p = s.pts, q = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 4) {
    q[i] = m.a * p[i] + m.c * p[i + 1] + m.e;
    q[i + 1] = m.b * p[i] + m.d * p[i + 1] + m.f;
    q[i + 2] = p[i + 2];
    q[i + 3] = p[i + 3];
  }
  const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  return { ...strokeRecord(s), id: keepId ? s.id : uid('s'), t0: s.t0, w: s.w * k, pts: q };
}

function strokeInPoly(s, poly) {
  const p = s.pts, n = p.length / 4;
  let inside = 0;
  const step = Math.max(1, Math.floor(n / 24));
  let tested = 0;
  for (let i = 0; i < n; i += step) { tested++; if (pointInPoly(p[i * 4], p[i * 4 + 1], poly)) inside++; }
  return tested > 0 && inside / tested >= 0.5;
}

function unionBBox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const b = strokeBBox(s);
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  return [x0, y0, x1, y1];
}

/* 点を足す（描いている途中）。倍々に伸びる入れ物を使い、pts はその先頭の見え方（subarray）。
   書き終わったら strokeFinish で切り詰める（subarray のまま保存すると入れ物全体が保存される）。 */
function strokeAppend(s, x, y, p, t) {
  const n = s.pts.length;
  if (!s._cap || s._cap.length < n + 4) {
    const cap = new Float32Array(Math.max(256, (n + 4) * 2));
    cap.set(s.pts);
    s._cap = cap;
  }
  s._cap[n] = x; s._cap[n + 1] = y; s._cap[n + 2] = p; s._cap[n + 3] = t;
  s.pts = s._cap.subarray(0, n + 4);
  invalidate(s);
}
function strokeFinish(s) {
  s.pts = s.pts.slice();
  s._cap = null;
  invalidate(s);
}
