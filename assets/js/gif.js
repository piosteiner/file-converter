// GIF or video (OBS .mkv, .mp4, .mov) → WebM / GIF via api.piogino.ch. One file opens the trimmer, several convert directly.

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
    toWebm: $('#toWebm'), toGif: $('#toGif'), gifOpts: $('#gifOpts'), gifWidth: $('#gifWidth'), gifFps: $('#gifFps'),
    gifPreviewBtn: $('#gifPreviewBtn'), gifPreview: $('#gifPreview'), gifImg: $('#gifImg'), gifMeta: $('#gifMeta'),
  };
  const results = new Results($('#results'), { zipName: 'webm.zip' });
  const mode = () => $('input[name="mode"]:checked').value;
  const isGif = (f) => /gif$/i.test(f.type) || /\.gif$/i.test(f.name);
  const isVideo = (f) => /\.(mkv|mp4|mov)$/i.test(f.name);

  ui.maxSize.addEventListener('input', () => { ui.maxSizeOut.value = `${ui.maxSize.value} KB`; });

  // ---------- server ----------

  // XMLHttpRequest rather than fetch: it reports upload and download progress.
  // onProgress(phase, fraction): 'upload' 0…1, 'server' once the upload is done, 'download' 0…1.
  function request(path, { body, timeout = 180_000, as = 'json', onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(body ? 'POST' : 'GET', API + path);
      xhr.responseType = as === 'blob' ? 'blob' : 'text';
      xhr.timeout = timeout;
      if (onProgress) {
        if (body) {
          xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress('upload', e.loaded / e.total); };
          xhr.upload.onload = () => onProgress('server');
        }
        xhr.onprogress = (e) => { if (e.lengthComputable && as === 'blob') onProgress('download', e.loaded / e.total); };
      }
      xhr.onload = async () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          let data = {};
          try { data = JSON.parse(as === 'blob' ? await xhr.response.text() : xhr.responseText); } catch { /* not JSON */ }
          reject(Object.assign(new Error(data.error || `Server answered ${xhr.status}.`), { data }));
        } else if (as === 'blob') {
          resolve(xhr.response);
        } else {
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('The server sent an unexpected answer.')); }
        }
      };
      xhr.ontimeout = () => reject(new Error('The server took too long to answer.'));
      xhr.onerror = () => reject(new Error('Could not reach the server. Check your connection.'));
      xhr.send(body || null);
    });
  }

  // Progress of one server job in the message line: upload %, encoding % (polled from the server), download %.
  // The server tries stricter quality settings until the file fits the size limit, so encoding may run more than once.
  function tracker(label, { verb = 'Converting', poll = true } = {}) {
    const job = crypto.randomUUID();
    let stage = 'upload';
    let pct = 0;
    let attempt = 1;
    let timer = 0;
    let stopped = false;
    const render = () => {
      const what = stage === 'upload' ? `Uploading ${pct} %`
        : stage === 'encoding' ? `${verb} ${pct} %${attempt > 1 ? ` · try ${attempt}, the last result was over the size limit` : ''}`
          : stage === 'download' ? `Downloading ${pct} %`
            : `${verb}…`;
      say(ui.msg, label ? `${label} · ${what}` : what, 'busy');
    };
    const check = async () => {
      if (stopped) return;
      try {
        const p = await request(`/api/progress/${job}`, { timeout: 5000 });
        if (!stopped && p.stage === 'encoding' && (stage === 'server' || stage === 'encoding')) {
          stage = 'encoding';
          pct = p.percent;
          attempt = p.attempt;
          render();
        }
      } catch { /* a missed poll is fine */ }
      if (!stopped) timer = setTimeout(check, 500);
    };
    render();
    return {
      job,
      onProgress(phase, fraction) {
        if (stopped) return;
        if (phase === 'upload') {
          stage = 'upload';
          pct = Math.round(fraction * 100);
        } else if (phase === 'server') {
          if (stage !== 'upload') return;
          stage = 'server';
          if (poll) check();
        } else {
          clearTimeout(timer);
          stage = 'download';
          pct = Math.round(fraction * 100);
        }
        render();
      },
      stop() { stopped = true; clearTimeout(timer); },
    };
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

  // The video open in the trimmer stays on the server (ed.source) after its preview, so later requests send
  // only its id. build(form) adds the other fields; if the server has dropped the video (1 hour unused),
  // upload it again and let the server keep that copy.
  async function withSource(file, build, send) {
    if (ed.source && ed.file === file) {
      const form = build(new FormData());
      form.append('source', ed.source);
      form.append('name', file.name);
      try { return await send(form); } catch (err) {
        if (!err.data?.source_expired) throw err;
        ed.source = null;
      }
    }
    const form = build(new FormData());
    form.append('file', file, file.name);
    const keep = isVideo(file) && ed.file === file ? crypto.randomUUID() : null;
    if (keep) form.append('keep', keep);
    let result;
    try { result = await send(form); } catch (err) {
      if (keep) navigator.sendBeacon(`${API}/api/source/${keep}/delete`);
      throw err;
    }
    if (keep && ed.file === file) ed.source = keep;
    else if (keep) navigator.sendBeacon(`${API}/api/source/${keep}/delete`); // closed meanwhile
    return result;
  }

  function forgetSource() {
    if (!ed.source) return;
    navigator.sendBeacon(`${API}/api/source/${ed.source}/delete`);
    ed.source = null;
  }
  window.addEventListener('pagehide', forgetSource);

  async function toWebm(blob, filename, label = '') {
    const t = tracker(label);
    try {
      const form = new FormData();
      form.append('file', blob, filename);
      return await convertForm(form, t, null);
    } finally {
      t.stop();
    }
  }

  // Video in the trimmer: same as toWebm, but from the kept copy on the server.
  // trim: { start, end, pingpong } — the server cuts videos itself (a GIF in between would cost quality).
  async function sourceToWebm(file, trim) {
    const t = tracker('');
    try {
      return await withSource(file, (form) => form, (form) => convertForm(form, t, trim));
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
    const info = await request('/api/convert', { body: form, onProgress: t.onProgress });
    if (!info.success) throw new Error(info.error || 'Conversion failed.');
    const webm = await request(`/api/download/${encodeURIComponent(info.download_id)}`, { as: 'blob', timeout: 60_000, onProgress: t.onProgress });
    return { webm, info };
  }

  // GIF of the selection. Videos also take the GIF width and frame rate. quiet: no progress in the message line.
  async function trimGif(file, start, end, pingpong, { quiet = false } = {}) {
    const t = quiet ? null : tracker('', { verb: 'Trimming', poll: false });
    try {
      return await withSource(file, (form) => {
        form.append('start', start.toFixed(3));
        form.append('end', end.toFixed(3));
        if (pingpong) form.append('pingpong', 'true');
        if (isVideo(file)) {
          form.append('width', ui.gifWidth.value);
          form.append('fps', ui.gifFps.value);
        }
        return form;
      }, (form) => request('/edit/trim-gif', { body: form, as: 'blob', onProgress: t?.onProgress }));
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
    const gifs = files.filter((f) => isGif(f) || isVideo(f));
    if (!gifs.length) return say(ui.msg, 'Only GIF, MKV, MP4 and MOV files work here.', 'bad');
    const big = gifs.find((f) => f.size > MAX_UPLOAD);
    if (big) return say(ui.msg, `${big.name} is larger than 100 MB.`, 'bad');
    if (gifs.length === 1) return openEditor(gifs[0]);

    closeEditor();
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

  const ed = {
    file: null, duration: 0, start: 0, end: 0, videoUrl: null, stillUrl: null, canSeek: false, raf: 0,
    playing: true, reversing: false, last: 0, source: null,
    gif: null, gifWanted: false, gifTimer: 0, gifRun: 0, // GIF preview: { key, blob, url }, shown while gifWanted
  };

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

  // Length of a video from the browser's own player; 0 if it can't read the container (MKV in some browsers).
  function videoDuration(file) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(file);
      const done = (d) => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(Number.isFinite(d) ? d : 0); };
      const timer = setTimeout(() => done(0), 5000);
      v.preload = 'metadata';
      v.onloadedmetadata = () => done(v.duration);
      v.onerror = () => done(0);
      v.src = url;
    });
  }

  function closeEditor() {
    cancelAnimationFrame(ed.raf);
    ui.video.pause();
    ui.video.removeAttribute('src');
    ui.video.load();
    if (ed.videoUrl) URL.revokeObjectURL(ed.videoUrl);
    if (ed.stillUrl) URL.revokeObjectURL(ed.stillUrl);
    forgetSource();
    hideGifPreview();
    Object.assign(ed, { file: null, duration: 0, videoUrl: null, stillUrl: null, canSeek: false, playing: true, reversing: false, last: 0 });
    ui.play.textContent = 'Pause';
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
    ui.gifOpts.hidden = !isVideo(file);
    ui.toGif.textContent = isVideo(file) ? 'Save as GIF' : 'Save trimmed GIF';
    setBusy(true);

    const localDuration = await (isVideo(file) ? videoDuration(file) : gifDuration(file)).catch(() => 0);
    let previewError = null;
    const t = tracker('Preparing the preview', { verb: 'Encoding' });
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('job', t.job);
      const keep = isVideo(file) ? crypto.randomUUID() : null;
      if (keep) form.append('keep', keep);
      const webm = await request('/convert/gif-to-webm', { body: form, as: 'blob', timeout: 300_000, onProgress: t.onProgress });
      t.stop();
      ed.source = keep;
      if (ed.file !== file) { forgetSource(); return; } // closed meanwhile
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
    } finally {
      t.stop();
    }
    if (ed.file !== file) return;

    if (ed.canSeek) {
      ed.duration = ui.video.duration;
      ui.video.hidden = false;
      ui.video.play().catch(() => {});
    } else {
      // No scrubbing, but trimming by numbers and handles still works.
      ed.duration = localDuration;
      if (!isVideo(file)) {
        ed.stillUrl = URL.createObjectURL(file);
        ui.still.src = ed.stillUrl;
        ui.still.hidden = false;
      }
    }
    setBusy(false);

    if (!ed.duration) {
      say(ui.msg, previewError ? `No preview: ${previewError.message}` : 'Could not read the length of this file.', 'bad');
      ed.duration = 3;
    } else if (previewError) {
      say(ui.msg, `${isVideo(ed.file) ? 'No preview' : 'Showing the GIF itself'} — ${previewError.message} Trim with the handles or numbers.`, '');
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
    [ui.toWebm, ui.toGif, ui.start, ui.end, ui.pingpong, ui.gifWidth, ui.gifFps, ui.gifPreviewBtn, ...$$('[data-preset]')].forEach((b) => { b.disabled = busy; });
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
    gifSettingsChanged();
  }

  // ---------- GIF preview (videos) ----------
  // Renders the real GIF on the server, so width, frame rate, colours and file size are what Save as GIF gives.
  // Once shown, it follows the selection and settings, re-rendering after a short pause.

  const gifKey = () => [ed.start.toFixed(3), ed.end.toFixed(3), ui.pingpong.checked, ui.gifWidth.value, ui.gifFps.value].join('|');
  const gifName = (file) => `${stem(file.name)}_${ed.start.toFixed(1)}-${ed.end.toFixed(1)}s${ui.pingpong.checked ? '_pingpong' : ''}.gif`;

  function hideGifPreview() {
    clearTimeout(ed.gifTimer);
    ed.gifRun++;
    if (ed.gif) URL.revokeObjectURL(ed.gif.url);
    ed.gif = null;
    ed.gifWanted = false;
    ui.gifPreview.hidden = true;
    ui.gifImg.removeAttribute('src');
    ui.gifPreviewBtn.textContent = 'Preview GIF';
  }

  function gifSettingsChanged() {
    if (!ed.gifWanted || ed.gif?.key === gifKey()) return;
    ui.gifMeta.textContent = 'Settings changed — updating…';
    ui.gifPreview.classList.add('stale');
    clearTimeout(ed.gifTimer);
    ed.gifTimer = setTimeout(renderGifPreview, 700);
  }

  async function renderGifPreview() {
    clearTimeout(ed.gifTimer);
    const file = ed.file;
    const key = gifKey();
    const run = ++ed.gifRun;
    ui.gifPreview.hidden = false;
    ui.gifPreview.classList.add('stale');
    ui.gifMeta.textContent = 'Rendering the GIF…';
    try {
      const blob = await trimGif(file, ed.start, ed.end, ui.pingpong.checked, { quiet: true });
      if (run !== ed.gifRun) return; // settings changed or closed meanwhile
      if (ed.gif) URL.revokeObjectURL(ed.gif.url);
      ed.gif = { key, blob, url: URL.createObjectURL(blob) };
      ui.gifImg.src = ed.gif.url;
      await ui.gifImg.decode().catch(() => {});
      if (run !== ed.gifRun) return;
      const played = (ed.end - ed.start) * (ui.pingpong.checked ? 2 : 1);
      ui.gifMeta.textContent = `${ui.gifImg.naturalWidth} × ${ui.gifImg.naturalHeight} · ${ui.gifFps.value} fps · ${played.toFixed(2)} s · ${formatBytes(blob.size)}`;
      ui.gifPreview.classList.remove('stale');
      if (ed.gif.key !== gifKey()) gifSettingsChanged(); // moved on while rendering
    } catch (err) {
      if (run === ed.gifRun) ui.gifMeta.textContent = `No GIF preview: ${err.message}`;
    }
  }

  ui.gifPreviewBtn.addEventListener('click', () => {
    if (ed.gifWanted) return hideGifPreview();
    ed.gifWanted = true;
    ui.gifPreviewBtn.textContent = 'Hide GIF preview';
    renderGifPreview();
  });
  [ui.gifWidth, ui.gifFps].forEach((s) => s.addEventListener('change', gifSettingsChanged));

  // Keep the preview looping inside the selection. With ping-pong it plays forward, then backwards:
  // browsers can't play video in reverse, so the backward half steps back by seeking each frame.
  function tick(now = performance.now()) {
    cancelAnimationFrame(ed.raf);
    if (!ed.file) return;
    const dt = Math.min(0.1, (now - (ed.last || now)) / 1000);
    ed.last = now;
    if (ed.canSeek) {
      const v = ui.video;
      if (!ui.pingpong.checked) ed.reversing = false;
      if (!ed.playing) {
        if (!v.paused) v.pause();
      } else if (ed.reversing) {
        if (!v.paused) v.pause();
        if (!v.seeking) {
          const t = v.currentTime - dt;
          if (t <= ed.start) {
            ed.reversing = false;
            v.currentTime = ed.start;
            v.play().catch(() => {});
          } else {
            v.currentTime = t;
          }
        }
      } else {
        // The end is checked before resuming: at the very end of the clip the video stops by itself (no loop attribute).
        const t = v.currentTime;
        if (t < ed.start - 0.05) v.currentTime = ed.start;
        else if (t >= ed.end - 0.02) {
          if (ui.pingpong.checked) { ed.reversing = true; v.pause(); v.currentTime = ed.end; }
          else v.currentTime = ed.start;
        } else if (v.paused && !v.seeking) v.play().catch(() => {});
      }
      ui.head.style.left = `${(v.currentTime / ed.duration) * 100}%`;
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

  // ed.playing is what the button asks for; tick() starts, pauses and reverses the video to match.
  ui.play.addEventListener('click', () => {
    ed.playing = !ed.playing;
    ui.play.textContent = ed.playing ? 'Pause' : 'Play';
  });
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
    let trim = null;
    if (isVideo(file)) {
      if (needsTrim()) trim = { start: ed.start, end: ed.end, pingpong: ui.pingpong.checked };
    } else if (needsTrim()) {
      say(ui.msg, 'Trimming…', 'busy');
      source = await trimGif(file, ed.start, ed.end, ui.pingpong.checked);
      say(ui.msg, 'Converting…', 'busy');
    }
    const { webm, info } = isVideo(file) ? await sourceToWebm(file, trim) : await toWebm(source, file.name);
    const name = webmName(file);
    results.clear();
    results.add({ name, blob: webm, meta: webmMeta(info, webm) });
    download(webm, name);
    say(ui.msg, `Saved ${name}.`, 'ok');
  }));

  ui.toGif.addEventListener('click', () => withEditorBusy('Trimming…', async () => {
    const file = ed.file;
    const gif = ed.gif?.key === gifKey() ? ed.gif.blob : await trimGif(file, ed.start, ed.end, ui.pingpong.checked);
    const name = gifName(file);
    results.clear();
    results.add({ name, blob: gif, thumb: true, meta: formatBytes(gif.size) });
    download(gif, name);
    say(ui.msg, `Saved ${name}.`, 'ok');
  }));

  checkServer();
})();
