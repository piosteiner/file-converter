// Crop box over the trimmer's preview: drag inside to move, the handles to resize, outside to draw a new box.
// The box is kept as fractions of the frame, so it doesn't matter that the preview is smaller than the source.

function createCropper({ wrap, box, onChange = () => {} }) {
  const MIN = 0.04; // smallest box, as a fraction of each side
  let rect = { x: 0, y: 0, w: 1, h: 1 };
  let square = false;

  // Pixel aspect of the frame as shown (the preview keeps the source's), to make a square square.
  const frameAspect = () => (wrap.clientWidth || 1) / (wrap.clientHeight || 1);

  function render() {
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    box.classList.toggle('square', square);
  }

  function set(next, { notify = true } = {}) {
    let { x, y, w, h } = next;
    w = Math.max(MIN, Math.min(1, w));
    h = Math.max(MIN, Math.min(1, h));
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    rect = { x, y, w, h };
    render();
    if (notify) onChange();
  }

  // Largest centred square inside the current box (or the frame).
  function makeSquare() {
    const a = frameAspect();
    const side = Math.min(rect.w * a, rect.h); // in units of frame height
    const w = side / a;
    set({ x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - side) / 2, w, h: side });
  }

  const point = (e) => {
    const r = wrap.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };

  wrap.addEventListener('pointerdown', (e) => {
    if (box.hidden || e.button > 0) return;
    e.preventDefault();
    // A press inside a box that covers the whole frame draws a new one (there is nowhere to move it).
    const full = rect.w > 0.999 && rect.h > 0.999;
    const handle = e.target.dataset?.handle || (e.target === box && !full ? 'move' : 'draw');
    const p0 = point(e);
    const r0 = { ...rect };
    const a = frameAspect();
    wrap.setPointerCapture(e.pointerId);

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
        // Follow the larger movement, then fit inside the frame on the anchored side.
        let side = Math.max((right - left) * a, bottom - top);
        side = Math.min(side, (dx === 'w' ? right : 1 - left) * a, dy === 'n' ? bottom : 1 - top);
        const w = side / a;
        if (dx === 'w') left = right - w; else right = left + w;
        if (dy === 'n') top = bottom - side; else bottom = top + side;
      }
      set({ x: left, y: top, w: right - left, h: bottom - top });
    };
    const up = () => {
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', up);
      wrap.removeEventListener('pointercancel', up);
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', up);
    wrap.addEventListener('pointercancel', up);
    if (handle === 'draw') move(e);
  });

  box.replaceChildren(...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => el('span', { class: `crop-handle ${h}`, 'data-handle': h })));

  return {
    // null when the whole frame is used, else [x, y, w, h] as fractions.
    get: () => (rect.x < 0.001 && rect.y < 0.001 && rect.w > 0.999 && rect.h > 0.999 ? null : [rect.x, rect.y, rect.w, rect.h]),
    reset({ notify = true } = {}) { square = false; set({ x: 0, y: 0, w: 1, h: 1 }, { notify }); },
    setSquare(on) { square = on; if (on) makeSquare(); else { render(); onChange(); } },
    show(on) { box.hidden = !on; wrap.classList.toggle('cropping', on); },
  };
}
