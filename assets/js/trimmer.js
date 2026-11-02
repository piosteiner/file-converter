// Shared by the GIF / Video → WebM tool and the video trimmer: requests to api.piogino.ch with progress,
// and the timeline trimmer (server-made preview, selection handles, looping playback, kept upload).

const API = 'https://api.piogino.ch';
const MAX_UPLOAD = 100 * 1024 * 1024;
const isVideoFile = (f) => /\.(mkv|mp4|mov)$/i.test(f.name);

// XMLHttpRequest rather than fetch: it reports upload and download progress.
// onProgress(phase, fraction): 'upload' 0…1, 'server' once the upload is done, 'download' 0…1.
function apiRequest(path, { body, timeout = 180_000, as = 'json', onProgress } = {}) {
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

// Progress of one server job in the message line msg: upload %, encoding % (polled from the server), download %.
// The WebM encoder tries stricter quality settings until the file fits the size limit, so encoding may run more than once.
function apiTracker(msg, label, { verb = 'Converting', poll = true } = {}) {
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
    say(msg, label ? `${label} · ${what}` : what, 'busy');
  };
  const check = async () => {
    if (stopped) return;
    try {
      const p = await apiRequest(`/api/progress/${job}`, { timeout: 5000 });
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

// Shows a notice with a retry button in box if the conversion server is down.
async function checkApi(box) {
  const problem = (text) => {
    box.hidden = false;
    box.replaceChildren(text, ' ', el('button', { class: 'btn ghost small', type: 'button', onclick: () => {
      box.replaceChildren(el('span', { class: 'busy-line', text: 'Checking…' }));
      checkApi(box);
    } }, 'Try again'));
  };
  try {
    const h = await apiRequest('/api/health', { timeout: 8000 });
    if (h.ffmpeg_available && h.converter_available) { box.hidden = true; return; }
    problem('The server is up but its converter is not available right now.');
  } catch {
    problem('The conversion server is not reachable right now.');
  }
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

// The trimmer on a page with the editor markup (#editor, #video, #track, #start, #end, …; #pingpong, #sound optional).
// options:
//   controls()            the page's own inputs, disabled with the trimmer's while it is busy
//   initialEnd(duration)  where the selection ends when a file opens (default: the whole clip)
//   lengthHint(played)    text under the length when the selection is too long, else ''
//   onRange()             called whenever the selection or ping-pong changes
//   onClose()             called when the trimmer closes
function createTrimmer({ controls = () => [], initialEnd = (d) => d, lengthHint = () => '', onRange = () => {}, onClose = () => {} } = {}) {
  const MIN_LEN = 0.1;
  const ui = {
    drop: $('#drop'), msg: $('#msg'),
    editor: $('#editor'), edName: $('#edName'), edClose: $('#edClose'),
    video: $('#video'), still: $('#still'),
    track: $('#track'), sel: $('#sel'), hStart: $('#hStart'), hEnd: $('#hEnd'), head: $('#head'), tlTotal: $('#tlTotal'),
    play: $('#play'), start: $('#start'), end: $('#end'), len: $('#len'), lenHint: $('#lenHint'), pingpong: $('#pingpong'),
    sound: $('#sound'),
  };
  const ed = {
    file: null, duration: 0, start: 0, end: 0, videoUrl: null, stillUrl: null, canSeek: false, raf: 0,
    playing: true, reversing: false, last: 0, source: null,
    holding: false, holdTimer: 0, // holding: paused on the frame at a selection edge while it is being moved
  };
  const pingpong = () => Boolean(ui.pingpong?.checked);

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
    const keep = isVideoFile(file) && ed.file === file ? crypto.randomUUID() : null;
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

  function close() {
    cancelAnimationFrame(ed.raf);
    ui.video.pause();
    ui.video.removeAttribute('src');
    ui.video.load();
    if (ed.videoUrl) URL.revokeObjectURL(ed.videoUrl);
    if (ed.stillUrl) URL.revokeObjectURL(ed.stillUrl);
    forgetSource();
    onClose();
    Object.assign(ed, { file: null, duration: 0, videoUrl: null, stillUrl: null, canSeek: false, playing: true, reversing: false, last: 0 });
    ui.play.textContent = 'Pause';
    setSound(false);
    ui.editor.hidden = true;
    ui.drop.hidden = false;
  }

  // Uploads the file for a WebM preview (a video stays on the server for later requests) and shows it.
  // fallbackDuration: length to trim by numbers if the preview fails; still: show the file itself then (GIFs).
  // audio: preview with the video's sound, behind the #sound button (browsers only autoplay muted video).
  // Resolves to false if the trimmer was closed meanwhile.
  async function open(file, { fallbackDuration = () => videoDuration(file), still = false, audio = false } = {}) {
    close();
    ed.file = file;
    ui.edName.textContent = `${file.name} · ${formatBytes(file.size)}`;
    ui.drop.hidden = true;
    ui.editor.hidden = false;
    ui.video.hidden = true;
    ui.still.hidden = true;
    setBusy(true);

    const localDuration = await fallbackDuration().catch(() => 0);
    let previewError = null;
    const t = apiTracker(ui.msg, 'Preparing the preview', { verb: 'Encoding' });
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('job', t.job);
      const keep = isVideoFile(file) ? crypto.randomUUID() : null;
      if (keep) form.append('keep', keep);
      if (audio) form.append('audio', 'true');
      const webm = await apiRequest('/convert/gif-to-webm', { body: form, as: 'blob', timeout: 300_000, onProgress: t.onProgress });
      t.stop();
      ed.source = keep;
      if (ed.file !== file) { forgetSource(); return false; } // closed meanwhile
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
    if (ed.file !== file) return false;

    let muted = false;
    if (ed.canSeek) {
      ed.duration = ui.video.duration;
      ui.video.hidden = false;
      // Sound on if the browser lets it autoplay (it does once the person has clicked on the page), else muted.
      setSound(audio);
      try {
        await ui.video.play();
      } catch {
        muted = audio;
        setSound(false);
        ui.video.play().catch(() => {});
      }
      if (ed.file !== file) return false;
    } else {
      // No scrubbing, but trimming by numbers and handles still works.
      ed.duration = localDuration;
      if (still) {
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
      say(ui.msg, `${still ? 'Showing the GIF itself' : 'No preview'} — ${previewError.message} Trim with the handles or numbers.`, '');
    } else if (muted) {
      say(ui.msg, 'The browser started the preview muted. Press Sound or M to hear it.', '');
    } else {
      say(ui.msg, '');
    }
    ui.head.hidden = !ed.canSeek;
    ui.play.hidden = !ed.canSeek;
    if (ui.sound) ui.sound.hidden = !(audio && ed.canSeek);
    ui.tlTotal.textContent = `${ed.duration.toFixed(2)} s`;
    ui.start.max = ui.end.max = ed.duration.toFixed(2);
    setRange(0, Math.min(ed.duration, initialEnd(ed.duration)));
    tick();
    return true;
  }

  function setBusy(busy) {
    [ui.start, ui.end, ui.pingpong, ...$$('[data-preset]'), ...controls()].forEach((b) => { if (b) b.disabled = busy; });
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

    const played = (end - start) * (pingpong() ? 2 : 1);
    ui.len.textContent = `${played.toFixed(2)} s`;
    const hint = lengthHint(played);
    ui.len.classList.toggle('over', Boolean(hint));
    ui.lenHint.textContent = hint;
    if (seek && ed.canSeek && (ui.video.currentTime < start || ui.video.currentTime > end)) ui.video.currentTime = start;
    onRange();
  }

  // Keep the preview looping inside the selection. With ping-pong it plays forward, then backwards:
  // browsers can't play video in reverse, so the backward half steps back by seeking each frame.
  function tick(now = performance.now()) {
    cancelAnimationFrame(ed.raf);
    if (!ed.file) return;
    const dt = Math.min(0.1, (now - (ed.last || now)) / 1000);
    ed.last = now;
    if (ed.canSeek) {
      const v = ui.video;
      if (!pingpong()) ed.reversing = false;
      if (!ed.playing || ed.holding) {
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
          if (pingpong()) { ed.reversing = true; v.pause(); v.currentTime = ed.end; }
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
    if (target !== 'seek') hold();

    // While an edge moves, the preview stands still on the clip's first frame (start, move) or last frame (end).
    const move = (ev) => {
      const t = timeAt(ev.clientX);
      if (target === 'start') { setRange(t, ed.end, { seek: false }); showEdge('start'); }
      else if (target === 'end') { setRange(ed.start, t, { seek: false }); showEdge('end'); }
      else if (target === 'move') {
        const len = e0 - s0;
        const s = Math.max(0, Math.min(ed.duration - len, s0 + (t - t0)));
        setRange(s, s + len, { seek: false });
        showEdge('start');
      } else if (ed.canSeek) {
        ui.video.currentTime = Math.max(ed.start, Math.min(ed.end, t));
      }
    };
    const up = () => {
      ui.sel.classList.remove('dragging');
      ui.track.removeEventListener('pointermove', move);
      ui.track.removeEventListener('pointerup', up);
      ui.track.removeEventListener('pointercancel', up);
      if (target !== 'seek') release();
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
    if (which === 'start') setRange(ed.start + delta, ed.end, { seek: false });
    else setRange(ed.start, ed.end + delta, { seek: false });
    peek(which);
  }));

  ui.start.addEventListener('change', () => { setRange(Number(ui.start.value) || 0, ed.end, { seek: false }); peek('start'); });
  ui.end.addEventListener('change', () => { setRange(ed.start, Number(ui.end.value) || ed.duration, { seek: false }); peek('end'); });

  // The last frame of the clip is the one just before its end.
  function showEdge(which) {
    if (ed.canSeek) ui.video.currentTime = which === 'end' ? Math.max(ed.start, ed.end - 0.001) : ed.start;
  }
  function hold() {
    clearTimeout(ed.holdTimer);
    ed.holding = true;
    ed.reversing = false;
  }
  function release() {
    clearTimeout(ed.holdTimer);
    ed.holding = false;
    if (ed.canSeek) ui.video.currentTime = ed.start;
  }
  // Keyboard and number edits: show the edge for a moment, then play on.
  function peek(which) {
    hold();
    showEdge(which);
    ed.holdTimer = setTimeout(release, 1200);
  }
  ui.pingpong?.addEventListener('change', () => setRange(ed.start, ed.end, { seek: false }));
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.preset;
    setRange(0, p === 'all' ? ed.duration : Number(p));
  }));

  ui.edClose.addEventListener('click', () => { close(); say(ui.msg, ''); });

  function setSound(on) {
    ui.video.muted = !on;
    if (on && ui.msg.textContent.startsWith('The browser started the preview muted')) say(ui.msg, '');
    if (ui.sound) {
      ui.sound.textContent = on ? 'Sound on' : 'Sound off';
      ui.sound.setAttribute('aria-pressed', String(on));
    }
  }
  ui.sound?.addEventListener('click', () => setSound(ui.video.muted));

  // ed.playing is what the button asks for; tick() starts, pauses and reverses the video to match.
  function setPlaying(on) {
    ed.playing = on;
    ui.play.textContent = on ? 'Pause' : 'Play';
  }
  ui.play.addEventListener('click', () => setPlaying(!ed.playing));

  // Keys while the trimmer is open (not while typing in a field):
  // Space play/pause · ←/→ one frame (Shift: 1 s) · I/O start/end at the playhead · Home/End selection edges · M sound.
  const FRAME = 1 / 30; // the preview runs at 30 fps at most
  document.addEventListener('keydown', (e) => {
    if (!ed.file || !ed.canSeek || ui.editor.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.('input, select, textarea, [contenteditable]') || t === ui.hStart || t === ui.hEnd) return;
    const v = ui.video;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === ' ') {
      setPlaying(!ed.playing);
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      setPlaying(false);
      const step = (e.shiftKey ? 1 : FRAME) * (key === 'ArrowLeft' ? -1 : 1);
      v.currentTime = Math.max(0, Math.min(ed.duration, v.currentTime + step));
    } else if (key === 'i') {
      setRange(v.currentTime, ed.end, { seek: false });
    } else if (key === 'o') {
      setRange(ed.start, v.currentTime, { seek: false });
    } else if (key === 'Home' || key === 'End') {
      setPlaying(false);
      showEdge(key === 'Home' ? 'start' : 'end');
    } else if (key === 'm' && ui.sound && !ui.sound.hidden) {
      setSound(v.muted);
    } else {
      return;
    }
    e.preventDefault(); // also keeps Space from pressing a focused button
  });

  return {
    ed, open, close, setBusy, setRange, withSource,
    hideSound() { if (ui.sound) { setSound(false); ui.sound.hidden = true; } },
    pingpong,
    needsTrim: () => ed.start > 0.01 || ed.end < ed.duration - 0.01 || pingpong(),
    // Runs job with the editor disabled; errors end up in the message line.
    async busy(text, job) {
      setBusy(true);
      say(ui.msg, text, 'busy');
      try { await job(); } catch (err) { say(ui.msg, err.message, 'bad'); } finally { setBusy(false); }
    },
  };
}
