'use strict';
// ====== PENGATURAN ======
// Isi URL Web App di sini, atau tempel lewat tab Atur (disimpan di HP).
const DEFAULT_EXEC_URL = '';
const STATUSES = ['IN', 'OUT', 'OK', 'KANIBAL', 'BALIK RUSAK', 'RMA'];
const CDN_QR = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
const CDN_OCR = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

const $ = id => document.getElementById(id);
const KEY = 'moboscan-v2';
const store = Object.assign({ execUrl: DEFAULT_EXEC_URL, preferLocal: false, catalog: '', items: [], logs: [] },
  (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } })());
if (!store.execUrl) store.execUrl = DEFAULT_EXEC_URL;
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} };

const today = () => new Date().toLocaleDateString('sv-SE');
function msg(t, kind) { const m = $('msg'); m.textContent = t || ''; m.className = kind || ''; }
const asStatus = s => STATUSES.includes(s) ? s : 'IN';
const stClass = s => 'st-' + (s === 'BALIK RUSAK' ? 'BALIK' : s);

function beep() {
  try {
    const c = new AudioContext(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 880; g.gain.value = 0.04; o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + 0.07); o.onended = () => c.close();
  } catch (e) {}
}
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[src="' + src + '"]')) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Gagal memuat pustaka. Periksa internet.'));
    document.head.appendChild(s);
  });
}

// ====== API Apps Script (langsung dari browser, tanpa server perantara) ======
async function gas(opts) {
  if (!store.execUrl) throw new Error('URL Web App belum diisi (tab Atur).');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), opts.timeout || 25000);
  try {
    let res;
    if (opts.body) res = await fetch(store.execUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(opts.body), signal: ctl.signal });
    else res = await fetch(store.execUrl + (store.execUrl.includes('?') ? '&' : '?') + opts.query, { signal: ctl.signal });
    const text = (await res.text()).trim();
    if (/^<(!doctype|html)/i.test(text)) throw new Error('Web App menolak. Deploy ulang: Execute as Me, akses Anyone.');
    try { return JSON.parse(text); } catch (e) { throw new Error('Balasan Spreadsheet tidak dikenali.'); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Spreadsheet terlalu lama membalas.');
    throw e;
  } finally { clearTimeout(t); }
}

// ====== Daftar model (koreksi hasil baca) ======
const normModel = v => v.toUpperCase().replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  a = a.slice(0, 48); b = b.slice(0, 48);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function catalogLines() {
  const seen = new Set(), out = [];
  for (const l of store.catalog.split(/\n+/)) { const t = l.trim(), k = normModel(t); if (t && !seen.has(k)) { seen.add(k); out.push(t); } }
  return out.slice(0, 400);
}
const snapExact = (t, cat) => { const k = normModel(t); return k ? (cat.find(l => normModel(l) === k) || null) : null; };
function suggestions(t, cat) {
  const k = normModel(t); if (k.length < 2) return [];
  const lim = Math.max(1, Math.round(k.length * 0.28));
  return cat.map(l => ({ l, d: lev(normModel(l), k) })).filter(r => r.d > 0 && r.d <= lim)
    .sort((a, b) => a.d - b.d || a.l.length - b.l.length).map(r => r.l).slice(0, 3);
}
function uniq(list) { const o = []; for (const v of list) { const t = v.replace(/\s+/g, ' ').trim(); if (t && !o.some(x => x.toUpperCase() === t.toUpperCase())) o.push(t); } return o; }

// ====== Gambar: potong, ketajaman, persiapan ======
function cropSource(src, c) {
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height; if (!w || !h) return null;
  const sx = Math.round(w * c.x), sy = Math.round(h * c.y), sw = Math.max(1, Math.min(w - sx, Math.round(w * c.w))), sh = Math.max(1, Math.min(h - sy, Math.round(h * c.h)));
  const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
  cv.getContext('2d', { willReadFrequently: true }).drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh); return cv;
}
function sharpScore(cv) {
  const w = 220, h = Math.max(8, Math.round(cv.height * w / Math.max(1, cv.width)));
  const sm = document.createElement('canvas'); sm.width = w; sm.height = h;
  const cx = sm.getContext('2d', { willReadFrequently: true }); cx.drawImage(cv, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) { const i = y * w + x, l = g[i - w] + g[i - 1] + g[i + 1] + g[i + w] - 4 * g[i]; s += l; s2 += l * l; n++; }
  if (!n) return 0; const m = s / n; return s2 / n - m * m;
}
const sharpLabel = s => s < 80 ? 'Kabur' : s < 180 ? 'Hampir' : 'Tajam';
async function sharpestBurst(video, c, frames) {
  let best = null, bs = -1;
  for (let i = 0; i < frames; i++) {
    const shot = cropSource(video, c);
    if (shot) { const sc = sharpScore(shot); if (sc > bs) { best = shot; bs = sc; } }
    if (i < frames - 1) await new Promise(r => setTimeout(r, 80));
  }
  return best ? { canvas: best, score: bs } : null;
}
function fitCanvas(src, w, h, max) {
  const k = Math.min(1, max / Math.max(w, h)), cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
  const cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(src, 0, 0, cv.width, cv.height); return cv;
}
function prepareForVision(src) {
  const k = src.height < 200 ? Math.min(3, 240 / Math.max(1, src.height)) : 1;
  const w = Math.min(1400, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * (w / Math.max(1, src.width))));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingQuality = 'high'; cx.drawImage(src, 0, 0, w, h);
  const im = cx.getImageData(0, 0, w, h), p = im.data;
  for (let i = 0; i < p.length; i += 4) for (let j = 0; j < 3; j++) p[i + j] = Math.max(0, Math.min(255, (p[i + j] - 128) * 1.12 + 128));
  cx.putImageData(im, 0, 0); return cv;
}
function toJpeg(cv) {
  let q = .86, u = cv.toDataURL('image/jpeg', q);
  while (u.length > 1400000 && q > .52) { q -= .12; u = cv.toDataURL('image/jpeg', q); }
  if (u.length > 1400000) { const s = fitCanvas(cv, cv.width, cv.height, Math.round(Math.max(cv.width, cv.height) * .7)); u = s.toDataURL('image/jpeg', .74); }
  return u;
}
function loadImage(file) {
  return new Promise((res, rej) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Foto tidak bisa dibuka.')); }; im.src = u; });
}

// ====== OCR di perangkat (Tesseract, dimuat hanya jika perlu) ======
let ocrWorker = null;
async function getWorker() {
  if (!ocrWorker) ocrWorker = (async () => { await loadScript(CDN_OCR); return Tesseract.createWorker('eng'); })().catch(e => { ocrWorker = null; throw e; });
  return ocrWorker;
}
function ocrVariants(src) {
  const sc = Math.min(3, Math.max(src.height, 260) / Math.max(1, src.height));
  const cv = document.createElement('canvas'); cv.width = Math.min(1600, Math.round(src.width * sc)); cv.height = Math.max(1, Math.round(src.height * cv.width / Math.max(1, src.width)));
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(src, 0, 0, cv.width, cv.height);
  const im = cx.getImageData(0, 0, cv.width, cv.height), p = im.data, n = p.length / 4, hist = new Array(256).fill(0), g = new Uint8ClampedArray(n);
  let sum = 0;
  for (let i = 0, k = 0; i < p.length; i += 4, k++) { const v = Math.round(p[i] * .299 + p[i + 1] * .587 + p[i + 2] * .114); g[k] = v; hist[v]++; sum += v; }
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * .02) { lo = i; break; } }
  acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * .02) { hi = i; break; } }
  if (hi - lo < 24) hi = Math.min(255, lo + 24);
  const st = new Uint8ClampedArray(n); for (let i = 0; i < n; i++) st[i] = Math.max(0, Math.min(255, (g[i] - lo) / (hi - lo) * 255));
  const h2 = new Array(256).fill(0); for (let i = 0; i < n; i++) h2[Math.round(st[i])]++;
  let tot = 0; for (let i = 0; i < 256; i++) tot += i * h2[i];
  let sB = 0, wB = 0, mx = 0, th = 140;
  for (let t = 0; t < 256; t++) { wB += h2[t]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += t * h2[t]; const mB = sB / wB, mF = (tot - sB) / wF, b = wB * wF * (mB - mF) * (mB - mF); if (b > mx) { mx = b; th = t; } }
  const paint = fn => { const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const x = c.getContext('2d'), o = x.createImageData(c.width, c.height); for (let i = 0, k = 0; i < o.data.length; i += 4, k++) { const v = fn(k); o.data[i] = o.data[i + 1] = o.data[i + 2] = v; o.data[i + 3] = 255; } x.putImageData(o, 0, 0); return c; };
  const list = [paint(k => st[k]), paint(k => st[k] > th ? 255 : 0)];
  if (sum / n < 150) list.push(paint(k => st[k] > th ? 0 : 255));
  return list;
}
async function readLocal(src) {
  const w = await getWorker(), found = [];
  for (const img of ocrVariants(src)) {
    await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/.: _+#', preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const r = await w.recognize(img), t = r.data.text.replace(/\s+/g, ' ').trim();
    const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
    if (t.length >= 2 && alnum / t.length >= .55) found.push({ t, c: r.data.confidence });
  }
  found.sort((a, b) => b.c - a.c);
  const u = uniq(found.map(f => f.t)); return { text: u[0] || '', alts: u.slice(1, 4) };
}

// ====== State & tampilan ======
const S = { view: 'scan', mode: 'barcode', armed: true, cur: null, status: 'IN', cropY: .34, cropH: .3, saving: false, reading: false };
let camGen = 0, stream = null, track = null, qr = null, torchOn = false, lookupGen = 0;
const crop = () => ({ x: .06, y: S.cropY, w: .88, h: S.cropH });

function renderStatuses() {
  $('statuses').innerHTML = '';
  STATUSES.forEach(s => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = s;
    b.className = stClass(s) + (S.status === s ? ' on' : ''); b.onclick = () => chooseStatus(s);
    $('statuses').appendChild(b);
  });
}
function chooseStatus(s) {
  S.status = s;
  if (s === 'OUT') { if (!$('tglOut').value) $('tglOut').value = today(); $('tglKembali').value = ''; }
  if (s === 'IN' && S.cur && S.cur.status === 'OUT' && !$('tglKembali').value) $('tglKembali').value = today();
  renderStatuses();
}
function fillFrom(d) {
  if (d.serial) $('serial').value = d.serial;
  $('tanggal').value = d.tanggal || today(); $('model').value = d.model || '';
  S.status = asStatus(d.status); $('ket').value = d.keterangan || '';
  $('tglOut').value = d.tglOut || ''; $('tglKembali').value = d.tglKembali || ''; renderStatuses();
}
function setInfo(t, kind) { const i = $('info'); i.textContent = t || ''; i.className = 'small ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'muted'); }
function remember(item) { store.items = [item, ...store.items.filter(r => r.serial !== item.serial)].slice(0, 2000); persist(); $('count').textContent = store.items.length + ' barang'; }

function showView(v) {
  S.view = v;
  ['scan', 'data', 'atur'].forEach(n => { $('v-' + n).hidden = n !== v; });
  document.querySelectorAll('.dock button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'data') { renderData(); if (store.execUrl) loadList(); }
  if (v === 'atur') { $('url').value = store.execUrl; $('preferLocal').checked = store.preferLocal; $('catalog').value = store.catalog; $('active').textContent = store.execUrl ? 'Spreadsheet aktif.' : ''; }
  startCam();
}
function setMode(m) {
  S.mode = m; if (m === 'barcode') S.armed = true;
  $('tBc').classList.toggle('on', m === 'barcode'); $('tTx').classList.toggle('on', m === 'text');
  $('again').hidden = m !== 'barcode'; $('shot').hidden = m !== 'text'; $('textTools').hidden = m !== 'text';
  startCam();
}

// ====== Kamera ======
function camText(t) { $('camMsg').textContent = t || ''; }
async function stopCam() {
  if (qr) { const q = qr; qr = null; try { await q.stop(); } catch (e) {} try { q.clear(); } catch (e) {} }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  track = null; torchOn = false;
  $('vid').srcObject = null; $('vid').style.display = 'none'; $('reader').style.display = 'none'; $('box').style.display = 'none';
  $('torch').hidden = true; $('zoomWrap').hidden = true;
}
async function nativeCode128() {
  if (!('BarcodeDetector' in window)) return false;
  try { return (await BarcodeDetector.getSupportedFormats()).includes('code_128'); } catch (e) { return false; }
}
async function tune(t) {
  if (!t) return; track = t;
  const caps = t.getCapabilities ? t.getCapabilities() : {};
  try { if (caps.focusMode && caps.focusMode.includes('continuous')) await t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
  if (caps.zoom && typeof caps.zoom.max === 'number') {
    const z = $('zoom'); z.min = caps.zoom.min || 1; z.max = caps.zoom.max; z.step = caps.zoom.step || .1;
    z.value = (t.getSettings().zoom) || z.min; $('zoomWrap').hidden = false;
  } else $('zoomWrap').hidden = true;
  $('torch').hidden = !caps.torch; $('torch').textContent = 'Senter: mati'; torchOn = false;
}
async function openVideo(my) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new DOMException('no camera', 'NotFoundError');
  const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  if (my !== camGen) { s.getTracks().forEach(t => t.stop()); return false; }
  stream = s; const v = $('vid'); v.srcObject = s; v.style.display = 'block'; await v.play();
  await tune(s.getVideoTracks()[0]); return my === camGen;
}
function placeBox() {
  const b = $('box'), c = crop(); b.style.display = 'block';
  b.style.left = c.x * 100 + '%'; b.style.top = c.y * 100 + '%'; b.style.width = c.w * 100 + '%'; b.style.height = c.h * 100 + '%';
}
async function startCam() {
  const my = ++camGen; await stopCam(); camText('');
  if (my !== camGen || S.view !== 'scan') return;
  try {
    if (S.mode === 'barcode') {
      if (!S.armed) { camText('Serial sudah diambil. Isi data lalu simpan, atau scan ulang.'); return; }
      if (await nativeCode128()) {
        if (!(await openVideo(my))) return;
        const det = new BarcodeDetector({ formats: ['code_128'] });
        const tick = async () => {
          if (my !== camGen) return;
          try { const v = $('vid'); if (v.readyState >= 2) { const r = await det.detect(v); const raw = r[0] && r[0].rawValue && r[0].rawValue.trim(); if (raw) { onCode(raw); return; } } } catch (e) {}
          setTimeout(tick, 140);
        };
        tick();
      } else {
        await loadScript(CDN_QR); if (my !== camGen) return;
        $('reader').style.display = 'block';
        const inst = new Html5Qrcode('reader', { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128] });
        try { await inst.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 120 } }, t => onCode(t), () => {}); }
        catch (e) { try { inst.clear(); } catch (x) {} throw e; }
        if (my !== camGen) { try { await inst.stop(); inst.clear(); } catch (e) {} return; }
        qr = inst; const ev = document.querySelector('#reader video');
        if (ev && ev.srcObject) { stream = null; await tune(ev.srcObject.getVideoTracks()[0]); }
      }
    } else {
      if (!(await openVideo(my))) return;
      placeBox();
      const mag = $('mag'), loop = () => {
        if (my !== camGen) return;
        const v = $('vid');
        if (v.videoWidth) {
          const shot = cropSource(v, crop());
          if (shot) {
            const l = sharpLabel(sharpScore(shot)); $('sharp').textContent = ' · ' + l; $('sharp').style.fontWeight = '600'; $('sharp').style.color = l === 'Tajam' ? '#246b3d' : '';
            mag.width = (mag.clientWidth * 2) || 640; mag.height = 144;
            const cx = mag.getContext('2d'); cx.fillStyle = '#1c1b19'; cx.fillRect(0, 0, mag.width, mag.height); cx.drawImage(shot, 0, 0, mag.width, mag.height);
          }
        }
        setTimeout(loop, 220);
      };
      loop();
    }
  } catch (e) {
    const n = e && e.name;
    camText(n === 'NotAllowedError' || n === 'PermissionDeniedError' ? 'Kamera ditolak. Izinkan kamera, ketik manual, atau unggah foto.'
      : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'Kamera belakang tidak ketemu. Ketik manual atau unggah foto.'
      : (e && e.message) || 'Kamera tidak bisa dibuka. Ketik manual atau unggah foto.');
  }
}
$('zoom').oninput = () => { if (track) track.applyConstraints({ advanced: [{ zoom: +$('zoom').value }] }).catch(() => {}); };
$('torch').onclick = async () => {
  if (!track) return;
  try { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('torch').textContent = 'Senter: ' + (torchOn ? 'nyala' : 'mati'); }
  catch (e) { torchOn = !torchOn; msg('Senter tidak didukung di perangkat ini.', 'err'); }
};
$('vid').onclick = async () => {
  if (!track) return;
  try { await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }); setTimeout(() => track && track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 600); } catch (e) {}
};
$('cropY').oninput = e => { S.cropY = Math.min(+e.target.value, .9 - S.cropH); placeBox(); };
$('cropH').oninput = e => { S.cropH = +e.target.value; S.cropY = Math.min(S.cropY, .9 - S.cropH); $('cropY').value = S.cropY; placeBox(); };

// ====== Cek serial ======
async function lookup(val) {
  const key = val.trim(); if (!key) return;
  const gen = ++lookupGen; setInfo('Mengecek serial...');
  const local = () => store.items.find(i => i.serial === key);
  if (store.execUrl) {
    try {
      const r = await gas({ query: 'serial=' + encodeURIComponent(key) });
      if (gen !== lookupGen) return;
      if (r.ok && r.found) {
        const it = Object.assign({}, r.data, { serial: r.data.serial || key, status: asStatus(r.data.status) });
        remember(it); S.cur = it; fillFrom(it);
        setInfo('Ditemukan. Status sekarang: ' + it.status + (it.status === 'OUT' && it.tglOut ? ' (out ' + it.tglOut + ')' : '') + '.', 'ok'); return;
      }
      if (r.ok) { S.cur = null; $('model').value = ''; $('ket').value = ''; $('tglOut').value = ''; $('tglKembali').value = ''; S.status = 'IN'; renderStatuses(); setInfo('Serial belum terdaftar. Status IN akan menyimpannya sebagai barang baru.'); return; }
      setInfo(r.error || 'Gagal mengecek serial.', 'err'); return;
    } catch (e) {
      if (gen !== lookupGen) return;
      const l = local(); if (l) { S.cur = l; fillFrom(l); setInfo('Spreadsheet gagal, ini data tersimpan di perangkat. Status: ' + l.status + '.', 'err'); return; }
      setInfo(e.message || 'Gagal mengecek serial. Periksa koneksi.', 'err'); return;
    }
  }
  const l = local(); if (l) { S.cur = l; fillFrom(l); setInfo('Ada di perangkat. Status: ' + l.status + '.'); }
  else { S.cur = null; setInfo('Isi URL Web App di tab Atur agar serial dicek ke Spreadsheet.', 'err'); }
}
function onCode(val) {
  const k = val.trim(); if (!k) return;
  if (navigator.vibrate) navigator.vibrate(80);
  beep(); $('serial').value = k; S.armed = false; msg('Serial terbaca: ' + k, 'good'); startCam(); lookup(k);
}
$('serial').addEventListener('change', () => { const s = $('serial').value.trim(); if (s) lookup(s); });
$('serial').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('serial').blur(); } });

// ====== Baca teks model ======
function applyReading(text, extra, source, detail) {
  const cat = catalogLines(), exact = text ? snapExact(text, cat) : null, chosen = exact || text;
  const hinted = uniq([].concat(extra, chosen ? suggestions(chosen, cat) : [], !chosen ? extra.flatMap(x => suggestions(x, cat)) : []))
    .filter(x => x.toUpperCase() !== chosen.toUpperCase());
  if (chosen) $('model').value = chosen;
  const alts = hinted.slice(0, 4); $('alts').innerHTML = '';
  alts.forEach(a => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Pakai ' + a; b.onclick = () => { $('model').value = a; }; $('alts').appendChild(b); });
  if (!chosen && !alts.length) { msg('Teks tidak terbaca. Masukkan seluruh tulisan ke kotak, tunggu sampai tajam, lalu coba lagi.', 'err'); return; }
  msg((source === 'ai' ? 'Hasil AI' : 'Hasil perangkat, sering selisih satu huruf') + (chosen ? ': ' + chosen : '') + '. ' + (detail || 'Cocokkan dengan stiker sebelum simpan.'), source === 'ai' ? 'good' : 'err');
}
async function readCanvas(src, blurry) {
  S.reading = true; $('shot').disabled = true; $('alts').innerHTML = '';
  msg(blurry ? 'Gambar masih kabur, tetap dicoba...' : 'Membaca teks...');
  const img = toJpeg(prepareForVision(src)); $('preview').src = img; $('preview').hidden = false;
  try {
    if (!store.preferLocal && store.execUrl) {
      try {
        const r = await gas({ body: { action: 'ocr', image: img }, timeout: 40000 });
        if (r.ok && (r.text || (r.alts && r.alts.length))) { applyReading(r.text, r.alts || [], 'ai', r.note); return; }
        msg((r.ok ? 'AI tidak yakin' : r.error) + '. Mencoba di perangkat...', 'err');
      } catch (e) { msg((e.message || 'AI gagal') + ' Mencoba di perangkat...', 'err'); }
    } else msg('Membaca di perangkat...');
    const l = await readLocal(src); applyReading(l.text, l.alts, 'local', '');
  } catch (e) { msg(e.message || 'Gagal membaca teks. Ketik manual.', 'err'); }
  finally { S.reading = false; $('shot').disabled = false; }
}
$('shot').onclick = async () => {
  const v = $('vid'); if (!v.videoWidth) return msg('Kamera belum siap.', 'err');
  const b = await sharpestBurst(v, crop(), 4); if (!b) return msg('Gambar belum ada.', 'err');
  readCanvas(b.canvas, sharpLabel(b.score) === 'Kabur');
};
$('gallery').onclick = () => $('file').click();
$('file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const im = await loadImage(f); await readCanvas(fitCanvas(im, im.naturalWidth, im.naturalHeight, 1600), false); }
  catch (er) { msg(er.message || 'Foto gagal dibuka.', 'err'); }
};

// ====== Simpan ======
function resetForm() {
  ['serial', 'model', 'ket', 'tglOut', 'tglKembali'].forEach(k => { $(k).value = ''; });
  S.status = 'IN'; S.cur = null; setInfo(''); $('alts').innerHTML = ''; $('preview').hidden = true; $('tanggal').value = today();
  renderStatuses(); S.armed = true; setMode('barcode');
}
function ask(text) { return new Promise(res => { $('dlgTitle').textContent = text; $('dlg').hidden = false; $('dlgYes').onclick = () => { $('dlg').hidden = true; res(true); }; $('dlgNo').onclick = () => { $('dlg').hidden = true; res(false); }; }); }
async function save(force) {
  const serial = $('serial').value.trim(); if (!serial) return msg('Serial belum diisi.', 'err');
  if (!store.execUrl) return msg('Isi URL Web App di tab Atur dulu.', 'err');
  if (S.saving) return; S.saving = true; $('save').disabled = true; msg('Menyimpan...');
  const body = { tanggal: $('tanggal').value || today(), serial, model: $('model').value.trim(), status: S.status, keterangan: $('ket').value.trim(), tglOut: $('tglOut').value, tglKembali: $('tglKembali').value, force: !!force };
  try {
    const r = await gas({ body });
    if (!r.ok && (r.code === 'NOT_FOUND' || r.code === 'ALREADY_OUT')) {
      S.saving = false; $('save').disabled = false; msg(r.error, 'err');
      if (await ask(r.error)) return save(true); return;
    }
    if (!r.ok) throw new Error(r.error || 'Gagal menyimpan.');
    if (r.data) remember(Object.assign({}, r.data, { status: asStatus(r.data.status) }));
    msg(r.updated ? 'Data diperbarui di Spreadsheet.' : 'Data baru masuk Spreadsheet.', 'good'); resetForm();
  } catch (e) { msg('Gagal menyimpan: ' + (e.message || 'periksa koneksi') + '. Data di form tidak dihapus.', 'err'); }
  S.saving = false; $('save').disabled = false;
}
$('save').onclick = () => save(false);
$('again').onclick = () => { S.armed = true; startCam(); };
$('tBc').onclick = () => setMode('barcode');
$('tTx').onclick = () => setMode('text');

// ====== Tab Data ======
function renderData() {
  const q = $('q').value.trim().toLowerCase(), f = $('fstatus').value, ul = $('list'); ul.innerHTML = '';
  $('count').textContent = store.items.length + ' barang';
  const rows = store.items.filter(i => (`${i.serial} ${i.model}`.toLowerCase().includes(q)) && (f === 'SEMUA' || i.status === f));
  if (!rows.length) ul.innerHTML = '<li class="empty">Belum ada data. Tekan “Muat ulang dari Spreadsheet”, atau scan serial lalu simpan.</li>';
  rows.slice(0, 200).forEach(i => {
    const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button'; b.className = 'item';
    b.innerHTML = '<span class="r1"><span class="sn mono"></span><span class="badge"></span></span><span class="md mono" style="display:block"></span><span class="dt" style="display:block"></span>';
    b.querySelector('.sn').textContent = i.serial; const bd = b.querySelector('.badge'); bd.textContent = i.status; bd.className = 'badge ' + stClass(i.status);
    b.querySelector('.md').textContent = i.model || 'Tanpa model';
    b.querySelector('.dt').textContent = (i.tglOut ? 'Out ' + i.tglOut : 'Belum out') + (i.tglKembali ? ' · kembali ' + i.tglKembali : '');
    b.onclick = () => { S.cur = i; fillFrom(i); S.armed = false; showView('scan'); setInfo('Status sekarang: ' + i.status + '.'); };
    li.appendChild(b); ul.appendChild(li);
  });
  const lg = $('logs'); lg.innerHTML = '';
  store.logs.slice(0, 20).forEach(e => { const li = document.createElement('li'); li.className = 'logrow'; li.textContent = `${e.serial}  ${e.lama} → ${e.baru}`; lg.appendChild(li); });
}
async function loadList() {
  msg('Memuat data...');
  try {
    const r = await gas({ query: 'action=list' });
    if (!r.ok) throw new Error(r.error || 'Gagal memuat.');
    store.items = r.items.map(i => Object.assign({}, i, { status: asStatus(i.status) })); store.logs = r.logs || []; persist(); renderData(); msg('Data dimuat dari Spreadsheet.', 'good');
  } catch (e) { msg((e.message || 'Gagal memuat data') + ' Menampilkan salinan di perangkat.', 'err'); }
}
$('q').oninput = renderData; $('fstatus').onchange = renderData; $('refresh').onclick = loadList;
$('fstatus').innerHTML = '<option value="SEMUA">Semua status</option>' + STATUSES.map(s => `<option>${s}</option>`).join('');

// ====== Tab Atur ======
$('saveUrl').onclick = () => { store.execUrl = $('url').value.trim(); persist(); $('active').textContent = store.execUrl ? 'Spreadsheet aktif.' : ''; msg(store.execUrl ? 'URL disimpan di perangkat ini.' : 'URL dikosongkan.', 'good'); };
$('testUrl').onclick = async () => {
  store.execUrl = $('url').value.trim(); persist(); if (!store.execUrl) return msg('Isi URL Web App dulu.', 'err');
  $('testUrl').disabled = true; msg('Mencoba...');
  try { const r = await gas({ query: 'serial=__ping__' }); msg(r.ok ? 'Spreadsheet tersambung.' : (r.error || 'Gagal.'), r.ok ? 'good' : 'err'); $('active').textContent = r.ok ? 'Spreadsheet aktif.' : ''; }
  catch (e) { msg(e.message || 'Tidak bisa menghubungi Spreadsheet.', 'err'); }
  $('testUrl').disabled = false;
};
$('preferLocal').onchange = e => { store.preferLocal = e.target.checked; persist(); };
$('catalog').oninput = e => { store.catalog = e.target.value; persist(); };
$('clear').onclick = () => { if (confirm('Hapus salinan barang di perangkat ini? Spreadsheet tidak ikut terhapus.')) { store.items = []; store.logs = []; persist(); renderData(); msg('Salinan dihapus.', 'good'); } };
document.querySelectorAll('.dock button').forEach(b => { b.onclick = () => showView(b.dataset.view); });

// ====== Mulai ======
$('tanggal').value = today(); $('count').textContent = store.items.length + ' barang';
renderStatuses();
if (!store.execUrl) showView('atur');
setMode('barcode');

