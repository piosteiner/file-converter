// Shared helpers for every tool page. Plain browser JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// File name without extension, safe for every OS.
function stem(filename) {
  const s = filename
    .replace(/\.[^/.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|_+$/g, '')
    .slice(0, 100);
  return s || 'file';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- images ----------

function loadImage(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The browser could not read this image.')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error(
      'The browser could not encode the image (it may be too large for this device).'
    )), type, quality);
  });
}

// Draw `src` scaled to w×h. Large reductions are done in halving steps,
// which keeps detail that a single drawImage would alias away.
function scaledCanvas(src, w, h) {
  let cur = src;
  let cw = src.naturalWidth || src.width;
  let ch = src.naturalHeight || src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const step = document.createElement('canvas');
    step.width = Math.max(1, Math.round(cw / 2));
    step.height = Math.max(1, Math.round(ch / 2));
    const sctx = step.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(cur, 0, 0, step.width, step.height);
    cur = step; cw = step.width; ch = step.height;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

// ---------- binary helpers ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

// Writes the print resolution into a PNG (pHYs chunk), so apps like
// Procreate or a printer dialog open it at the intended physical size.
async function pngWithDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(src.buffer);
  const parts = [src.subarray(0, 8)];
  let pos = 8;
  let inserted = false;
  while (pos < src.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...src.subarray(pos + 4, pos + 8));
    const end = pos + 12 + len;
    if (type !== 'pHYs') parts.push(src.subarray(pos, end));
    if (type === 'IHDR' && !inserted) {
      const ppm = Math.round(dpi / 0.0254);
      const chunk = new Uint8Array(21);
      const cv = new DataView(chunk.buffer);
      cv.setUint32(0, 9);
      chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
      cv.setUint32(8, ppm);
      cv.setUint32(12, ppm);
      chunk[16] = 1; // unit: metre
      cv.setUint32(17, (crc32(chunk.subarray(4, 17)) ^ 0xffffffff) >>> 0);
      parts.push(chunk);
      inserted = true;
    }
    pos = end;
  }
  return new Blob(parts, { type: 'image/png' });
}

// Minimal ZIP writer (stored, no compression — images are compressed already).
async function makeZip(entries) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const { name, blob } of entries) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = enc.encode(name);
    const crc = (crc32(data) ^ 0xffffffff) >>> 0;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    local.push(lh.buffer, nameBytes, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...local, ...central, end.buffer], { type: 'application/zip' });
}

// Give duplicate names a -2, -3 … suffix so a zip never overwrites itself.
function uniqueName(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (taken.has(`${base}-${i}${ext}`)) i++;
  const n = `${base}-${i}${ext}`;
  taken.add(n);
  return n;
}

// ---------- downloads ----------

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  // Safari needs the URL to live a little after the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- drop zone ----------

// zone: element with a hidden <input type=file> inside.
// onFiles receives an array of File objects.
function setupDrop(zone, onFiles) {
  const input = $('input[type="file"]', zone);
  let depth = 0;

  zone.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files.length) onFiles(Array.from(input.files));
    input.value = '';
  });

  zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('over'); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('over');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) onFiles(files);
  });

  // Pasting an image anywhere on the page works too.
  window.addEventListener('paste', (e) => {
    if (zone.classList.contains('busy') || zone.offsetParent === null) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) onFiles(files);
  });
}

// A file dropped beside the zone should not navigate away from the page.
['dragover', 'drop'].forEach((type) => {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types?.includes('Files') && !e.target.closest?.('.drop')) e.preventDefault();
  });
});

function isImage(file) {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name);
}

// ---------- status line ----------

function say(target, text, kind = '') {
  target.className = `msg ${kind}`;
  target.replaceChildren();
  if (!text) return;
  if (kind === 'busy') target.append(el('span', { class: 'busy-line', text }));
  else target.textContent = text;
}

// ---------- result list ----------

class Results {
  constructor(container, { zipName = 'files.zip', title = 'Output' } = {}) {
    this.container = container;
    this.zipName = zipName;
    this.title = title;
    this.items = [];
    this.urls = [];
  }

  clear() {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.items = [];
    this.container.replaceChildren();
  }

  ensureHead() {
    if (this.head) {
      if (this.head.isConnected) return;
    }
    this.count = el('span', { class: 'value' });
    this.zipBtn = el('button', { class: 'btn ghost small', type: 'button', hidden: true, onclick: () => this.downloadAll() }, 'Download all as .zip');
    this.head = el('div', { class: 'results-head' },
      el('h2', {}, this.title, ' ', this.count),
      this.zipBtn);
    this.container.append(this.head);
  }

  refreshHead() {
    const ok = this.items.length;
    this.count.textContent = ok ? `· ${ok}` : '';
    this.zipBtn.hidden = ok < 2;
  }

  add({ name, blob, meta = '', thumb = false, warn = false }) {
    this.ensureHead();
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    const row = el('div', { class: `result${warn ? ' warn' : ''}` },
      thumb ? el('img', { class: 'thumb', src: url, alt: '' }) : el('span', { class: 'thumb blank' }),
      el('span', { class: 'name', title: name, text: name }),
      el('span', { class: 'meta', text: meta }),
      el('a', { class: 'dl', href: url, download: name }, 'Save'));
    this.container.append(row);
    this.items.push({ name, blob });
    this.refreshHead();
    return row;
  }

  fail(name, message) {
    this.ensureHead();
    this.container.append(el('div', { class: 'result failed' },
      el('span', { class: 'thumb blank' }),
      el('span', { class: 'name', title: name, text: name }),
      el('span', { class: 'meta', text: message }),
      el('span')));
  }

  async downloadAll() {
    if (!this.items.length) return;
    if (this.items.length === 1) return download(this.items[0].blob, this.items[0].name);
    this.zipBtn.disabled = true;
    try {
      const taken = new Set();
      const entries = this.items.map((i) => ({ name: uniqueName(i.name, taken), blob: i.blob }));
      download(await makeZip(entries), this.zipName);
    } finally {
      this.zipBtn.disabled = false;
    }
  }
}

// ---------- theme ----------

(function theme() {
  const order = ['system', 'light', 'dark'];
  const read = () => { try { return localStorage.getItem('preferred-theme') || 'system'; } catch { return 'system'; } };
  const apply = (t) => {
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  const sync = (btn, t) => { btn.textContent = t; btn.title = `Theme: ${t} (click to change)`; };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('.theme-btn');
    if (!btn) return;
    let t = read();
    if (!order.includes(t)) t = 'system';
    sync(btn, t);
    btn.addEventListener('click', () => {
      t = order[(order.indexOf(t) + 1) % order.length];
      try { localStorage.setItem('preferred-theme', t); } catch { /* private mode */ }
      apply(t);
      sync(btn, t);
    });
  });
})();

// ---------- offline support ----------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
