'use strict';
/* 道具: ペン・蛍光ペン・消しゴム・なげなわ・手のひら。
   down/move/up は view から点 {X, Y（文書の空間）, pressure, t, type} を受ける。ページの座標へは note.docToPage。 */

const HANDLE_PX = 22;

class PenTool {
  constructor(app, kind) { this.app = app; this.kind = kind; this.showsHover = true; this.cur = null; }
  get opt() { return this.app.toolState[this.kind]; }
  down(p, v) {
    const n = v.note;
    const hit = n.pageAt(p.X, p.Y, 0);
    if (!hit.inside) { this.cur = null; return; }
    const o = this.opt;
    const s = this.kind === 'hl' ? newStroke('hl', 'ball', o.color, o.w, o.op) : newStroke('pen', o.pen, o.color, o.w, 1);
    this.cur = { page: hit.page, s, t0: p.t, start: null, shaped: false, v };
    // 定規の縁の近くで書き始めたら、縁にそって真っすぐ
    const R = v.ruler;
    if (R && R.visible) { const sp = v.toScreen(p.X, p.Y), side = R.snapSide(sp.x, sp.y); if (side) this.cur.snap = side; }
    this.add(p, v);
  }
  add(p, v) {
    const c = this.cur;
    if (c.shaped) return;                 // 図形に整えた後は動かしても変えない
    if (c.snap) {
      const sp = v.toScreen(p.X, p.Y), pr = v.ruler.project(sp.x, sp.y, c.snap, (c.s.w * v.s) / 2), P = v.toDocLocal(pr.x, pr.y);
      p = { ...p, X: P.x, Y: P.y };
    }
    const q = v.note.docToPage(c.page, p.X, p.Y);
    const pts = c.s.pts, n = pts.length;
    if (n >= 4) {
      const dx = q.x - pts[n - 4], dy = q.y - pts[n - 3];
      if (dx * dx + dy * dy < (0.25 / v.s) ** 2) return;       // ほとんど動いていない点は捨てる
    }
    if (this.kind === 'hl' && this.opt.straight && n >= 8) {    // 蛍光ペンを直線で: 始点と今の点だけ
      c.s.pts = c.s.pts.subarray(0, 4);
      c.s._cap = null;
    }
    strokeAppend(c.s, q.x, q.y, p.pressure, p.t - c.t0);
    // 少しの手ぶれでは「止まった」ままとみなす（3px 以上動いたら数え直し）
    if (!c.holdAt || Math.hypot(q.x - c.holdAt.x, q.y - c.holdAt.y) * v.s > 3) { c.holdAt = q; this.armHold(v); }
  }
  /* 書いたまま止めると図形に整える */
  armHold(v) {
    clearTimeout(this._hold);
    const c = this.cur;
    if (!c || c.snap || this.kind === 'hl' && this.opt.straight || !this.app.settings.shapeHold) return;
    this._hold = setTimeout(() => {
      if (this.cur !== c || c.shaped) return;
      const r = recognizeShape(c.s.pts);
      if (!r) return;
      const pts = c.s.pts, n = pts.length / 4;
      let pr = 0;
      for (let i = 0; i < n; i++) pr += pts[i * 4 + 2];
      pr = n ? pr / n : 0.5;
      const out = new Float32Array(r.pts.length * 4);
      r.pts.forEach(([x, y], i) => { out[i * 4] = x; out[i * 4 + 1] = y; out[i * 4 + 2] = pr; out[i * 4 + 3] = i * 4; });
      c.s.pts = out; c.s._cap = null; invalidate(c.s);
      c.shaped = true;
      this.app.showBadge(r.name + 'に整えました');
      v.requestOver();
    }, 520);
  }
  move(p, v) { if (this.cur) this.add(p, v); }
  up(p, v) {
    clearTimeout(this._hold);
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    strokeFinish(c.s);
    if (!c.s.pts.length) return;
    v.note.strokesCmd(c.page, [], [c.s], this.kind === 'hl' ? '蛍光ペン' : 'ペン');
    v.invalidate();
  }
  cancel(v) { clearTimeout(this._hold); this.cur = null; v.invalidate(); }
  drawOverlay(g, v) {
    const c = this.cur;
    if (!c || c.v !== v) return;
    v.withPage(g, c.page, (gg) => {
      drawStroke(gg, c.s, { noMultiply: true });
      if (v.predicted && v.predicted.length && c.s.pts.length >= 4 && this.kind !== 'hl' && !c.shaped && !c.snap) {   // 先読み（画面だけ）
        const pts = c.s.pts, n = pts.length;
        gg.beginPath();
        gg.moveTo(pts[n - 4], pts[n - 3]);
        for (const P of v.predicted) { const q = v.note.docToPage(c.page, P.x, P.y); gg.lineTo(q.x, q.y); }
        gg.strokeStyle = c.s.color; gg.globalAlpha = 0.5; gg.lineWidth = c.s.w * 0.8; gg.lineCap = 'round';
        gg.stroke();
      }
    });
  }
  drawHover(g, v, P) {
    const o = this.opt, sp = v.toScreen(P.x, P.y), d = v.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.beginPath();
    g.arc(sp.x, sp.y, Math.max(2, (o.w * v.s) / 2), 0, Math.PI * 2);
    g.fillStyle = o.color;
    g.globalAlpha = this.kind === 'hl' ? 0.35 : 0.6;
    g.fill();
    g.globalAlpha = 1;
  }
}

class EraserTool {
  constructor(app) { this.app = app; this.showsHover = true; this.sess = null; }
  get opt() { return this.app.toolState.eraser; }
  radius(v) { return this.opt.size / 2 / v.s; }
  down(p, v) { this.sess = new Map(); this.last = null; this.erase(p, v); }
  move(p, v) { if (this.sess) this.erase(p, v); }
  erase(p, v) {
    const n = v.note;
    // 前の点との間も消す（速く動かしたとき）
    const pts = [];
    if (this.last) {
      const d = Math.hypot(p.X - this.last.X, p.Y - this.last.Y), step = this.radius(v) * 0.7;
      const k = Math.min(40, Math.floor(d / step));
      for (let i = 1; i <= k; i++) pts.push({ X: this.last.X + ((p.X - this.last.X) * i) / (k + 1), Y: this.last.Y + ((p.Y - this.last.Y) * i) / (k + 1) });
    }
    pts.push(p);
    this.last = p;
    this.hoverAt = { x: p.X, y: p.Y };
    let changed = false;
    for (const P of pts) {
      const hit = n.pageAt(P.X, P.Y, this.radius(v));
      if (!hit.page) continue;
      const page = hit.page, q = n.docToPage(page, P.X, P.Y), r = this.radius(v);
      if (!this.sess.has(page)) this.sess.set(page, page.strokes.slice());
      const out = [];
      let any = false;
      for (const s of page.strokes) {
        if (this.opt.mode === 'stroke') {
          if (strokeHit(s, q.x, q.y, r)) { any = true; continue; }
          out.push(s);
        } else {
          const pieces = strokeEraseAt(s, q.x, q.y, r);
          if (pieces === null) { out.push(s); continue; }
          any = true;
          out.push(...pieces);
        }
      }
      if (any) { page.strokes = out; n.version++; changed = true; }
    }
    if (changed) v.invalidate(); else v.requestOver();
  }
  up(p, v) {
    const n = v.note;
    if (this.sess) for (const [page, before] of this.sess) {
      if (before.length === page.strokes.length && before.every((s, i) => s === page.strokes[i])) continue;
      n.swapCmd(page, before, page.strokes.slice(), '消しゴム');
    }
    this.sess = null;
    this.hoverAt = null;
    v.invalidate();
  }
  cancel(v) {
    if (this.sess) for (const [page, before] of this.sess) page.strokes = before;
    this.sess = null;
    if (v.note) v.note.touch(null);
    v.invalidate();
  }
  drawOverlay(g, v) { if (this.sess && this.hoverAt) this.drawHover(g, v, this.hoverAt); }
  drawHover(g, v, P) {
    const sp = v.toScreen(P.x, P.y), d = v.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.beginPath();
    g.arc(sp.x, sp.y, this.opt.size / 2, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,.25)'; g.fill();
    g.strokeStyle = 'rgba(40,40,40,.7)'; g.lineWidth = 1; g.stroke();
  }
}

/* なげなわ: 囲んで選ぶ（画像はタップでも選べる）→ 動かす（中をドラッグ）・拡大縮小（右下の角）・回転（上の丸）。操作は浮かぶバーから。
   選択 = {page, strokes:[...], images:[...]} */
class LassoTool {
  constructor(app) { this.app = app; this.showsHover = false; this.poly = null; this.sel = null; this.drag = null; }
  clear(v) {
    this.sel = null; this.drag = null; this.poly = null;
    if (v) { v.hidden = null; v.invalidate(); }
    this.app.hideSelectionBar();
  }
  selectionRect() {
    if (!this.sel) return null;
    return unionBBox(this.sel.strokes.concat(this.sel.images.map((im) => ({ _bb: imageBBox(im) }))));
  }
  setSel(page, strokes, images) { this.sel = strokes.length || images.length ? { page, strokes, images } : null; }
  /* 選択の枠の画面上の 4 隅（ページの回転・画面の回転を含む） */
  screenCorners(v) {
    const b = this.selectionRect();
    if (!b) return null;
    const n = v.note, pm = n.pageMatrix(this.sel.page);
    const P = (x, y) => v.toScreen(pm.a * x + pm.c * y + pm.e, pm.b * x + pm.d * y + pm.f);
    return [P(b[0], b[1]), P(b[2], b[1]), P(b[2], b[3]), P(b[0], b[3])];
  }
  handles(v) {
    const c = this.screenCorners(v);
    if (!c) return null;
    const mx = (c[0].x + c[1].x) / 2, my = (c[0].y + c[1].y) / 2;
    const cx = (c[0].x + c[2].x) / 2, cy = (c[0].y + c[2].y) / 2;
    const L = Math.hypot(mx - cx, my - cy) || 1;
    return { scale: c[2], rotate: { x: mx + ((mx - cx) / L) * 28, y: my + ((my - cy) / L) * 28 }, corners: c };
  }
  hideIds() { return new Set(this.sel.strokes.map((s) => s.id).concat(this.sel.images.map((im) => im.id))); }
  down(p, v) {
    const n = v.note;
    if (this.sel) {
      const sp = v.toScreen(p.X, p.Y), h = this.handles(v);
      const q = n.docToPage(this.sel.page, p.X, p.Y), b = this.selectionRect();
      const near = (a) => Math.hypot(a.x - sp.x, a.y - sp.y) <= HANDLE_PX;
      let mode = null;
      if (near(h.rotate)) mode = 'rotate';
      else if (near(h.scale)) mode = 'scale';
      else if (q.x >= b[0] && q.x <= b[2] && q.y >= b[1] && q.y <= b[3]) mode = 'move';
      if (mode) {
        this.drag = { mode, q0: q, b, m: null };
        v.hidden = this.hideIds();
        this.app.hideSelectionBar();
        v.invalidate();
        return;
      }
      this.clear(v);
    }
    const hit = n.pageAt(p.X, p.Y, 40);
    if (!hit.page) return;
    const q = n.docToPage(hit.page, p.X, p.Y);
    this.poly = { page: hit.page, pts: [q.x, q.y] };
  }
  move(p, v) {
    const n = v.note;
    if (this.drag) {
      const D = this.drag, q = n.docToPage(this.sel.page, p.X, p.Y), b = D.b;
      if (D.mode === 'move') D.m = { a: 1, b: 0, c: 0, d: 1, e: q.x - D.q0.x, f: q.y - D.q0.y };
      else if (D.mode === 'scale') {
        const k = Math.max(0.05, Math.max((q.x - b[0]) / (D.q0.x - b[0] || 1), (q.y - b[1]) / (D.q0.y - b[1] || 1)));
        D.m = { a: k, b: 0, c: 0, d: k, e: b[0] - k * b[0], f: b[1] - k * b[1] };
      } else {
        const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        let ang = Math.atan2(q.y - cy, q.x - cx) - Math.atan2(D.q0.y - cy, D.q0.x - cx);
        const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        if (Math.abs(ang - snap) < 0.05) ang = snap;
        const c = Math.cos(ang), s = Math.sin(ang);
        D.m = { a: c, b: s, c: -s, d: c, e: cx - c * cx + s * cy, f: cy - s * cx - c * cy };
      }
      v.requestOver();
      return;
    }
    if (this.poly) {
      const q = n.docToPage(this.poly.page, p.X, p.Y), a = this.poly.pts;
      if (Math.hypot(q.x - a[a.length - 2], q.y - a[a.length - 1]) * v.s > 2) a.push(q.x, q.y);
      v.requestOver();
    }
  }
  up(p, v) {
    const n = v.note;
    if (this.drag) {
      const D = this.drag;
      this.drag = null;
      v.hidden = null;
      if (D.m) {
        const page = this.sel.page, sb = page.strokes.slice(), ib = (page.images || []).slice();
        const ms = new Map(this.sel.strokes.map((s) => [s.id, strokeTransformed(s, D.m)]));
        const mi = new Map(this.sel.images.map((im) => [im.id, imageTransformed(im, D.m)]));
        n.swapBoth(page, sb, sb.map((s) => ms.get(s.id) || s), ib, ib.map((im) => mi.get(im.id) || im), { move: '移動', scale: '拡大縮小', rotate: '回転' }[D.mode]);
        this.sel = { page, strokes: [...ms.values()], images: [...mi.values()] };
      }
      v.invalidate();
      this.showBar(v);
      return;
    }
    if (this.poly) {
      const { page, pts } = this.poly;
      this.poly = null;
      let ext = 0;
      for (let i = 2; i < pts.length; i += 2) ext = Math.max(ext, Math.hypot(pts[i] - pts[0], pts[i + 1] - pts[1]));
      if (ext * v.s < 8) {            // タップ: 画像を 1 枚選ぶ（上にある方から）
        const im = (page.images || []).slice().reverse().find((x) => imageHit(x, pts[0], pts[1]));
        this.setSel(page, [], im ? [im] : []);
      } else if (pts.length >= 6) {
        const chosen = page.strokes.filter((s) => strokeInPoly(s, pts));
        const imgs = (page.images || []).filter((im) => {
          const c = imageCorners(im);
          return pointInPoly(c.reduce((a, q) => a + q[0], 0) / 4, c.reduce((a, q) => a + q[1], 0) / 4, pts);
        });
        this.setSel(page, chosen, imgs);
      } else this.sel = null;
      v.requestOver();
      if (this.sel) this.showBar(v); else this.app.hideSelectionBar();
    }
  }
  cancel(v) { this.poly = null; if (this.drag) { this.drag = null; v.hidden = null; } v.invalidate(); }
  showBar(v) {
    const c = this.screenCorners(v);
    if (!c) return;
    const parts = [];
    if (this.sel.strokes.length) parts.push(`線 ${this.sel.strokes.length}`);
    if (this.sel.images.length) parts.push(`画像 ${this.sel.images.length}`);
    this.app.showSelectionBar(Math.min(...c.map((q) => q.x)), Math.min(...c.map((q) => q.y)), Math.max(...c.map((q) => q.x)),
      Math.max(...c.map((q) => q.y)), parts.join('・'));
  }
  drawSelected(gg) {
    for (const im of this.sel.images) drawObject(gg, im, { screen: true });
    drawStrokes(gg, this.sel.strokes, null, { noMultiply: true });
  }
  drawOverlay(g, v) {
    if (this.poly) {
      v.withPage(g, this.poly.page, (gg) => {
        const a = this.poly.pts;
        gg.beginPath();
        gg.moveTo(a[0], a[1]);
        for (let i = 2; i < a.length; i += 2) gg.lineTo(a[i], a[i + 1]);
        gg.closePath();
        gg.fillStyle = 'rgba(70,130,230,.08)'; gg.fill();
        gg.setLineDash([6 / v.s, 4 / v.s]); gg.lineWidth = 1.2 / v.s; gg.strokeStyle = '#3d7be0'; gg.stroke();
      });
      return;
    }
    if (!this.sel) return;
    const D = this.drag;
    if (D && D.m) {
      v.withPage(g, this.sel.page, (gg) => { gg.transform(D.m.a, D.m.b, D.m.c, D.m.d, D.m.e, D.m.f); this.drawSelected(gg); });
    } else if (D) {
      v.withPage(g, this.sel.page, (gg) => this.drawSelected(gg));
    }
    if (D) return;
    const h = this.handles(v), d = v.dpr, c = h.corners;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.beginPath();
    g.moveTo(c[0].x, c[0].y); for (const q of c.slice(1)) g.lineTo(q.x, q.y); g.closePath();
    g.setLineDash([5, 4]); g.strokeStyle = '#3d7be0'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgba(70,130,230,.06)'; g.fill();
    const mid = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
    g.beginPath(); g.moveTo(mid.x, mid.y); g.lineTo(h.rotate.x, h.rotate.y); g.stroke();
    for (const [q, round] of [[h.scale, false], [h.rotate, true]]) {
      g.beginPath();
      if (round) g.arc(q.x, q.y, 8, 0, Math.PI * 2); else g.rect(q.x - 8, q.y - 8, 16, 16);
      g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#3d7be0'; g.lineWidth = 2; g.stroke();
    }
  }

  // ---- 選択への操作（浮かぶバーから）
  replace(v, label, fnS, fnI, newSel) {
    const page = this.sel.page, sb = page.strokes.slice(), ib = (page.images || []).slice();
    v.note.swapBoth(page, sb, fnS(sb), ib, fnI(ib), label);
    if (newSel) { this.setSel(page, newSel.strokes, newSel.images); v.invalidate(); if (this.sel) this.showBar(v); }
  }
  remove(v) {
    if (!this.sel) return;
    const ids = this.hideIds();
    this.replace(v, '削除', (sb) => sb.filter((s) => !ids.has(s.id)), (ib) => ib.filter((im) => !ids.has(im.id)));
    this.clear(v);
  }
  copy() {
    if (!this.sel) return;
    this.app.clipboard = { strokes: this.sel.strokes.map((s) => ({ ...strokeRecord(s), pts: s.pts.slice() })), images: this.sel.images.map(imageRecord) };
    toast('コピーしました');
  }
  cut(v) { this.copy(); this.remove(v); }
  duplicate(v) {
    if (!this.sel) return;
    const m = { a: 1, b: 0, c: 0, d: 1, e: 16, f: 16 };
    const cs = this.sel.strokes.map((s) => strokeTransformed(s, m)), ci = this.sel.images.map((im) => imageTransformed(im, m, false));
    this.replace(v, '複製', (sb) => sb.concat(cs), (ib) => ib.concat(ci), { strokes: cs, images: ci });
  }
  recolor(v, color) {
    if (!this.sel || !this.sel.strokes.length) return;
    const map = new Map(this.sel.strokes.map((s) => [s.id, { ...strokeRecord(s), id: uid('s'), color, pts: s.pts }]));
    this.replace(v, '色を変更', (sb) => sb.map((s) => map.get(s.id) || s), (ib) => ib, { strokes: [...map.values()], images: this.sel.images });
  }
  paste(v, page, at) {
    const cb = this.app.clipboard;
    const imgs = cb ? cb.images || [] : [];
    if (!cb || !(cb.strokes.length || imgs.length)) return false;
    const b = unionBBox(cb.strokes.concat(imgs.map((im) => ({ _bb: imageBBox(im) }))));
    const dx = at ? at.x - (b[0] + b[2]) / 2 : 20, dy = at ? at.y - (b[1] + b[3]) / 2 : 20;
    const m = { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
    const cs = cb.strokes.map((s) => strokeTransformed(s, m)), ci = imgs.map((im) => imageTransformed(im, m, false));
    this.sel = { page, strokes: [], images: [] };
    this.replace(v, '貼り付け', (sb) => sb.concat(cs), (ib) => ib.concat(ci), { strokes: cs, images: ci });
    return true;
  }
}
