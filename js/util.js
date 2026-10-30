'use strict';
/* 共通の小道具: 版・DOM・トースト・ダイアログ・数値。 */

const APP_VERSION = '1.4.0';
const LS = 'kamikobo-web.';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) e.style.setProperty(sk, sv);      // CSS 変数は代入では入らない
        else e.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = (p = 'i') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function debounce(fn, ms) {
  let t = 0;
  const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  f.flush = (...a) => { clearTimeout(t); return fn(...a); };
  f.cancel = () => clearTimeout(t);
  return f;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- 設定（localStorage）
function loadJSON(key, def) {
  try { const v = localStorage.getItem(LS + key); return v ? { ...def, ...JSON.parse(v) } : { ...def }; } catch { return { ...def }; }
}
function saveJSON(key, v) { try { localStorage.setItem(LS + key, JSON.stringify(v)); } catch { /* 私的ブラウズなど */ } }

// ---- トースト
function toast(msg, opt = {}) {
  let box = $('#toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: 'toast' + (opt.error ? ' error' : '') }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), opt.ms || 2600);
  setTimeout(() => t.remove(), (opt.ms || 2600) + 400);
}

// ---- ダイアログ（Promise で答えを返す）
function modal(title, body, buttons, opt = {}) {
  return new Promise((resolve) => {
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: 'modal' + (opt.wide ? ' wide' : '') });
    const close = (v) => { back.remove(); resolve(v); };
    box.append(el('h2', {}, title));
    if (body) box.append(typeof body === 'string' ? el('p', {}, body) : body);
    const row = el('div', { class: 'modal-buttons' });
    for (const b of buttons) {
      row.append(el('button', { class: b.primary ? 'primary' : (b.danger ? 'danger' : ''),
        onclick: () => { const v = b.value !== undefined ? b.value : b.label; if (b.check && !b.check()) return; close(typeof v === 'function' ? v() : v); } }, b.label));
    }
    box.append(row);
    back.append(box);
    back.addEventListener('pointerdown', (e) => { if (e.target === back && !opt.sticky) close(null); });
    document.body.append(back);
    const first = box.querySelector('input,textarea,select');
    if (first && !opt.noFocus) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { const p = buttons.find((b) => b.primary); if (p) row.children[buttons.indexOf(p)].click(); }
    });
  });
}

async function askText(title, value = '', placeholder = '') {
  const inp = el('input', { type: 'text', value, placeholder, class: 'wide' });
  const v = await modal(title, inp, [{ label: 'キャンセル', value: null }, { label: 'OK', primary: true, value: () => inp.value }]);
  return v == null ? null : String(v).trim();
}

function confirmBox(title, msg, okLabel = 'OK', danger = false) {
  return modal(title, msg, [{ label: 'キャンセル', value: false }, { label: okLabel, primary: !danger, danger, value: true }]);
}

/* 小さなメニュー（anchor の近くに出す）。items = [{label, fn, danger, disabled}] or null（区切り） */
function popMenu(anchor, items) {
  closePopMenus();
  const m = el('div', { class: 'popmenu' });
  for (const it of items) {
    if (!it) { m.append(el('div', { class: 'sep' })); continue; }
    m.append(el('button', { class: it.danger ? 'danger' : '', disabled: it.disabled,
      onclick: (e) => { e.stopPropagation(); closePopMenus(); it.fn(); } }, it.label));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + mw > innerWidth - 8) x = Math.max(8, r.right - mw);
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onAway, true), 0);
  function onAway(e) { if (!m.contains(e.target)) { closePopMenus(); } }
  m._off = () => document.removeEventListener('pointerdown', onAway, true);
  return m;
}
function closePopMenus() { for (const m of $$('.popmenu')) { if (m._off) m._off(); m.remove(); } }

// ---- 幾何
function pointInPoly(x, y, poly) {      // poly = [x0,y0,x1,y1,...]
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hexToRgb(h) {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
