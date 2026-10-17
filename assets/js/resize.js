// Sticker 512 and Emoji 100. <body data-mode="sticker|emoji"> picks the output.

(function () {
  const mode = document.body.dataset.mode;
  const drop = $('#drop');
  const msg = $('#msg');
  const results = new Results($('#results'), { zipName: mode === 'emoji' ? 'emoji.zip' : 'stickers.zip' });
  const STICKER_LIMIT = 512 * 1024;
  let sources = []; // kept so emoji options can redo the list

  const opt = (name) => $(`input[name="${name}"]:checked`)?.value;

  async function render(file) {
    const img = await loadImage(file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('The image has no size.');

    let canvas;
    if (mode === 'sticker') {
      const s = 512 / Math.max(w, h);
      canvas = scaledCanvas(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    } else {
      const s = (opt('fit') === 'cover' ? Math.max : Math.min)(100 / w, 100 / h);
      const sw = Math.max(1, Math.round(w * s));
      const sh = Math.max(1, Math.round(h * s));
      const scaled = scaledCanvas(img, sw, sh);
      canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext('2d');
      const fill = opt('bg');
      if (fill && fill !== 'transparent') { ctx.fillStyle = fill; ctx.fillRect(0, 0, 100, 100); }
      ctx.drawImage(scaled, Math.round((100 - sw) / 2), Math.round((100 - sh) / 2));
    }
    const blob = await canvasToBlob(canvas, 'image/png');
    return { blob, w, h, ow: canvas.width, oh: canvas.height };
  }

  async function run(files, { save }) {
    results.clear();
    drop.classList.add('busy');
    const done = [];
    for (const [i, file] of files.entries()) {
      say(msg, `Resizing ${i + 1} of ${files.length} — ${file.name}`, 'busy');
      try {
        const r = await render(file);
        const name = `${stem(file.name)}_${mode === 'emoji' ? '100' : '512'}.png`;
        const tooBig = mode === 'sticker' && r.blob.size > STICKER_LIMIT;
        const firstFrame = /gif$/i.test(file.type) ? ' · first frame only' : '';
        results.add({
          name, blob: r.blob, thumb: true, warn: tooBig,
          meta: `${r.w} × ${r.h} → ${r.ow} × ${r.oh} · ${formatBytes(r.blob.size)}${tooBig ? ' · over 512 KB' : ''}${firstFrame}`,
        });
        done.push({ name, blob: r.blob });
      } catch (err) {
        results.fail(file.name, err.message);
      }
    }
    drop.classList.remove('busy');
    if (!done.length) return say(msg, 'Nothing could be converted.', 'bad');
    if (save) {
      if (done.length === 1) download(done[0].blob, done[0].name);
      else await results.downloadAll();
    }
    say(msg, save
      ? `${done.length} file${done.length > 1 ? 's' : ''} ready${done.length > 1 ? ` and saved as ${results.zipName}` : ' and saved'}.`
      : 'Updated with the new options. Save them from the list.', 'ok');
  }

  setupDrop(drop, (files) => {
    const images = files.filter(isImage);
    if (!images.length) return say(msg, 'None of these are images.', 'bad');
    sources = images;
    run(images, { save: true });
  });

  $$('input[name="fit"], input[name="bg"]').forEach((input) =>
    input.addEventListener('change', () => { if (sources.length) run(sources, { save: false }); }));
})();
