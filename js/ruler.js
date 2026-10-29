'use strict';
/* 定規: 画面に浮かぶ定規。1本指（またはペン・マウスで真ん中）でドラッグ＝移動、2本指 または 丸いつまみ（↻）をドラッグ＝回転（15° ごとに吸い付く）。
   クイックバーの「横・縦・45°」でも向きを変えられる。
   ペンを定規の縁の近くで書き始めると、線が縁にそって真っすぐになる。座標は画面（CSS px）。 */

class Ruler {
  constructor(view) { this.view = view; this.visible = false; this.cx = 300; this.cy = 300; this.ang = 0; this.W = 72; }
  show(on = !this.visible) {
    this.visible = on;
    if (on) { const v = this.view; this.cx = v.cssW / 2; this.cy = v.cssH * 0.45; }
    this.view.requestOver();
  }
  get u() { return { x: Math.cos(this.ang), y: Math.sin(this.ang) }; }
  local(x, y) { const u = this.u, dx = x - this.cx, dy = y - this.cy; return { t: dx * u.x + dy * u.y, d: -dx * u.y + dy * u.x }; }
  /* 回すつまみ（定規の上、真ん中から少し右） */
  knob() { const u = this.u; return { x: this.cx + u.x * 110, y: this.cy + u.y * 110 }; }
  knobHit(x, y) { if (!this.visible) return false; const k = this.knob(); return Math.hypot(x - k.x, y - k.y) <= 20; }
  setAngle(deg) { this.ang = (deg * Math.PI) / 180; this.view.requestOver(); }
  /* つまみをドラッグした位置へ向ける（15° に吸い付く） */
  turnTo(x, y) {
    let a = Math.atan2(y - this.cy, x - this.cx);
    const snap = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    if (Math.abs(a - snap) < (3 * Math.PI) / 180) a = snap;
    this.ang = a;
    this.view.requestOver();
  }
  /* 本体の上か */
  hit(x, y) { return this.visible && Math.abs(this.local(x, y).d) <= this.W / 2; }
  /* 本体の真ん中あたり（縁から離れた所）＝つかんで動かす所 */
  grip(x, y) { return this.visible && Math.abs(this.local(x, y).d) <= this.W / 2 - 14; }
  /* 縁の近くで書き始めたら、その縁の線（side = ±1） */
  snapSide(x, y) {
    if (!this.visible) return 0;
    const d = this.local(x, y).d, e = this.W / 2;
    if (Math.abs(d) >= e - 14 && Math.abs(d) <= e + 26) return Math.sign(d) || 1;
    return 0;
  }
  /* 縁の線に乗せる（画面の点 → 画面の点）。off = 線の太さの半分（px） */
  project(x, y, side, off = 0) {
    const u = this.u, t = this.local(x, y).t, e = (this.W / 2 + off) * side;
    return { x: this.cx + u.x * t - u.y * e, y: this.cy + u.y * t + u.x * e };
  }
  draw(g) {
    if (!this.visible) return;
    const v = this.view, d = v.dpr, L = Math.hypot(v.cssW, v.cssH) * 1.2, W = this.W;
    g.save();
    g.setTransform(d, 0, 0, d, 0, 0);
    g.translate(this.cx, this.cy);
    g.rotate(this.ang);
    g.fillStyle = 'rgba(235,238,245,.62)';
    g.strokeStyle = 'rgba(60,70,90,.55)'; g.lineWidth = 1;
    g.fillRect(-L, -W / 2, L * 2, W);
    g.strokeRect(-L, -W / 2, L * 2, W);
    // 目盛り（文書の mm。細かすぎる時は 5 mm ごと）
    const mm = (72 / 25.4) * v.s;
    const step = mm < 4 ? 5 : 1;
    g.fillStyle = 'rgba(40,45,60,.8)';
    g.font = '10px -apple-system, "Hiragino Sans", sans-serif';
    g.textAlign = 'center';
    g.beginPath();
    for (let i = -Math.floor(L / mm); i <= L / mm; i += step) {
      const x = i * mm, big = i % 10 === 0, mid = i % 5 === 0;
      const h = big ? 14 : mid ? 9 : 5;
      g.moveTo(x, -W / 2); g.lineTo(x, -W / 2 + h);
      g.moveTo(x, W / 2); g.lineTo(x, W / 2 - h);
      if (big && (mm * 10 > 26)) g.fillText(String(Math.abs(i / 10)), x, -W / 2 + 26);
    }
    g.stroke();
    // 角度
    const deg = Math.round((((this.ang * 180) / Math.PI) % 360 + 360) % 360);
    g.font = '600 13px -apple-system, "Hiragino Sans", sans-serif';
    g.fillStyle = 'rgba(30,35,50,.85)';
    g.fillText(`${deg > 180 ? deg - 360 : deg}°`, 0, 6);
    // 回すつまみ
    g.beginPath(); g.arc(110, 0, 14, 0, Math.PI * 2);
    g.fillStyle = 'rgba(61,123,224,.9)'; g.fill();
    g.fillStyle = '#fff'; g.font = '700 15px -apple-system, sans-serif'; g.fillText('↻', 110, 5);
    g.restore();
  }
}
