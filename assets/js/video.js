// Video trim via api.piogino.ch: cut the start and end off a screen recording (OBS .mkv, .mp4, .mov), save as MP4.

(function () {
  const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
  const FRAME_RATES = [60, 50, 30, 25, 24, 15];
  const BITRATES = [20000, 12000, 8000, 6000, 4000, 2500, 1500, 800, 500]; // video kbit/s

  const ui = {
    server: $('#server'), drop: $('#drop'), msg: $('#msg'),
    height: $('#height'), fps: $('#fps'), bitrate: $('#bitrate'), audio: $('#audio'),
    outHint: $('#outHint'), save: $('#save'), estimate: $('#estimate'),
  };
  const results = new Results($('#results'));
  const cut = () => $('input[name="cut"]:checked').value;
  const settings = [ui.height, ui.fps, ui.bitrate];

  // What the server reports about the open video: width, height, fps, video_kbps, audio_kbps, codecs. null if unknown.
  let src = null;

  const trimmer = createTrimmer({
    controls: () => [ui.save, ui.audio, ...settings, ...$$('input[name="cut"]')],
    onRange: () => describeOutput(),
    onClose: () => { src = null; },
  });
  const ed = trimmer.ed;

  const mbit = (kbps) => `${(kbps / 1000).toFixed(kbps < 1000 ? 2 : 1)} Mbit/s`;
  const option = (value, text) => el('option', { value }, text);

  // Only settings below the source's are offered; "Original" keeps it as it is.
  function fillSettings() {
    const s = src;
    ui.height.replaceChildren(option('', s ? `Original · ${s.width} × ${s.height}` : 'Original'),
      ...(s ? HEIGHTS.filter((h) => h < s.height).map((h) => option(h, `${h}p · ${Math.round((s.width * h) / s.height / 2) * 2} × ${h}`)) : []));
    ui.fps.replaceChildren(option('', s?.fps ? `Original · ${+s.fps.toFixed(2)} fps` : 'Original'),
      ...(s?.fps ? FRAME_RATES.filter((f) => f < s.fps - 0.5).map((f) => option(f, `${f} fps`)) : []));
    ui.bitrate.replaceChildren(option('', s ? `Original · ≈ ${mbit(s.video_kbps)}` : 'Original'),
      ...(s ? BITRATES.filter((b) => b < s.video_kbps * 0.9).map((b) => option(b, mbit(b))) : []));
    ui.audio.checked = !s || Boolean(s.audio_codec);
  }

  // The settings line and the estimated size, and which settings apply (trimmer.setBusy enables them all).
  // Estimates come from the bit rates; exact at the original bit rate is capped at the source's, so still scenes come out smaller.
  function describeOutput() {
    const copy = cut() === 'copy';
    settings.forEach((s) => { s.disabled = copy || ui.save.disabled; if (copy) s.value = ''; });
    ui.audio.disabled = ui.save.disabled || Boolean(src && !src.audio_codec);
    const len = ed.end - ed.start;
    ui.outHint.textContent = copy
      ? 'Copy keeps the recording as it is and is instant, but the clip starts on the keyframe before your start — up to a few seconds early.'
      : src ? `Recording: ${src.width} × ${src.height} · ${+src.fps.toFixed(2)} fps · ≈ ${mbit(src.video_kbps)} ${src.video_codec?.toUpperCase() ?? ''}${src.audio_codec ? ` · sound ${src.audio_codec.toUpperCase()}` : ' · no sound'}` : '';
    if (!src || !(len > 0)) { ui.estimate.textContent = ''; return; }
    const videoKbps = Number(ui.bitrate.value) || src.video_kbps;
    const audioKbps = ui.audio.checked ? src.audio_kbps : 0;
    const bytes = ((videoKbps + audioKbps) * 1000 / 8) * len;
    ui.estimate.textContent = `≈ ${formatBytes(bytes)}`;
  }

  [...settings, ui.audio, ...$$('input[name="cut"]')].forEach((s) => s.addEventListener('change', describeOutput));

  setupDrop(ui.drop, async (files) => {
    const videos = files.filter(isVideoFile);
    if (!videos.length) return say(ui.msg, 'Only MKV, MP4 and MOV files work here.', 'bad');
    const file = videos[0];
    if (file.size > MAX_UPLOAD) return say(ui.msg, `${file.name} is larger than 100 MB.`, 'bad');
    results.clear();
    src = null;
    fillSettings();
    describeOutput();
    if (!await trimmer.open(file, { audio: true })) return;
    if (ed.source) {
      try {
        src = await apiRequest(`/api/source/${ed.source}/info`, { timeout: 15_000 });
      } catch { /* settings stay at Original */ }
      if (ed.file !== file) return;
    }
    if (src && !src.audio_codec) trimmer.hideSound();
    fillSettings();
    describeOutput();
  });

  ui.save.addEventListener('click', () => trimmer.busy('Trimming…', async () => {
    const file = ed.file;
    const copy = cut() === 'copy';
    const t = apiTracker(ui.msg, '', { verb: copy ? 'Cutting' : 'Encoding' });
    let blob;
    try {
      blob = await trimmer.withSource(file, (form) => {
        form.append('start', ed.start.toFixed(3));
        form.append('end', ed.end.toFixed(3));
        form.append('job', t.job);
        if (copy) form.append('copy', 'true');
        if (ui.height.value) form.append('height', ui.height.value);
        if (ui.fps.value) form.append('fps', ui.fps.value);
        if (ui.bitrate.value) form.append('bitrate', ui.bitrate.value);
        if (!ui.audio.checked) form.append('audio', 'false');
        return form;
      }, (form) => apiRequest('/edit/trim-video', { body: form, as: 'blob', timeout: 600_000, onProgress: t.onProgress }));
    } finally {
      t.stop();
    }
    const ext = /matroska/.test(blob.type) ? 'mkv' : 'mp4';
    const name = `${stem(file.name)}_${ed.start.toFixed(1)}-${ed.end.toFixed(1)}s.${ext}`;
    const dims = ui.height.selectedOptions[0].textContent.split('· ')[1] || '';
    results.clear();
    const length = copy ? '' : `${(ed.end - ed.start).toFixed(2)} s · `; // a copy starts on a keyframe, so it runs longer
    results.add({ name, blob, meta: `${dims ? `${dims} · ` : ''}${length}${formatBytes(blob.size)}` });
    download(blob, name);
    say(ui.msg, `Saved ${name}.`, 'ok');
  }).then(describeOutput));

  describeOutput();
  checkApi(ui.server);
})();
