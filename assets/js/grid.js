// Square grid PNG at a fixed print scale, with the DPI written into the file.

(function () {
  const ui = {
    preset: $('#preset'), custom: $('#customSize'), w: $('#w'), h: $('#h'),
    square: $('#square'), dpi: $('#dpi'), color: $('#color'),
    opacity: $('#opacity'), opacityOut: $('#opacityOut'),
    line: $('#line'), lineOut: $('#lineOut'),
    every: $('#every'), bold: $('#bold'), boldOut: $('#boldOut'), boldField: $('#boldField'),
    preview: $('#preview'), facts: $('#facts'), download: $('#download'), msg: $('#msg'),
  };
  const MAX_PIXELS = 16_777_216; // iOS Safari's canvas limit
  let unit = 'px';
  let size = { w: 3366, h: 4914 };

  const dpi = () => Math.min(600, Math.max(50, Number(ui.dpi.value) || 150));
  const toPx = (mm) => Math.round(mm / 25.4 * dpi());
  const toMm = (px) => px * 25.4 / dpi();
  const mm1 = (v) => (Math.round(v * 10) / 10).toString();

  function settings() {
    return {
      w: size.w, h: size.h,
      step: (Number(ui.square.value) || 25) / 25.4 * dpi(),
      color: ui.color.value,
      alpha: Number(ui.opacity.value) / 100,
      line: Number(ui.line.value),
      every: Number(ui.every.value),
      bold: Number(ui.bold.value),
    };
  }

  // Draws opaque lines; opacity is applied once afterwards so crossings
  // don't come out darker than the lines.
  function drawLines(ctx, s, scale) {
    const W = Math.round(s.w * scale);
    const H = Math.round(s.h * scale);
    ctx.fillStyle = s.color;
    const pass = (bold) => {
      const lw = Math.max(1, Math.round((bold ? s.bold : s.line) * scale));
      const off = Math.floor(lw / 2);
      for (let i = 0; ; i++) {
        if (bold && (!s.every || i % s.every)) continue;
        const p = Math.round(i * s.step);
        if (p > s.w && p > s.h) break;
        const q = Math.round(p * scale);
        if (p <= s.w) ctx.fillRect(q - off, 0, lw, H);
        if (p <= s.h) ctx.fillRect(0, q - off, W, lw);
      }
    };
    pass(false);
    if (s.every) pass(true);
  }

  function render(s, scale) {
    const lines = document.createElement('canvas');
    lines.width = Math.max(1, Math.round(s.w * scale));
    lines.height = Math.max(1, Math.round(s.h * scale));
    drawLines(lines.getContext('2d'), s, scale);
    if (s.alpha >= 1) return lines;
    const out = document.createElement('canvas');
    out.width = lines.width;
    out.height = lines.height;
    const ctx = out.getContext('2d');
    ctx.globalAlpha = s.alpha;
    ctx.drawImage(lines, 0, 0);
    return out;
  }

  function updatePreview() {
    const s = settings();
    const box = ui.preview.parentElement;
    const maxW = Math.max(200, box.clientWidth - 34);
    const maxH = Math.max(240, Math.min(620, window.innerHeight * 0.7));
    const fit = Math.min(1, maxW / s.w, maxH / s.h);
    const dpr = window.devicePixelRatio || 1;
    const img = render(s, fit * dpr);
    ui.preview.width = img.width;
    ui.preview.height = img.height;
    ui.preview.style.width = `${Math.round(s.w * fit)}px`;
    ui.preview.style.height = `${Math.round(s.h * fit)}px`;
    ui.preview.getContext('2d').drawImage(img, 0, 0);

    const tooBig = s.w * s.h > MAX_PIXELS;
    ui.facts.replaceChildren(
      el('dt', {}, 'Pixels'), el('dd', { class: tooBig ? 'warn' : '' }, `${s.w} × ${s.h}${tooBig ? ' — too large for iPad/iPhone' : ''}`),
      el('dt', {}, 'Printed'), el('dd', {}, `${mm1(toMm(s.w))} × ${mm1(toMm(s.h))} mm at ${dpi()} DPI`),
      el('dt', {}, 'Squares'), el('dd', {}, `${mm1(s.w / s.step)} × ${mm1(s.h / s.step)} · ${mm1(s.step)} px each`),
    );
  }

  let pending = 0;
  const schedule = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(updatePreview); };

  function readCustom() {
    const w = Number(ui.w.value);
    const h = Number(ui.h.value);
    if (!(w > 0 && h > 0)) return;
    size = unit === 'mm' ? { w: toPx(w), h: toPx(h) } : { w: Math.round(w), h: Math.round(h) };
  }

  function fillCustom() {
    ui.w.value = unit === 'mm' ? mm1(toMm(size.w)) : size.w;
    ui.h.value = unit === 'mm' ? mm1(toMm(size.h)) : size.h;
  }

  ui.preset.addEventListener('change', () => {
    const custom = ui.preset.value === 'custom';
    ui.custom.hidden = !custom;
    if (custom) fillCustom();
    else { const [w, h] = ui.preset.value.split('x').map(Number); size = { w, h }; }
    schedule();
  });
  [ui.w, ui.h].forEach((i) => i.addEventListener('input', () => { readCustom(); schedule(); }));
  $$('input[name="unit"]').forEach((r) => r.addEventListener('change', () => {
    readCustom();
    unit = r.value;
    fillCustom();
  }));
  ui.dpi.addEventListener('change', () => {
    if (ui.preset.value === 'custom') readCustom();
    schedule();
  });

  const echo = (input, out, suffix) => input.addEventListener('input', () => { out.value = `${input.value} ${suffix}`; schedule(); });
  echo(ui.opacity, ui.opacityOut, '%');
  echo(ui.line, ui.lineOut, 'px');
  echo(ui.bold, ui.boldOut, 'px');
  ui.every.addEventListener('change', () => { ui.boldField.hidden = ui.every.value === '0'; schedule(); });
  [ui.square, ui.color].forEach((i) => i.addEventListener('input', schedule));
  window.addEventListener('resize', schedule);

  ui.download.addEventListener('click', async () => {
    const s = settings();
    if (s.w * s.h > 40_000_000) return say(ui.msg, 'That is too large for a browser canvas. Use a smaller size.', 'bad');
    ui.download.disabled = true;
    say(ui.msg, 'Drawing the full-size grid…', 'busy');
    try {
      await sleep(30); // let the message paint
      const blob = await pngWithDpi(await canvasToBlob(render(s, 1), 'image/png'), dpi());
      const sq = mm1(Number(ui.square.value) || 25);
      download(blob, `grid-${sq}mm-${s.w}x${s.h}-${dpi()}dpi.png`);
      say(ui.msg, `Saved · ${formatBytes(blob.size)}`, 'ok');
    } catch (err) {
      say(ui.msg, err.message, 'bad');
    } finally {
      ui.download.disabled = false;
    }
  });

  updatePreview();
})();
