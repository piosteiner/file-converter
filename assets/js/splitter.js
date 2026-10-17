// Map splitter: cuts an image into A4 pages at true printed scale.
//
// The image is divided evenly into cols × rows tiles. Each tile is placed on
// its own A4 page at its real size (pixels ÷ DPI), centred, so the white
// border is about 10 mm. A tile may be up to 1 mm larger than the 190 × 277 mm
// area on each side, so the classic 3366 × 3276 px map still fits 3 × 2 pages.

(function () {
  const A4 = { w: 210, h: 297 };
  const MARGIN = 10;
  const SLACK = 2; // mm a tile may exceed the area inside the border

  const ui = {
    drop: $('#drop'), msg: $('#msg'), work: $('#work'), preview: $('#preview'), facts: $('#facts'),
    dpi: $('#dpi'), exportBtn: $('#export'), another: $('#another'), exportMsg: $('#exportMsg'),
  };
  let img = null;
  let name = 'map';

  const opt = (n) => $(`input[name="${n}"]:checked`).value;
  const mm = (px) => px * 25.4 / dpi();
  const dpi = () => Math.min(600, Math.max(50, Number(ui.dpi.value) || 150));
  const r1 = (v) => (Math.round(v * 10) / 10).toString();

  function layoutFor(orientation) {
    const page = orientation === 'landscape' ? { w: A4.h, h: A4.w } : { ...A4 };
    const inner = { w: page.w - 2 * MARGIN, h: page.h - 2 * MARGIN };
    const W = mm(img.naturalWidth);
    const H = mm(img.naturalHeight);
    const cols = Math.max(1, Math.ceil(W / (inner.w + SLACK)));
    const rows = Math.max(1, Math.ceil(H / (inner.h + SLACK)));
    return { orientation, page, cols, rows, count: cols * rows, tileW: W / cols, tileH: H / rows, W, H };
  }

  function layout() {
    const o = opt('orient');
    if (o !== 'auto') return layoutFor(o);
    const p = layoutFor('portrait');
    const l = layoutFor('landscape');
    return l.count < p.count ? l : p;
  }

  // Pixel edges of column/row i, rounded so neighbouring tiles share an edge.
  const edges = (total, n) => Array.from({ length: n + 1 }, (_, i) => Math.round(i * total / n));

  function drawPreview() {
    const L = layout();
    const box = ui.preview.parentElement;
    const maxW = Math.max(200, box.clientWidth - 34);
    const fit = Math.min(1, maxW / img.naturalWidth, 560 / img.naturalHeight);
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(img.naturalWidth * fit);
    const chh = Math.round(img.naturalHeight * fit);
    ui.preview.width = Math.round(cw * dpr);
    ui.preview.height = Math.round(chh * dpr);
    ui.preview.style.width = `${cw}px`;
    ui.preview.style.height = `${chh}px`;
    const ctx = ui.preview.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, chh);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d9481f';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let c = 1; c < L.cols; c++) { const x = (c / L.cols) * cw; ctx.moveTo(x, 0); ctx.lineTo(x, chh); }
    for (let r = 1; r < L.rows; r++) { const y = (r / L.rows) * chh; ctx.moveTo(0, y); ctx.lineTo(cw, y); }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        const x = ((c + 0.5) / L.cols) * cw;
        const y = ((r + 0.5) / L.rows) * chh;
        const label = `${r + 1}-${c + 1}`;
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(x - tw / 2, y - 11, tw, 22);
        ctx.fillStyle = '#1c1b18';
        ctx.fillText(label, x, y);
      }
    }

    ui.facts.replaceChildren(
      el('dt', {}, 'Image'), el('dd', {}, `${img.naturalWidth} × ${img.naturalHeight} px`),
      el('dt', {}, 'Printed'), el('dd', {}, `${r1(L.W / 10)} × ${r1(L.H / 10)} cm at ${dpi()} DPI`),
      el('dt', {}, 'Pages'), el('dd', { class: L.count > 30 ? 'warn' : '' },
        `${L.cols} × ${L.rows} = ${L.count} A4 ${L.orientation}${L.count > 30 ? ' — check the DPI' : ''}`),
      el('dt', {}, 'Per page'), el('dd', {}, `${r1(L.tileW)} × ${r1(L.tileH)} mm`),
    );
    ui.exportBtn.textContent = opt('out') === 'pdf' ? `Download PDF · ${L.count} pages` : `Download ${L.count} PNG pages`;
  }

  function tileCanvas(L, r, c) {
    const xs = edges(img.naturalWidth, L.cols);
    const ys = edges(img.naturalHeight, L.rows);
    const sw = xs[c + 1] - xs[c];
    const sh = ys[r + 1] - ys[r];
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // JPEG in the PDF has no transparency
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(img, xs[c], ys[r], sw, sh, 0, 0, sw, sh);
    return { canvas, wMm: mm(sw), hMm: mm(sh) };
  }

  async function exportPdf(L) {
    if (!window.jspdf?.jsPDF) throw new Error('The PDF library did not load (offline?). Choose PNG pages instead.');
    const pdf = new window.jspdf.jsPDF({ orientation: L.orientation, unit: 'mm', format: 'a4', compress: true });
    let n = 0;
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        say(ui.exportMsg, `Page ${++n} of ${L.count}…`, 'busy');
        await sleep(0);
        if (n > 1) pdf.addPage('a4', L.orientation);
        const t = tileCanvas(L, r, c);
        const x = (L.page.w - t.wMm) / 2;
        const y = (L.page.h - t.hMm) / 2;
        pdf.addImage(t.canvas.toDataURL('image/jpeg', 0.95), 'JPEG', x, y, t.wMm, t.hMm, undefined, 'FAST');
        t.canvas.width = t.canvas.height = 0;

        const label = `${r + 1}-${c + 1}`;
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(40);
        pdf.text(label, x - 1, y - 1, { align: 'right', baseline: 'bottom' });
        pdf.text(label, x + t.wMm + 1, y - 1, { align: 'left', baseline: 'bottom' });
        pdf.text(label, x - 1, y + t.hMm + 1, { align: 'right', baseline: 'top' });
        pdf.text(label, x + t.wMm + 1, y + t.hMm + 1, { align: 'left', baseline: 'top' });
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(6.5);
        pdf.setTextColor(120);
        pdf.text(`${name} · row ${r + 1} of ${L.rows}, column ${c + 1} of ${L.cols} · print at 100 %`,
          L.page.w / 2, L.page.h - 3.5, { align: 'center' });
      }
    }
    return { blob: pdf.output('blob'), filename: `${name}_${L.cols}x${L.rows}_A4.pdf` };
  }

  async function exportPng(L) {
    const d = dpi();
    const pw = Math.round(L.page.w / 25.4 * d);
    const ph = Math.round(L.page.h / 25.4 * d);
    const fontPx = Math.max(10, Math.round(3 / 25.4 * d));
    const pad = Math.round(1 / 25.4 * d);
    const files = [];
    let n = 0;
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        say(ui.exportMsg, `Page ${++n} of ${L.count}…`, 'busy');
        await sleep(0);
        const t = tileCanvas(L, r, c);
        const page = document.createElement('canvas');
        page.width = pw;
        page.height = ph;
        const ctx = page.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pw, ph);
        const x = Math.round((pw - t.canvas.width) / 2);
        const y = Math.round((ph - t.canvas.height) / 2);
        ctx.drawImage(t.canvas, x, y);

        const label = `${r + 1}-${c + 1}`;
        ctx.fillStyle = '#282828';
        ctx.font = `bold ${fontPx}px Helvetica, Arial, sans-serif`;
        const put = (tx, ty, align, base) => { ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(label, tx, ty); };
        put(x - pad, y - pad, 'right', 'bottom');
        put(x + t.canvas.width + pad, y - pad, 'left', 'bottom');
        put(x - pad, y + t.canvas.height + pad, 'right', 'top');
        put(x + t.canvas.width + pad, y + t.canvas.height + pad, 'left', 'top');

        const blob = await pngWithDpi(await canvasToBlob(page, 'image/png'), d);
        files.push({ name: `${name}_${label}.png`, blob });
        page.width = page.height = t.canvas.width = t.canvas.height = 0;
      }
    }
    return { blob: await makeZip(files), filename: `${name}_${L.cols}x${L.rows}_A4_png.zip` };
  }

  setupDrop(ui.drop, async ([file]) => {
    if (!isImage(file)) return say(ui.msg, 'That is not an image.', 'bad');
    say(ui.msg, 'Loading…', 'busy');
    try {
      img = await loadImage(file);
    } catch (err) {
      return say(ui.msg, err.message, 'bad');
    }
    name = stem(file.name);
    say(ui.msg, '');
    say(ui.exportMsg, '');
    ui.drop.hidden = true;
    ui.work.hidden = false;
    drawPreview();
  });

  ui.another.addEventListener('click', () => {
    img = null;
    ui.work.hidden = true;
    ui.drop.hidden = false;
    ui.drop.focus();
  });

  $$('input[name="orient"], input[name="out"]').forEach((i) => i.addEventListener('change', drawPreview));
  ui.dpi.addEventListener('input', () => { if (img) drawPreview(); });
  window.addEventListener('resize', () => { if (img) drawPreview(); });

  let exportUrl = null; // the last export, kept for its Save link

  ui.exportBtn.addEventListener('click', async () => {
    if (!img) return;
    const L = layout();
    const asPdf = opt('out') === 'pdf';
    // A PDF opens in a new tab so this page stays put (Safari and some PDF settings would otherwise
    // replace it). The tab must be opened now, inside the click, or it counts as a popup.
    const tab = asPdf ? window.open('', '_blank') : null;
    if (tab) tab.document.title = 'Creating the PDF…';
    ui.exportBtn.disabled = true;
    try {
      const { blob, filename } = asPdf ? await exportPdf(L) : await exportPng(L);
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      const url = exportUrl = URL.createObjectURL(blob);
      if (tab && !tab.closed) tab.location.href = url;
      else download(blob, filename);
      say(ui.exportMsg, `${tab ? 'Opened' : 'Saved'} ${filename} · ${formatBytes(blob.size)} · `, 'ok');
      ui.exportMsg.append(el('a', { href: url, download: filename }, 'Save'));
    } catch (err) {
      if (tab) tab.close();
      say(ui.exportMsg, err.message, 'bad');
    } finally {
      ui.exportBtn.disabled = false;
    }
  });
})();
