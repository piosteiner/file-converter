// GIF → WebM via api.piogino.ch. One GIF opens the trimmer, several convert directly.

(function () {
  const API = 'https://api.piogino.ch';
  const MAX_UPLOAD = 100 * 1024 * 1024;
  const MIN_LEN = 0.1;
  const LIMIT_S = 3;

  const ui = {
    server: $('#server'), drop: $('#drop'), msg: $('#msg'),
    maxSize: $('#maxSize'), maxSizeOut: $('#maxSizeOut'),
    editor: $('#editor'), edName: $('#edName'), edClose: $('#edClose'),
    video: $('#video'), still: $('#still'),
    track: $('#track'), sel: $('#sel'), hStart: $('#hStart'), hEnd: $('#hEnd'), head: $('#head'), tlTotal: $('#tlTotal'),
    play: $('#play'), start: $('#start'), end: $('#end'), len: $('#len'), lenHint: $('#lenHint'), pingpong: $('#pingpong'),
    toWebm: $('#toWebm'), toGif: $('#toGif'),
  };
  const results = new Results($('#results'), { zipName: 'webm.zip' });
  const mode = () => $('input[name="mode"]:checked').value;
  const isGif = (f) => /gif$/i.test(f.type) || /\.gif$/i.test(f.name);

  ui.maxSize.addEventListener('input', () => { ui.maxSizeOut.value = `${ui.maxSize.value} KB`; });

  // ---------- server ----------

  async function request(path, { body, timeout = 180_000, as = 'json' } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(API + path, { method: body ? 'POST' : 'GET', body, signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error || ''; } catch { /* not JSON */ }
        throw new Error(detail || `Server answered ${res.status}.`);
      }
      return as === 'blob' ? await res.blob() : await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The server took too long to answer.');
      if (err instanceof TypeError) throw new Error('Could not reach the server. Check your connection.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkServer() {
    try {
      const h = await request('/api/health', { timeout: 8000 });
      if (h.ffmpeg_available && h.converter_available) { ui.server.hidden = true; return; }
      showServerProblem('The server is up but its converter is not available right now.');
    } catch {
      showServerProblem('The conversion server is not reachable right now.');
    }
  }

  function showServerProblem(text) {
    ui.server.hidden = false;
    ui.server.replaceChildren(text, ' ', el('button', { class: 'btn ghost small', type: 'button', onclick: () => {
      ui.server.replaceChildren(el('span', { class: 'busy-line', text: 'Checking…' }));
      checkServer();
    } }, 'Try again'));
  }

  async function toWebm(blob, filename) {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('max_size', ui.maxSize.value);
    form.append('mode', mode());
    const info = await request('/api/convert', { body: form });
    if (!info.success) throw new Error(info.error || 'Conversion failed.');
    const webm = await request(`/api/download/${encodeURIComponent(info.download_id)}`, { as: 'blob', timeout: 60_000 });
    return { webm, info };
  }

  async function trimGif(file, start, end, pingpong) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('start', start.toFixed(3));
    form.append('end', end.toFixed(3));
    if (pingpong) form.append('pingpong', 'true');
    return request('/edit/trim-gif', { body: form, as: 'blob' });
  }

  const webmName = (file) => `${stem(file.name)}${mode() === 'emoji' ? '_emoji' : ''}.webm`;
  const webmMeta = (info, blob) => {
    const dims = info.output_width ? `${info.output_width} × ${info.output_height} · ` : '';
    const dur = info.output_duration ? `${info.output_duration.toFixed(2)} s · ` : '';
    return `${dims}${dur}${formatBytes(blob.size)}`;
  };

  // ---------- drop ----------

  setupDrop(ui.drop, async (files) => {
    const gifs = files.filter(isGif);
    if (!gifs.length) return say(ui.msg, 'Only GIF files work here.', 'bad');
    const big = gifs.find((f) => f.size > MAX_UPLOAD);
    if (big) return say(ui.msg, `${big.name} is larger than 100 MB.`, 'bad');
    if (gifs.length === 1) return openEditor(gifs[0]);

    closeEditor();
    results.clear();
    ui.drop.classList.add('busy');
    let ok = 0;
    for (const [i, file] of gifs.entries()) {
      say(ui.msg, `Converting ${i + 1} of ${gifs.length} — ${file.name}`, 'busy');
      try {
        const { webm, info } = await toWebm(file, file.name);
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

  const ed = { file: null, duration: 0, start: 0, end: 0, videoUrl: null, stillUrl: null, canSeek: false, raf: 0 };

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

  function closeEditor() {
    cancelAnimationFrame(ed.raf);
    ui.video.pause();
    ui.video.removeAttribute('src');
    ui.video.load();
    if (ed.videoUrl) URL.revokeObjectURL(ed.videoUrl);
    if (ed.stillUrl) URL.revokeObjectURL(ed.stillUrl);
    Object.assign(ed, { file: null, duration: 0, videoUrl: null, stillUrl: null, canSeek: false });
    ui.editor.hidden = true;
    ui.drop.hidden = false;
  }

  async function openEditor(file) {
    closeEditor();
    results.clear();
    ed.file = file;
    ui.edName.textContent = `${file.name} · ${formatBytes(file.size)}`;
    ui.drop.hidden = true;
    ui.editor.hidden = false;
    ui.video.hidden = true;
    ui.still.hidden = true;
    setBusy(true);
    say(ui.msg, 'Preparing the preview…', 'busy');

    const localDuration = await gifDuration(file).catch(() => 0);
    let previewError = null;
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const webm = await request('/convert/gif-to-webm', { body: form, as: 'blob', timeout: 120_000 });
      if (ed.file !== file) return; // closed meanwhile
      ed.videoUrl = URL.createObjectURL(webm);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 10_000);
        ui.video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
        ui.video.onerror = () => { clearTimeout(t); reject(new Error('This browser cannot play the WebM preview.')); };
        ui.video.src = ed.videoUrl;
      });
      ed.canSeek = Number.isFinite(ui.video.duration) && ui.video.duration > 0;
    } catch (err) {
      previewError = err;
    }
    if (ed.file !== file) return;

    if (ed.canSeek) {
      ed.duration = ui.video.duration;
      ui.video.hidden = false;
      ui.video.play().catch(() => {});
    } else {
      // No scrubbing, but trimming by numbers and handles still works.
      ed.duration = localDuration;
      ed.stillUrl = URL.createObjectURL(file);
      ui.still.src = ed.stillUrl;
      ui.still.hidden = false;
    }
    setBusy(false);

    if (!ed.duration) {
      say(ui.msg, previewError ? `No preview: ${previewError.message}` : 'Could not read the length of this GIF.', 'bad');
      ed.duration = 3;
    } else if (previewError) {
      say(ui.msg, `Showing the GIF itself — ${previewError.message} Trim with the handles or numbers.`, '');
    } else {
      say(ui.msg, '');
    }
    ui.head.hidden = !ed.canSeek;
    ui.play.hidden = !ed.canSeek;
    ui.tlTotal.textContent = `${ed.duration.toFixed(2)} s`;
    ui.start.max = ui.end.max = ed.duration.toFixed(2);
    setRange(0, Math.min(ed.duration, ed.duration > LIMIT_S ? LIMIT_S : ed.duration));
    tick();
  }

  function setBusy(busy) {
    [ui.toWebm, ui.toGif, ui.start, ui.end, ui.pingpong, ...$$('[data-preset]')].forEach((b) => { b.disabled = busy; });
  }

  function setRange(start, end, { seek = true } = {}) {
    const d = ed.duration;
    start = Math.max(0, Math.min(start, d - MIN_LEN));
    end = Math.min(d, Math.max(end, start + MIN_LEN));
    ed.start = start;
    ed.end = end;
    ui.sel.style.left = `${(start / d) * 100}%`;
    ui.sel.style.width = `${((end - start) / d) * 100}%`;
    ui.hStart.setAttribute('aria-valuenow', start.toFixed(2));
    ui.hEnd.setAttribute('aria-valuenow', end.toFixed(2));
    if (document.activeElement !== ui.start) ui.start.value = start.toFixed(2);
    if (document.activeElement !== ui.end) ui.end.value = end.toFixed(2);

    const len = end - start;
    const played = ui.pingpong.checked ? len * 2 : len;
    ui.len.textContent = `${played.toFixed(2)} s`;
    const over = played > LIMIT_S + 0.005;
    ui.len.classList.toggle('over', over);
    ui.lenHint.textContent = over
      ? `Longer than ${LIMIT_S} s${ui.pingpong.checked ? ' with ping-pong' : ''} — the WebM will be cut at ${LIMIT_S} s.`
      : '';
    if (seek && ed.canSeek && (ui.video.currentTime < start || ui.video.currentTime > end)) ui.video.currentTime = start;
  }

  // Keep the preview looping inside the selection.
  function tick() {
    cancelAnimationFrame(ed.raf);
    if (!ed.file) return;
    if (ed.canSeek) {
      const t = ui.video.currentTime;
      if (!ui.video.paused && (t >= ed.end - 0.02 || t < ed.start - 0.05)) ui.video.currentTime = ed.start;
      ui.head.style.left = `${(t / ed.duration) * 100}%`;
    }
    ed.raf = requestAnimationFrame(tick);
  }

  // Pointer dragging: handles move one edge, the selection moves as a whole,
  // the bare track seeks.
  function timeAt(clientX) {
    const r = ui.track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * ed.duration;
  }

  ui.track.addEventListener('pointerdown', (e) => {
    if (!ed.file || e.button > 0) return;
    const target = e.target === ui.hStart ? 'start' : e.target === ui.hEnd ? 'end' : e.target === ui.sel ? 'move' : 'seek';
    const t0 = timeAt(e.clientX);
    const s0 = ed.start;
    const e0 = ed.end;
    ui.track.setPointerCapture(e.pointerId);
    if (target === 'move') ui.sel.classList.add('dragging');

    const move = (ev) => {
      const t = timeAt(ev.clientX);
      if (target === 'start') { setRange(t, ed.end, { seek: false }); if (ed.canSeek) ui.video.currentTime = ed.start; }
      else if (target === 'end') { setRange(ed.start, t, { seek: false }); if (ed.canSeek) ui.video.currentTime = Math.max(ed.start, ed.end - 0.05); }
      else if (target === 'move') {
        const len = e0 - s0;
        const s = Math.max(0, Math.min(ed.duration - len, s0 + (t - t0)));
        setRange(s, s + len);
      } else if (ed.canSeek) {
        ui.video.currentTime = Math.max(ed.start, Math.min(ed.end, t));
      }
    };
    const up = () => {
      ui.sel.classList.remove('dragging');
      ui.track.removeEventListener('pointermove', move);
      ui.track.removeEventListener('pointerup', up);
      ui.track.removeEventListener('pointercancel', up);
      if (ed.canSeek && target !== 'seek') ui.video.currentTime = ed.start;
    };
    ui.track.addEventListener('pointermove', move);
    ui.track.addEventListener('pointerup', up);
    ui.track.addEventListener('pointercancel', up);
    move(e);
  });

  [[ui.hStart, 'start'], [ui.hEnd, 'end']].forEach(([h, which]) => h.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.5 : 0.05;
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    if (which === 'start') setRange(ed.start + delta, ed.end);
    else setRange(ed.start, ed.end + delta);
  }));

  ui.start.addEventListener('change', () => setRange(Number(ui.start.value) || 0, ed.end));
  ui.end.addEventListener('change', () => setRange(ed.start, Number(ui.end.value) || ed.duration));
  ui.pingpong.addEventListener('change', () => setRange(ed.start, ed.end, { seek: false }));
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.preset;
    setRange(0, p === 'all' ? ed.duration : Number(p));
  }));

  ui.play.addEventListener('click', () => {
    if (ui.video.paused) ui.video.play(); else ui.video.pause();
  });
  ui.video.addEventListener('play', () => { ui.play.textContent = 'Pause'; });
  ui.video.addEventListener('pause', () => { ui.play.textContent = 'Play'; });
  ui.edClose.addEventListener('click', () => { closeEditor(); say(ui.msg, ''); });

  const needsTrim = () => ed.start > 0.01 || ed.end < ed.duration - 0.01 || ui.pingpong.checked;

  async function withEditorBusy(text, job) {
    setBusy(true);
    say(ui.msg, text, 'busy');
    try { await job(); } catch (err) { say(ui.msg, err.message, 'bad'); } finally { setBusy(false); }
  }

  ui.toWebm.addEventListener('click', () => withEditorBusy('Converting…', async () => {
    const file = ed.file;
    let source = file;
    if (needsTrim()) {
      say(ui.msg, 'Trimming…', 'busy');
      source = await trimGif(file, ed.start, ed.end, ui.pingpong.checked);
      say(ui.msg, 'Converting…', 'busy');
    }
    const { webm, info } = await toWebm(source, file.name);
    const name = webmName(file);
    results.clear();
    results.add({ name, blob: webm, meta: webmMeta(info, webm) });
    download(webm, name);
    say(ui.msg, `Saved ${name}.`, 'ok');
  }));

  ui.toGif.addEventListener('click', () => withEditorBusy('Trimming…', async () => {
    const file = ed.file;
    const gif = await trimGif(file, ed.start, ed.end, ui.pingpong.checked);
    const name = `${stem(file.name)}_${ed.start.toFixed(1)}-${ed.end.toFixed(1)}s${ui.pingpong.checked ? '_pingpong' : ''}.gif`;
    results.clear();
    results.add({ name, blob: gif, thumb: true, meta: formatBytes(gif.size) });
    download(gif, name);
    say(ui.msg, `Saved ${name}.`, 'ok');
  }));

  checkServer();
})();
