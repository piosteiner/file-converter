// Crop box over the trimmer's preview: drag inside to move, the handles to resize, outside to draw a new box.
// The box is kept as fractions of the frame, so it doesn't matter that the preview is smaller than the source.
// It may reach past the frame (x < 0, x + w > 1, …): that part becomes transparent space in the output, which
// makes a sticker show smaller in Telegram. While the box is outside, the stage zooms out so the whole box stays
// in view, with the checkerboard showing where the transparent space will be.

function createCropper({ wrap, box, stage = wrap.parentElement, onChange = () => {} }) {
  const MIN = 0.04;  // smallest box, and the least of the frame it must still cover, as a fraction of each side
  const OUT = 2;     // how far past the frame the box may reach, in frame widths / heights (server: CROP_OUTSIDE)
  const MAX_H = 380; // tallest preview, as .editor-stage video/img in site.css
  let rect = { x: 0, y: 0, w: 1, h: 1 };
  let square = false;
  let shown = false;

  const media = () => $('video:not([hidden]), img:not([hidden])', wrap);
  const isFull = (r) => r.x > -0.001 && r.y > -0.001 && r.w > 0.999 && r.h > 0.999 && r.x + r.w < 1.001 && r.y + r.h < 1.001;
  const isOutside = (r) => r.x < -0.0001 || r.y < -0.0001 || r.x + r.w > 1.0001 || r.y + r.h > 1.0001;

  // Pixel aspect of the frame as shown (the preview keeps the source's), to make a square square.
  const frameAspect = () => (wrap.clientWidth || 1) / (wrap.clientHeight || 1);

  function render() {
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    box.classList.toggle('square', square);
    box.classList.toggle('full', isFull(rect));
  }

  // Sizes the preview so the frame plus the box fit the stage: the picture shrinks as the box reaches further out.
  function fit() {
    const m = media();
    const iw = m?.videoWidth || m?.naturalWidth || 0;
    const ih = m?.videoHeight || m?.naturalHeight || 0;
    if (!shown || !isOutside(rect) || !iw || !ih) {
      wrap.style.cssText = '';
      wrap.classList.remove('extended');
      return;
    }
    const left = Math.min(0, rect.x);
    const top = Math.min(0, rect.y);
    const right = Math.max(1, rect.x + rect.w);
    const bottom = Math.max(1, rect.y + rect.h);
    const cs = getComputedStyle(stage);
    const room = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const dw = Math.max(24, Math.min(iw, room / (right - left), (MAX_H * iw) / ih / (bottom - top)));
    const dh = (dw * ih) / iw;
    wrap.classList.add('extended');
    wrap.style.width = `${dw}px`;
    wrap.style.margin = `${-top * dh}px ${(right - 1) * dw}px ${(bottom - 1) * dh}px ${-left * dw}px`;
  }

  function set(next, { notify = true } = {}) {
    let { x, y, w, h } = next;
    w = Math.max(MIN, Math.min(1 + 2 * OUT, w));
    h = Math.max(MIN, Math.min(1 + 2 * OUT, h));
    x = Math.max(-OUT, Math.min(1 + OUT - w, x));
    y = Math.max(-OUT, Math.min(1 + OUT - h, y));
    // Part of the frame must stay inside the box, or there would be nothing to show.
    x = Math.max(MIN - w, Math.min(1 - MIN, x));
    y = Math.max(MIN - h, Math.min(1 - MIN, y));
    rect = { x, y, w, h };
    render();
    fit();
    if (notify) onChange();
  }

  // Largest centred square inside the current box.
  function makeSquare() {
    const a = frameAspect();
    const side = Math.min(rect.w * a, rect.h); // in units of frame height
    const w = side / a;
    set({ x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - side) / 2, w, h: side });
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!shown || e.button > 0) return;
    e.preventDefault();
    // A press inside a box that covers the whole frame draws a new one (there is nowhere to move it).
    const handle = e.target.dataset?.handle || (e.target === box && !isFull(rect) ? 'move' : 'draw');
    // Pointer positions map through the frame's place at the start of the drag: the view may zoom out meanwhile.
    const r = wrap.getBoundingClientRect();
    const point = (ev) => ({
      x: Math.max(-OUT, Math.min(1 + OUT, (ev.clientX - r.left) / r.width)),
      y: Math.max(-OUT, Math.min(1 + OUT, (ev.clientY - r.top) / r.height)),
    });
    const p0 = point(e);
    const r0 = { ...rect };
    const a = frameAspect();
    stage.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const p = point(ev);
      if (handle === 'move') return set({ ...r0, x: r0.x + p.x - p0.x, y: r0.y + p.y - p0.y });
      // Resizing: the corner opposite the handle (or where drawing began) stays put.
      let left = r0.x; let top = r0.y; let right = r0.x + r0.w; let bottom = r0.y + r0.h;
      if (handle === 'draw') { left = right = p0.x; top = bottom = p0.y; }
      const dx = handle === 'draw' ? (p.x < p0.x ? 'w' : 'e') : handle.includes('w') ? 'w' : handle.includes('e') ? 'e' : '';
      const dy = handle === 'draw' ? (p.y < p0.y ? 'n' : 's') : handle.includes('n') ? 'n' : handle.includes('s') ? 's' : '';
      if (dx === 'w') left = Math.min(p.x, right - MIN); else if (dx === 'e') right = Math.max(p.x, left + MIN);
      if (dy === 'n') top = Math.min(p.y, bottom - MIN); else if (dy === 's') bottom = Math.max(p.y, top + MIN);
      if (square) {
        // Follow the larger movement, then fit inside the working area on the anchored side.
        let side = Math.max((right - left) * a, bottom - top);
        side = Math.min(side, (dx === 'w' ? right + OUT : 1 + OUT - left) * a, dy === 'n' ? bottom + OUT : 1 + OUT - top);
        const w = side / a;
        if (dx === 'w') left = right - w; else right = left + w;
        if (dy === 'n') top = bottom - side; else bottom = top + side;
      }
      set({ x: left, y: top, w: right - left, h: bottom - top });
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    if (handle === 'draw') move(e);
  });

  window.addEventListener('resize', () => { if (shown) fit(); });

  box.replaceChildren(...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => el('span', { class: `crop-handle ${h}`, 'data-handle': h })));

  return {
    // null when the whole frame is used, else [x, y, w, h] as fractions of the frame (may reach past 0…1).
    get: () => (isFull(rect) ? null : [rect.x, rect.y, rect.w, rect.h]),
    // true when the box reaches past the frame, i.e. the output gets transparent space.
    outside: () => isOutside(rect),
    reset({ notify = true } = {}) { square = false; set({ x: 0, y: 0, w: 1, h: 1 }, { notify }); },
    setSquare(on) { square = on; if (on) makeSquare(); else { render(); onChange(); } },
    show(on) {
      shown = on;
      box.hidden = !on;
      wrap.classList.toggle('cropping', on);
      stage.classList.toggle('cropping', on);
      fit();
    },
  };
}
