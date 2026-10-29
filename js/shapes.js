'use strict';
/* 図形の自動補正: 書いたままペンを止めると、線・円/楕円・三角・四角・多角形・矢印に整える。
   入力・出力はページの座標の点 [x, y, ...]。出力は描き直し用の点の並びと名前。 */

function rdp(pts, eps) {          // Ramer–Douglas–Peucker（点を間引いて角を残す）
  if (pts.length < 3) return pts.slice();
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i][0], pts[i][1], ax, ay, bx, by);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}
function pathLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
/* 角度を 0/45/90… に寄せる（tol ラジアン以内なら） */
function snapAngle(a, step = Math.PI / 4, tol = 0.07) { const s = Math.round(a / step) * step; return Math.abs(a - s) < tol ? s : a; }

/* 線分を点の並びに（細かく） */
function segPoints(list, closed) {
  const out = [];
  const n = list.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [x0, y0] = list[i], [x1, y1] = list[(i + 1) % n];
    const m = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
    out.push([x0, y0]);            // 角は 2 回入れる（なめらかにする描き方でも角が丸まらない）
    for (let k = 0; k < m; k++) out.push([x0 + ((x1 - x0) * k) / m, y0 + ((y1 - y0) * k) / m]);
  }
  out.push(closed ? list[0].slice() : list[n - 1].slice());
  return out;
}

function recognizeShape(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 4) pts.push([flat[i], flat[i + 1]]);
  if (pts.length < 4) return null;
  const L = pathLen(pts);
  if (L < 12) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
  const gap = Math.hypot(ex - sx, ey - sy);

  // ---- 直線
  const chord = gap;
  let dev = 0;
  for (const [x, y] of pts) dev = Math.max(dev, distToSeg(x, y, sx, sy, ex, ey));
  if (chord > 10 && dev < Math.max(2.5, chord * 0.07) && L < chord * 1.25) {
    const a = snapAngle(Math.atan2(ey - sy, ex - sx), Math.PI / 4, 0.06);
    const len = chord;
    return { name: '直線', pts: segPoints([[sx, sy], [sx + Math.cos(a) * len, sy + Math.sin(a) * len]], false) };
  }

  const closed = gap < Math.max(14, L * 0.16);
  if (!closed) {
    // ---- 矢印: 長い線＋先の折り返し（V 字）
    const simp = rdp(pts, diag * 0.06);
    if (simp.length >= 4 && simp.length <= 5) {
      const lens = [];
      for (let i = 1; i < simp.length; i++) lens.push(Math.hypot(simp[i][0] - simp[i - 1][0], simp[i][1] - simp[i - 1][1]));
      if (lens[0] > (lens[1] + lens[2]) * 1.3) {
        const tip = simp[1], tail = simp[0];
        const a = snapAngle(Math.atan2(tip[1] - tail[1], tip[0] - tail[0]), Math.PI / 4, 0.06);
        const len = lens[0], head = Math.min(len * 0.3, Math.max(lens[1], lens[2]) || len * 0.2);
        const T = [tail[0] + Math.cos(a) * len, tail[1] + Math.sin(a) * len];
        const w1 = [T[0] - Math.cos(a - 0.5) * head, T[1] - Math.sin(a - 0.5) * head];
        const w2 = [T[0] - Math.cos(a + 0.5) * head, T[1] - Math.sin(a + 0.5) * head];
        return { name: '矢印', pts: segPoints([tail, T, w1], false).concat(segPoints([w1, T, w2], false)) };
      }
    }
    return null;
  }
  if (diag < 14) return null;

  // ---- 多角形（角の数で）
  const body = pts.slice();
  const simp = rdp(body.concat([body[0]]), diag * 0.075);
  let corners = simp.slice(0, -1);
  // 始点が辺の途中なら取り除く
  if (corners.length > 3) {
    const a = corners[corners.length - 1], b = corners[0], c = corners[1];
    if (distToSeg(b[0], b[1], a[0], a[1], c[0], c[1]) < diag * 0.06) corners = corners.slice(1);
  }
  // ---- 円・楕円（重心から主軸を出して、半径のばらつきで判断）
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
  let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ct = Math.cos(th), st = Math.sin(th);
  let ra = 0, rb = 0;
  for (const [x, y] of pts) { const u = (x - cx) * ct + (y - cy) * st, v = -(x - cx) * st + (y - cy) * ct; ra = Math.max(ra, Math.abs(u)); rb = Math.max(rb, Math.abs(v)); }
  let err = 0;
  for (const [x, y] of pts) {
    const u = ((x - cx) * ct + (y - cy) * st) / (ra || 1), v = (-(x - cx) * st + (y - cy) * ct) / (rb || 1);
    err += Math.abs(Math.hypot(u, v) - 1);
  }
  err /= pts.length;
  const isEllipse = err < 0.1 && corners.length !== 3 && !(corners.length === 4 && err > 0.075);
  if (isEllipse) {
    if (Math.min(ra, rb) / Math.max(ra, rb) > 0.86) { ra = rb = (ra + rb) / 2; th = 0; }
    else th = snapAngle(th, Math.PI / 2, 0.12);
    const c2 = Math.cos(th), s2 = Math.sin(th), out = [];
    const N = Math.max(36, Math.ceil((Math.PI * (ra + rb)) / 5));
    for (let i = 0; i <= N; i++) { const t = (i / N) * Math.PI * 2, u = Math.cos(t) * ra, v = Math.sin(t) * rb; out.push([cx + u * c2 - v * s2, cy + u * s2 + v * c2]); }
    return { name: ra === rb ? '円' : '楕円', pts: out };
  }
  if (corners.length === 3) return { name: '三角形', pts: segPoints(corners, true) };
  if (corners.length === 4) {
    // 四角: 向きを主な辺に合わせた長方形（ほぼ水平なら水平に）
    let a = Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0]);
    a = snapAngle(a, Math.PI / 2, 0.14);
    const c3 = Math.cos(a), s3 = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of corners) { const u = x * c3 + y * s3, v = -x * s3 + y * c3; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const P = (u, v) => [u * c3 - v * s3, u * s3 + v * c3];
    return { name: '四角形', pts: segPoints([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], true) };
  }
  if (corners.length >= 5 && corners.length <= 8) return { name: corners.length + '角形', pts: segPoints(corners, true) };
  return null;
}
