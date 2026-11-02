'use strict';
/* まとめて PDF: 写真・画像・PDF をサムネイルで並べ（取り込んだ順。前へ・後ろへで並べ替え）、選んだ物を
   - 写真は一括で自動補正（scanner.js の scanProcess。四隅が見つからなければ写真全体）・1 枚だけ手で直す（スキャナーの画面）・補正を戻す
   - 1 つの PDF に結合して保存（PDF は元のページのまま＝文字も選べる。暗号化などで写せない PDF は絵にして入れる）・ノートにする
   mode 'pick' はスキャナーから開いた時: PDF は入れず、選んだ写真（補正した物）を [{blob, w, h}] で返す。 */

const TRAY_IMG_MAX = 2400;      // 入れる画像の長い辺（px）

/* 画像を JPEG（長い辺 TRAY_IMG_MAX まで）に直す（HEIC・向き・大きすぎる写真もこれでそろう） */
async function trayNormalize(file) {
  const im = await loadImageEl(file);
  const W0 = im.naturalWidth || im.width, H0 = im.naturalHeight || im.height, k = Math.min(1, TRAY_IMG_MAX / Math.max(W0, H0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W0 * k)); c.height = Math.max(1, Math.round(H0 * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(im, 0, 0, c.width, c.height);
  return trayFromCanvas(c);
}
async function trayFromCanvas(c) {
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  const t = document.createElement('canvas'), tk = 220 / Math.max(c.width, c.height);
  t.width = Math.max(1, Math.round(c.width * tk)); t.height = Math.max(1, Math.round(c.height * tk));
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  return { blob, w: c.width, h: c.height, thumb: t.toDataURL('image/jpeg', 0.8) };
}
async function trayPdfInfo(bytes) {
  const doc = await PdfDocs.open(bytes);
  const pg = await doc.getPage(1), vp0 = pg.getViewport({ scale: 1 }), k = 220 / Math.max(vp0.width, vp0.height), vp = pg.getViewport({ scale: k });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: g, viewport: vp }).promise;
  const n = doc.numPages;
  doc.destroy();
  return { pages: n, thumb: c.toDataURL('image/jpeg', 0.8) };
}

/* 選んだ物を 1 つの PDF に。fit: 'width'（幅を A4 に、高さは画像の比）| 'a4'（A4 の紙に余白をつけて収める） */
async function buildMergedPdf(items, fit = 'width', onProgress) {
  const L = await Lib.pdflib(), out = await L.PDFDocument.create();
  out.setTitle('紙工房 Web'); out.setCreator('紙工房 Web');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (onProgress) onProgress(i, items.length);
    if (it.kind === 'pdf') {
      try {
        const src = await L.PDFDocument.load(it.bytes.slice(0));
        for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
      } catch {             // 暗号化などで写せない → ページを絵にして入れる
        const doc = await PdfDocs.open(it.bytes);
        for (let k = 1; k <= doc.numPages; k++) {
          const pg = await doc.getPage(k), vp1 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: 2 });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          await pg.render({ canvasContext: g, viewport: vp }).promise;
          const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
          const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
          out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        }
        doc.destroy();
      }
    } else {
      const img = await out.embedJpg(new Uint8Array(await it.blob.arrayBuffer()));
      if (fit === 'a4') {
        const land = it.w > it.h, [pw, ph] = land ? [842, 595] : [595, 842], m = 24, k = Math.min((pw - m * 2) / it.w, (ph - m * 2) / it.h);
        const w = it.w * k, h = it.h * k;
        out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      } else {
        const w = 595, h = (595 * it.h) / it.w;
        out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      }
    }
  }
  return out.save();
}

const Tray = {
  /* mode 'pdf'（本棚から: PDF に保存・ノートにする）| 'pick'（スキャナーから: 選んだ写真を返す） */
  open(opt = {}) {
    const pick = opt.mode === 'pick';
    return new Promise((resolve) => {
      const T = { items: [], busy: false, fit: loadJSON('tray', { fit: 'width' }).fit };
      const o = { ...loadJSON('scan', SCAN_DEFAULTS), split: false };      // 見開きを分けるのはこの画面にいる間だけ
      const saveO = () => saveJSON('scan', { ...o, split: false });
      const head = el('div', { class: 'scan-head' }, el('b', {}, opt.title || 'まとめて PDF'));
      const count = el('span', { class: 'muted' });
      const actions = el('span', { class: 'tray-actions' });
      head.append(count, el('span', { class: 'scan-sp' }), el('button', { onclick: () => quit() }, pick ? '戻る' : 'やめる'), actions);
      const tools = el('div', { class: 'scan-tools tray-tools' });
      const grid = el('div', { class: 'tray-grid' });
      const status = el('div', { class: 'tray-status muted small' });
      const box = el('div', { class: 'scan tray' }, head, tools, grid, status);
      document.body.append(box);

      const close = (v) => { box.remove(); resolve(v); };
      const quit = async () => {
        if (!pick && T.items.length && !await confirmBox('まとめて PDF をやめる', `並べた ${T.items.length} 件を閉じます（元の写真・ファイルはそのまま）。`, '閉じる', true)) return;
        close(pick ? [] : null);
      };
      const sel = () => T.items.filter((x) => x.on);
      const say = (t) => { status.textContent = t || ''; };

      // ---- 足す
      const add = async (files) => {
        T.busy = true; render();
        let n = 0, skip = 0;
        for (const f of files) {
          say(`${++n} / ${files.length} を読み込んでいます…`);
          try {
            if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
              if (pick) { skip++; continue; }
              const bytes = await f.arrayBuffer(), info = await trayPdfInfo(bytes);
              T.items.push({ id: uid('t'), kind: 'pdf', name: f.name, bytes, pages: info.pages, thumb: info.thumb, on: true });
            } else if (/^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name)) {
              T.items.push({ id: uid('t'), kind: 'image', name: f.name || '写真', file: f, ...(await trayNormalize(f)), on: true });
            } else skip++;
          } catch (e) { skip++; toast(`${f.name}: ${e.message || e}`, { error: true }); }
          render();
        }
        T.busy = false;
        say(skip ? `${skip} 件は入れられませんでした${pick ? '（ここでは写真だけ）' : ''}` : '');
        render();
      };
      const pickAny = () => pickFiles(pick ? 'image/*' : 'application/pdf,.pdf,image/*');

      // ---- 選んだ写真を自動補正（スキャナーの仕上げをおまかせで）
      const autoFix = async () => {
        const list = sel().filter((x) => x.kind === 'image');
        if (!list.length) { toast('写真（画像）を選んでください'); return; }
        T.busy = true; render();
        let n = 0;
        for (const it of list) {
          say(`${++n} / ${list.length} 枚目を自動補正しています…`);
          await new Promise((r) => setTimeout(r, 20));
          try {
            const c = await scanLoad(it.file);
            const q = scanDetect(c) || [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]];
            const pages = scanProcess(c, q, { ...o, tilt: 0, crop: null }, SCAN_MAX, {}).pages;
            const made = [];
            for (const p of pages) made.push(await trayFromCanvas(p));
            if (!it.orig) it.orig = { blob: it.blob, w: it.w, h: it.h, thumb: it.thumb };
            Object.assign(it, made[0], { fixed: true });
            if (made.length > 1) T.items.splice(T.items.indexOf(it) + 1, 0, ...made.slice(1).map((m) => ({ id: uid('t'), kind: 'image', name: it.name, file: it.file, ...m, fixed: true, on: true })));
          } catch (e) { toast(`${it.name}: ${e.message || e}`, { error: true }); }
          render();
        }
        T.busy = false;
        say(`${list.length} 枚を自動補正しました（「補正を戻す」で元に戻せます）`);
        render();
      };
      /* 1 枚だけスキャナーの画面で四隅・仕上げを手で直す */
      const handFix = async () => {
        const list = sel().filter((x) => x.kind === 'image');
        if (list.length !== 1) { toast('手で直す写真を 1 枚だけ選んでください'); return; }
        const it = list[0];
        const shots = await Scanner.open('1 枚だけ直す', { files: [it.file], once: true });
        if (!shots.length) return;
        const made = [];
        for (const s of shots) {
          const im = await loadImageEl(s.blob), c = document.createElement('canvas');
          c.width = s.w; c.height = s.h; c.getContext('2d').drawImage(im, 0, 0);
          made.push(await trayFromCanvas(c));
        }
        if (!it.orig) it.orig = { blob: it.blob, w: it.w, h: it.h, thumb: it.thumb };
        Object.assign(it, made[0], { fixed: true });
        if (made.length > 1) T.items.splice(T.items.indexOf(it) + 1, 0, ...made.slice(1).map((m) => ({ id: uid('t'), kind: 'image', name: it.name, file: it.file, ...m, fixed: true, on: true })));
        say(made.length > 1 ? `手で直して ${made.length} ページにしました` : '手で直しました');
        render();
      };
      const unfix = () => {
        let n = 0;
        for (const it of sel()) if (it.orig) { Object.assign(it, it.orig, { fixed: false }); delete it.orig; n++; }
        say(n ? `${n} 枚を元に戻しました` : '補正した写真を選んでください');
        render();
      };
      /* 選んだ物を 1 つ前・後ろへ（選んだ物どうしの順はそのまま） */
      const move = (d) => {
        const a = T.items;
        const idx = a.map((x, i) => (x.on ? i : -1)).filter((i) => i >= 0);
        if (d < 0) { for (const i of idx) if (i > 0 && !a[i - 1].on) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
        else for (const i of idx.reverse()) if (i < a.length - 1 && !a[i + 1].on) [a[i + 1], a[i]] = [a[i], a[i + 1]];
        render();
      };

      // ---- 出す
      const savePdf = async () => {
        const list = sel();
        if (!list.length) { toast('PDF に入れる物を選んでください'); return; }
        const name = await askText('PDF の名前', `まとめ ${fmtDate(Date.now()).slice(5).replace(/[/:]/g, '-')}`);
        if (name == null) return;
        T.busy = true; render();
        const pr = progressBox('PDF を作っています');
        let bytes;
        try { bytes = await buildMergedPdf(list, T.fit, (i, k) => pr.set(i, k)); }
        catch (e) { toast('PDF を作れませんでした: ' + (e.message || e), { error: true, ms: 6000 }); return; }
        finally { pr.close(); T.busy = false; render(); }
        saveJSON('tray', { fit: T.fit });
        const pages = list.reduce((n, x) => n + (x.kind === 'pdf' ? x.pages : 1), 0);
        await offerFile(new Blob([bytes], { type: 'application/pdf' }), `${safeName(name || 'まとめ')}.pdf`, `PDF にしました（${pages} ページ）`);
      };
      const toNote = () => {
        const list = sel();
        if (!list.length) { toast('ノートに入れる物を選んでください'); return; }
        close(list);
      };
      const givePicked = () => {
        const list = sel();
        if (!list.length) { toast('入れる写真を選んでください'); return; }
        close(list.map((x) => ({ blob: x.blob, w: x.w, h: x.h, thumb: x.thumb })));
      };

      // ---- 画面
      const render = () => {
        const s = sel(), imgs = s.filter((x) => x.kind === 'image').length;
        count.textContent = T.items.length ? `${T.items.length} 件・${s.length} 件を選んでいます` : '';
        actions.innerHTML = '';
        const dis = T.busy || !s.length;
        if (pick) actions.append(el('button', { class: 'primary', disabled: dis, onclick: givePicked }, `スキャンに入れる（${s.length} 枚）`));
        else actions.append(el('button', { disabled: dis, onclick: toNote }, '📓 ノートにする'),
          el('button', { class: 'primary', disabled: dis, onclick: savePdf }, `📄 1 つの PDF に保存（${s.length}）`));
        tools.innerHTML = '';
        const b = (label, fn, on = true, cls = 'small') => el('button', { class: cls, disabled: T.busy || !on, onclick: fn }, label);
        const chip = (label, key) => el('button', { class: 'chip' + (o[key] ? ' on' : ''), disabled: T.busy, onclick: () => { o[key] = !o[key]; saveO(); render(); } }, label);
        tools.append(
          el('div', { class: 'scan-row' },
            b('＋ 写真から', async () => add(await pickPhotos(false))),
            pick ? null : b('＋ ファイルから（PDF・画像）', async () => add(await pickAny())),
            b('📷 カメラ', async () => add(await pickPhotos(true))),
            el('span', { class: 'tray-sep' }),
            b('全部選択', () => { T.items.forEach((x) => { x.on = true; }); render(); }, T.items.length),
            b('選択を外す', () => { T.items.forEach((x) => { x.on = false; }); render(); }, s.length),
            b('◀ 前へ', () => move(-1), s.length),
            b('後ろへ ▶', () => move(1), s.length),
            b('🗑 外す', () => { T.items = T.items.filter((x) => !x.on); render(); }, s.length)),
          el('div', { class: 'scan-row' },
            b(`⚡ 選んだ写真を自動補正（${imgs}）`, autoFix, imgs, 'small primary'),
            b('✎ 1 枚だけ手で直す', handFix, imgs === 1),
            b('補正を戻す', unfix, s.some((x) => x.orig)),
            el('span', { class: 'tray-sep' }),
            ...SCAN_MODES.map(([k, label]) => el('button', { class: 'chip' + (o.mode === k ? ' on' : ''), disabled: T.busy, onclick: () => { o.mode = k; saveO(); render(); } }, label)),
            chip('傾き', 'deskew'), chip('指を消す', 'fingers'), chip('本の影', 'book'), chip('見開きを 2 枚に', 'split'),
            pick ? null : el('span', { class: 'tray-sep' }),
            pick ? null : el('select', { class: 'tray-fit', disabled: T.busy, onchange: (e) => { T.fit = e.target.value; } },
              el('option', { value: 'width', selected: T.fit === 'width' }, 'PDF のページ: 幅を A4 に'),
              el('option', { value: 'a4', selected: T.fit === 'a4' }, 'PDF のページ: A4 に収める（余白）'))));
        grid.innerHTML = '';
        if (!T.items.length) {
          grid.append(el('div', { class: 'tray-empty muted' }, pick ? '「＋ 写真から」で写真をまとめて選んでください。サムネイルで選んで、選んだ写真だけを自動補正できます。'
            : '「＋ 写真から」「＋ ファイルから」で写真・画像・PDF をまとめて入れてください。入れた順に並び、選んだ物を 1 つの PDF にできます（PDF は元のページのまま結合）。'));
        }
        T.items.forEach((it, i) => {
          const tile = el('button', { class: 'tray-tile' + (it.on ? ' on' : ''), disabled: T.busy, onclick: () => { it.on = !it.on; render(); } },
            el('img', { src: it.thumb, alt: '' }),
            el('span', { class: 'tray-no' }, String(i + 1)),
            el('span', { class: 'tray-check' }, it.on ? '✓' : ''),
            it.kind === 'pdf' ? el('span', { class: 'tray-badge' }, `PDF ${it.pages} ページ`) : it.fixed ? el('span', { class: 'tray-badge fixed' }, '補正済み') : null,
            el('span', { class: 'tray-name' }, it.name));
          grid.append(tile);
        });
      };
      render();
      if (opt.files && opt.files.length) add(opt.files);
    });
  },
};
