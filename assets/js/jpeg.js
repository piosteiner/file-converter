// PNG → JPEG. One file downloads directly; several come back as one zip.

(function () {
  const quality = $('#quality');
  const qualityOut = $('#qualityOut');
  const bg = $('#bg');
  const bgOut = $('#bgOut');
  const drop = $('#drop');
  const msg = $('#msg');
  const results = new Results($('#results'), { zipName: 'jpeg.zip' });

  quality.addEventListener('input', () => { qualityOut.value = quality.value; });
  bg.addEventListener('input', () => { bgOut.value = bg.value; });

  async function toJpeg(file) {
    const img = await loadImage(file);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg.value;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality.value / 100);
    return { blob, w: canvas.width, h: canvas.height };
  }

  setupDrop(drop, async (files) => {
    const images = files.filter(isImage);
    const skipped = files.length - images.length;
    if (!images.length) return say(msg, 'None of these are images.', 'bad');

    results.clear();
    drop.classList.add('busy');
    const done = [];
    for (const [i, file] of images.entries()) {
      say(msg, `Converting ${i + 1} of ${images.length} — ${file.name}`, 'busy');
      try {
        const { blob, w, h } = await toJpeg(file);
        const name = `${stem(file.name)}.jpg`;
        results.add({ name, blob, thumb: true, meta: `${w} × ${h} · ${formatBytes(file.size)} → ${formatBytes(blob.size)}` });
        done.push({ name, blob });
      } catch (err) {
        results.fail(file.name, err.message);
      }
    }
    drop.classList.remove('busy');

    const note = skipped ? ` ${skipped} non-image file${skipped > 1 ? 's' : ''} skipped.` : '';
    if (!done.length) return say(msg, `Nothing could be converted.${note}`, 'bad');
    if (done.length === 1) download(done[0].blob, done[0].name);
    else await results.downloadAll();
    say(msg, `${done.length} file${done.length > 1 ? 's' : ''} converted${done.length > 1 ? ' and saved as jpeg.zip' : ''}.${note}`, 'ok');
  });
})();
