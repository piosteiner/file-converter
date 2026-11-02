// GIF or video (OBS .mkv, .mp4, .mov) → WebM / GIF via api.piogino.ch. One file opens the trimmer, several convert directly.

(function () {
  const LIMIT_S = 3;

  const ui = {
    server: $('#server'), drop: $('#drop'), msg: $('#msg'),
    maxSize: $('#maxSize'), maxSizeOut: $('#maxSizeOut'),
    toWebm: $('#toWebm'), toGif: $('#toGif'), gifOpts: $('#gifOpts'), gifWidth: $('#gifWidth'), gifFps: $('#gifFps'),
    gifPreviewBtn: $('#gifPreviewBtn'), gifPreview: $('#gifPreview'), gifImg: $('#gifImg'), gifMeta: $('#gifMeta'),
    cropReset: $('#cropReset'), cropInfo: $('#cropInfo'),
    layoutSize: $('#layoutSize'), layoutX: $('#layoutX'), layoutY: $('#layoutY'),
    layoutSizeOut: $('#layoutSizeOut'), layoutXOut: $('#layoutXOut'), layoutYOut: $('#layoutYOut'), layoutReset: $('#layoutReset'),
    tgChat: $('#tgChat'), tgEdges: $('#tgEdges'), tgCaption: $('#tgCaption'),
    video: $('#video'), still: $('#still'),
  };
  const results = new Results($('#results'), { zipName: 'webm.zip' });
  const mode = () => $('input[name="mode"]:checked').value;
  const isGif = (f) => /gif$/i.test(f.type) || /\.gif$/i.test(f.name);

  const trimmer = createTrimmer({
    controls: () => [ui.toWebm, ui.toGif, ui.gifWidth, ui.gifFps, ui.gifPreviewBtn, ui.cropReset, ...$$('input[name="cropShape"]'),
      ui.layoutSize, ui.layoutX, ui.layoutY, ui.layoutReset, ...$$('input[name="frame"]')],
    initialEnd: (d) => (d > LIMIT_S ? LIMIT_S : d),
    lengthHint: (played) => (played > LIMIT_S + 0.005
      ? `Longer than ${LIMIT_S} s${trimmer.pingpong() ? ' with ping-pong' : ''} — the WebM will be cut at ${LIMIT_S} s.`
      : ''),
    onRange: () => gifSettingsChanged(),
    onClose: () => { hideGifPreview(); cropper.show(false); frame = null; cancelAnimationFrame(chatRaf); },
  });
  const ed = trimmer.ed;

  // ---------- crop ----------

  const cropper = createCropper({ wrap: $('#cropWrap'), box: $('#cropBox'), onChange: () => { describeCrop(); gifSettingsChanged(); describeLayout(); } });
  const cropValue = () => cropper.get()?.map((v) => v.toFixed(5)).join(',') ?? '';
  let frame = null; // source size { width, height } of the open file, when known

  // Crop size in source pixels and what Telegram gets: the longer side is scaled to exactly 512 (emoji: 100 × 100).
  function describeCrop() {
    const c = cropper.get() ?? [0, 0, 1, 1];
    const what = cropper.get() ? 'Crop' : 'Full frame';
    if (!frame) { ui.cropInfo.textContent = cropper.get() ? `${what} ${Math.round(c[2] * 100)} % × ${Math.round(c[3] * 100)} %` : ''; return; }
    const w = Math.round(c[2] * frame.width);
    const h = Math.round(c[3] * frame.height);
    const target = mode() === 'emoji' ? 100 : 512;
    const out = mode() === 'emoji' ? '100 × 100'
      : w >= h ? `512 × ${Math.round((h * 512) / w / 2) * 2}` : `${Math.round((w * 512) / h / 2) * 2} × 512`;
    const small = Math.max(w, h) < target;
    ui.cropInfo.textContent = `${what} ${w} × ${h} px → ${mode() === 'emoji' ? 'emoji' : 'sticker'} ${out}${small ? ` · under ${target} px, so it gets enlarged and looks softer` : ''}`;
    ui.cropInfo.classList.toggle('warn', small);
  }

  $$('input[name="cropShape"]').forEach((r) => r.addEventListener('change', () => cropper.setSquare(r.value === 'square' && r.checked)));
  ui.cropReset.addEventListener('click', () => {
    $('input[name="cropShape"][value="free"]').checked = true;
    cropper.reset();
  });
  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { describeCrop(); describeLayout(); }));

  // ---------- sticker layout ----------
  // Telegram shows every sticker inside the same square, so a wide sticker looks small and a square one big.
  // Transparent space around the content shrinks it and moves it towards a side. Same maths as the server's
  // sticker_layout() in server/gif_to_webm.py: keep the two in step.

  const STICKER_BOX = 224; // CSS px Telegram Desktop gives a sticker, roughly
  const EMOJI_BOX = 20;    // custom emoji inside a line of text
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const sticker = () => mode() !== 'emoji';
  const layout = () => ({
    square: $('input[name="frame"]:checked').value === 'square',
    size: ui.layoutSize.value / 100,
    x: ui.layoutX.value / 100,
    y: ui.layoutY.value / 100,
  });
  // Sent with a WebM only when it differs from the plain fit (tight frame, full size, centred).
  const layoutValue = () => {
    const l = layout();
    if (!l.square && l.size === 1 && l.x === 0.5 && l.y === 0.5) return '';
    return [l.square ? 'square' : 'tight', l.size, l.x, l.y].join(',');
  };

  // { cw, ch, w, h, left, top }: canvas and content size in sticker pixels, for content of width × height.
  function stickerLayout(width, height) {
    const { square, size, x, y } = layout();
    let cw; let ch;
    if (!sticker()) { cw = ch = 100; } else if (square) { cw = ch = 512; } else if (width >= height) { cw = 512; ch = even((512 * height) / width); } else { cw = even((512 * width) / height); ch = 512; }
    const scale = Math.min((cw * size) / width, (ch * size) / height);
    const w = Math.min(cw, even(width * scale));
    const h = Math.min(ch, even(height * scale));
    return { cw, ch, w, h, left: Math.round(((cw - w) * x) / 2) * 2, top: Math.round(((ch - h) * y) / 2) * 2 };
  }

  // Size of the cropped content: in source pixels when known, else in the preview's (same shape).
  function contentSize() {
    const src = ui.video.hidden ? ui.still : ui.video;
    const fw = frame?.width || src.videoWidth || src.naturalWidth || 0;
    const fh = frame?.height || src.videoHeight || src.naturalHeight || 0;
    const c = cropper.get() ?? [0, 0, 1, 1];
    return fw && fh ? { width: Math.max(2, Math.round(c[2] * fw)), height: Math.max(2, Math.round(c[3] * fh)), src, c } : null;
  }

  const placeName = (v, [a, mid, b]) => (v === 0 ? a : v === 50 ? mid : v === 100 ? b : `${v} %`);

  function describeLayout() {
    ui.layoutSizeOut.value = `${ui.layoutSize.value} %`;
    ui.layoutXOut.value = placeName(Number(ui.layoutX.value), ['left', 'center', 'right']);
    ui.layoutYOut.value = placeName(Number(ui.layoutY.value), ['top', 'middle', 'bottom']);
    $$('input[name="frame"]').forEach((r) => { r.disabled = !sticker() || !ed.file || ui.toWebm.disabled; });
    // Position only matters where there is room to move.
    const c = contentSize();
    const l = c ? stickerLayout(c.width, c.height) : null;
    ui.layoutX.disabled = !l || l.w >= l.cw || ui.toWebm.disabled;
    ui.layoutY.disabled = !l || l.h >= l.ch || ui.toWebm.disabled;
    ui.tgChat.classList.toggle('emoji', !sticker());
    ui.tgCaption.textContent = sticker()
      ? `Telegram-style preview, approximate: stickers show inside a ${STICKER_BOX} px square, aligned to the sender's side.${l ? ` This one: ${l.cw} × ${l.ch}, content ${l.w} × ${l.h}.` : ''}`
      : 'Telegram-style preview, approximate: custom emoji sit in the text at about the height of a line.';
  }

  [ui.layoutSize, ui.layoutX, ui.layoutY, ...$$('input[name="frame"]')].forEach((i) => i.addEventListener('input', describeLayout));
  $$('input[name="frame"]').forEach((i) => i.addEventListener('change', describeLayout));
  ui.layoutReset.addEventListener('click', () => {
    $('input[name="frame"][value="tight"]').checked = true;
    ui.layoutSize.value = 100;
    ui.layoutX.value = ui.layoutY.value = 50;
    describeLayout();
  });
  ui.tgEdges.addEventListener('change', () => ui.tgChat.classList.toggle('edges', ui.tgEdges.checked));

  // Draws the current preview frame into every sticker / emoji canvas of the chat, laid out like the WebM will be.
  let chatRaf = 0;
  function drawChat() {
    cancelAnimationFrame(chatRaf);
    if (!ed.file) return;
    const c = contentSize();
    if (c) {
      const l = stickerLayout(c.width, c.height);
      const dpr = window.devicePixelRatio || 1;
      const sw = c.src.videoWidth || c.src.naturalWidth;
      const sh = c.src.videoHeight || c.src.naturalHeight;
      const canvases = sticker() ? $$('.tg-sticker canvas', ui.tgChat) : $$('.tg-emoji', ui.tgChat);
      const box = sticker() ? STICKER_BOX : EMOJI_BOX;
      // Telegram fits the whole sticker (canvas, transparent parts included) into its square.
      const dw = (box * l.cw) / Math.max(l.cw, l.ch);
      const dh = (box * l.ch) / Math.max(l.cw, l.ch);
      for (const cv of canvases) {
        const pw = Math.round(dw * dpr);
        const ph = Math.round(dh * dpr);
        if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; cv.style.width = `${dw}px`; cv.style.height = `${dh}px`; }
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, pw, ph);
        if (sw && sh) {
          const k = pw / l.cw;
          ctx.drawImage(c.src, c.c[0] * sw, c.c[1] * sh, c.c[2] * sw, c.c[3] * sh, l.left * k, l.top * k, l.w * k, l.h * k);
        }
      }
    }
    chatRaf = requestAnimationFrame(drawChat);
  }

  // Width and height from the GIF header (logical screen size).
  async function gifSize(file) {
    const b = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    return b.length === 10 ? { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) } : null;
  }

  ui.maxSize.addEventListener('input', () => { ui.maxSizeOut.value = `${ui.maxSize.value} KB`; });

  // ---------- server ----------

  async function toWebm(blob, filename, label = '', crop = '', layoutField = '') {
    const t = apiTracker(ui.msg, label);
    try {
      const form = new FormData();
      form.append('file', blob, filename);
      if (crop) form.append('crop', crop);
      if (layoutField) form.append('layout', layoutField);
      return await convertForm(form, t, null);
    } finally {
      t.stop();
    }
  }

  // Video in the trimmer: same as toWebm, but from the kept copy on the server.
  // trim: { start, end, pingpong } — the server cuts videos itself (a GIF in between would cost quality).
  async function sourceToWebm(file, trim, crop, layoutField) {
    const t = apiTracker(ui.msg, '');
    try {
      return await trimmer.withSource(file, (form) => {
        if (crop) form.append('crop', crop);
        if (layoutField) form.append('layout', layoutField);
        return form;
      }, (form) => convertForm(form, t, trim));
    } finally {
      t.stop();
    }
  }

  // Adds the conversion settings to form (which holds the file or source id), converts and downloads the WebM.
  async function convertForm(form, t, trim) {
    form.append('max_size', ui.maxSize.value);
    form.append('mode', mode());
    form.append('job', t.job);
    if (trim) {
      form.append('start', trim.start.toFixed(3));
      form.append('end', trim.end.toFixed(3));
      if (trim.pingpong) form.append('pingpong', 'true');
    }
    const info = await apiRequest('/api/convert', { body: form, onProgress: t.onProgress });
    if (!info.success) throw new Error(info.error || 'Conversion failed.');
    const webm = await apiRequest(`/api/download/${encodeURIComponent(info.download_id)}`, { as: 'blob', timeout: 60_000, onProgress: t.onProgress });
    return { webm, info };
  }

  // GIF of the selection. Videos also take the GIF width and frame rate. quiet: no progress in the message line.
  async function trimGif(file, start, end, pingpong, { quiet = false, crop = '' } = {}) {
    const t = quiet ? null : apiTracker(ui.msg, '', { verb: 'Trimming', poll: false });
    try {
      return await trimmer.withSource(file, (form) => {
        form.append('start', start.toFixed(3));
        form.append('end', end.toFixed(3));
        if (pingpong) form.append('pingpong', 'true');
        if (crop) form.append('crop', crop);
        if (isVideoFile(file)) {
          form.append('width', ui.gifWidth.value);
          form.append('fps', ui.gifFps.value);
        }
        return form;
      }, (form) => apiRequest('/edit/trim-gif', { body: form, as: 'blob', onProgress: t?.onProgress }));
    } finally {
      t?.stop();
    }
  }

  const webmName = (file) => `${stem(file.name)}${mode() === 'emoji' ? '_emoji' : ''}.webm`;
  const webmMeta = (info, blob) => {
    const dims = info.output_width ? `${info.output_width} × ${info.output_height} · ` : '';
    const dur = info.output_duration ? `${info.output_duration.toFixed(2)} s · ` : '';
    return `${dims}${dur}${formatBytes(blob.size)}`;
  };

  // ---------- drop ----------

  setupDrop(ui.drop, async (files) => {
    const gifs = files.filter((f) => isGif(f) || isVideoFile(f));
    if (!gifs.length) return say(ui.msg, 'Only GIF, MKV, MP4 and MOV files work here.', 'bad');
    const big = gifs.find((f) => f.size > MAX_UPLOAD);
    if (big) return say(ui.msg, `${big.name} is larger than 100 MB.`, 'bad');
    if (gifs.length === 1) return openEditor(gifs[0]);

    trimmer.close();
    results.clear();
    ui.drop.classList.add('busy');
    let ok = 0;
    for (const [i, file] of gifs.entries()) {
      try {
        const { webm, info } = await toWebm(file, file.name, `${i + 1} of ${gifs.length} — ${file.name}`);
        results.add({ name: webmName(file), blob: webm, meta: webmMeta(info, webm) });
        ok++;
      } catch (err) {
        results.fail(file.name, err.message);
      }
    }
    ui.drop.classList.remove('busy');
    if (ok > 1) await results.downloadAll();
    else if (ok === 1) download(results.items[0].blob, results.items[0].name);
    say(ui.msg, ok ? `${ok} of ${gifs.length} converted.` : 'None of the files could be converted.', ok ? 'ok' : 'bad');
  });

  // ---------- trimmer ----------

  // GIF preview: gif = { key, blob, url }, shown while wanted
  const gifState = { gif: null, wanted: false, timer: 0, run: 0 };

  // Total play time of a GIF from its frame delays, without decoding images.
  async function gifDuration(file) {
    const b = new Uint8Array(await file.arrayBuffer());
    if (b.length < 13 || String.fromCharCode(...b.subarray(0, 3)) !== 'GIF') return 0;
    let p = 13;
    if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
    const skipBlocks = () => { while (p < b.length && b[p]) p += b[p] + 1; p++; };
    let total = 0;
    let delay = 0;
    while (p < b.length) {
      const id = b[p++];
      if (id === 0x21) {
        if (b[p] === 0xf9) delay = b[p + 3] | (b[p + 4] << 8);
        p++;
        skipBlocks();
      } else if (id === 0x2c) {
        total += delay < 2 ? 10 : delay; // browsers play 0/1 as 100 ms
        delay = 0;
        const packed = b[p + 8];
        p += 9;
        if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
        p++; // LZW code size
        skipBlocks();
      } else break;
    }
    return total / 100;
  }

  async function openEditor(file) {
    results.clear();
    const video = isVideoFile(file);
    ui.gifOpts.hidden = !video;
    ui.toGif.textContent = video ? 'Save as GIF' : 'Save trimmed GIF';
    $('input[name="cropShape"][value="free"]').checked = true;
    cropper.reset({ notify: false });
    ui.cropInfo.textContent = '';
    if (!await trimmer.open(file, video ? {} : { fallbackDuration: () => gifDuration(file), still: true })) return;
    cropper.show(true);
    drawChat();
    try {
      frame = video ? (ed.source ? await apiRequest(`/api/source/${ed.source}/info`, { timeout: 15_000 }) : null) : await gifSize(file);
    } catch { frame = null; }
    if (ed.file === file) { describeCrop(); describeLayout(); }
  }

  // ---------- GIF preview (videos) ----------
  // Renders the real GIF on the server, so width, frame rate, colours and file size are what Save as GIF gives.
  // Once shown, it follows the selection and settings, re-rendering after a short pause.

  const gifKey = () => [ed.start.toFixed(3), ed.end.toFixed(3), trimmer.pingpong(), ui.gifWidth.value, ui.gifFps.value, cropValue()].join('|');
  const gifName = (file) => `${stem(file.name)}_${ed.start.toFixed(1)}-${ed.end.toFixed(1)}s${trimmer.pingpong() ? '_pingpong' : ''}.gif`;

  function hideGifPreview() {
    clearTimeout(gifState.timer);
    gifState.run++;
    if (gifState.gif) URL.revokeObjectURL(gifState.gif.url);
    gifState.gif = null;
    gifState.wanted = false;
    ui.gifPreview.hidden = true;
    ui.gifImg.removeAttribute('src');
    ui.gifPreviewBtn.textContent = 'Preview GIF';
  }

  function gifSettingsChanged() {
    if (!gifState.wanted || gifState.gif?.key === gifKey()) return;
    ui.gifMeta.textContent = 'Settings changed — updating…';
    ui.gifPreview.classList.add('stale');
    clearTimeout(gifState.timer);
    gifState.timer = setTimeout(renderGifPreview, 700);
  }

  async function renderGifPreview() {
    clearTimeout(gifState.timer);
    const file = ed.file;
    const key = gifKey();
    const run = ++gifState.run;
    ui.gifPreview.hidden = false;
    ui.gifPreview.classList.add('stale');
    ui.gifMeta.textContent = 'Rendering the GIF…';
    try {
      const blob = await trimGif(file, ed.start, ed.end, trimmer.pingpong(), { quiet: true, crop: cropValue() });
      if (run !== gifState.run) return; // settings changed or closed meanwhile
      if (gifState.gif) URL.revokeObjectURL(gifState.gif.url);
      gifState.gif = { key, blob, url: URL.createObjectURL(blob) };
      ui.gifImg.src = gifState.gif.url;
      await ui.gifImg.decode().catch(() => {});
      if (run !== gifState.run) return;
      const played = (ed.end - ed.start) * (trimmer.pingpong() ? 2 : 1);
      ui.gifMeta.textContent = `${ui.gifImg.naturalWidth} × ${ui.gifImg.naturalHeight} · ${ui.gifFps.value} fps · ${played.toFixed(2)} s · ${formatBytes(blob.size)}`;
      ui.gifPreview.classList.remove('stale');
      if (gifState.gif.key !== gifKey()) gifSettingsChanged(); // moved on while rendering
    } catch (err) {
      if (run === gifState.run) ui.gifMeta.textContent = `No GIF preview: ${err.message}`;
    }
  }

  ui.gifPreviewBtn.addEventListener('click', () => {
    if (gifState.wanted) return hideGifPreview();
    gifState.wanted = true;
    ui.gifPreviewBtn.textContent = 'Hide GIF preview';
    renderGifPreview();
  });
  [ui.gifWidth, ui.gifFps].forEach((s) => s.addEventListener('change', gifSettingsChanged));

  ui.toWebm.addEventListener('click', () => trimmer.busy('Converting…', async () => {
    const file = ed.file;
    let source = file;
    let trim = null;
    if (isVideoFile(file)) {
      if (trimmer.needsTrim()) trim = { start: ed.start, end: ed.end, pingpong: trimmer.pingpong() };
    } else if (trimmer.needsTrim()) {
      say(ui.msg, 'Trimming…', 'busy');
      source = await trimGif(file, ed.start, ed.end, trimmer.pingpong());
      say(ui.msg, 'Converting…', 'busy');
    }
    const { webm, info } = isVideoFile(file) ? await sourceToWebm(file, trim, cropValue(), layoutValue()) : await toWebm(source, file.name, '', cropValue(), layoutValue());
    const name = webmName(file);
    results.clear();
    results.add({ name, blob: webm, meta: webmMeta(info, webm) });
    download(webm, name);
    say(ui.msg, `Saved ${name}.`, 'ok');
  }).then(describeLayout));

  ui.toGif.addEventListener('click', () => trimmer.busy('Trimming…', async () => {
    const file = ed.file;
    const gif = gifState.gif?.key === gifKey() ? gifState.gif.blob : await trimGif(file, ed.start, ed.end, trimmer.pingpong(), { crop: cropValue() });
    const name = gifName(file);
    results.clear();
    results.add({ name, blob: gif, thumb: true, meta: formatBytes(gif.size) });
    download(gif, name);
    say(ui.msg, `Saved ${name}.`, 'ok');
  }).then(describeLayout));

  checkApi(ui.server);
})();
