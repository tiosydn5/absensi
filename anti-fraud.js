// ============================================================================
// VECTRA // Anti-Fraud Engine
// Modules: Haversine Geofence, GPS Spoofing & Travel Speed Detector,
// Device Fingerprint Hash, 15s Rotating TOTP QR + Pure-JS QR Matrix Canvas,
// Live Camera + Canvas Metadata Watermarking, and IndexedDB Offline Queue.
// ============================================================================

const EARTH_RADIUS_METERS = 6371000;
const TOTP_STEP_SECONDS = 15;

/**
 * Haversine geodesic distance in meters between two WGS84 coordinates.
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    return null;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return Math.round(EARTH_RADIUS_METERS * c * 100) / 100;
}

/**
 * Format WIB date/time string consistently (Asia/Jakarta).
 */
export function formatWibDateTime(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date) + ' WIB';
}

/**
 * Evaluate GPS coordinates against spoofing & impossible travel heuristics.
 */
export function evaluateGpsIntegrity({ lat, lon, accuracy }, previousLog = null, nowDate = new Date()) {
  const reasons = [];
  let speedKmh = 0;

  if (accuracy === null || accuracy === undefined || Number.isNaN(Number(accuracy))) {
    reasons.push('GPS_ACCURACY_MISSING');
  } else if (Number(accuracy) <= 0) {
    reasons.push('MOCK_GPS_ZERO_ACCURACY');
  } else if (Number(accuracy) > 100) {
    reasons.push(`LOW_GPS_ACCURACY_${Math.round(accuracy)}M`);
  }

  if (previousLog) {
    const prevLat = previousLog.clock_out_lat ?? previousLog.clock_in_lat;
    const prevLon = previousLog.clock_out_lon ?? previousLog.clock_in_lon;
    const prevTime = previousLog.clock_out_at ?? previousLog.clock_in_at;
    if (prevLat != null && prevLon != null && prevTime) {
      const distMeters = calculateHaversineDistance(lat, lon, Number(prevLat), Number(prevLon));
      const elapsedHrs = (nowDate.getTime() - new Date(prevTime).getTime()) / 3600000;
      if (distMeters !== null && elapsedHrs > 0.001) {
        speedKmh = Math.round(((distMeters / 1000) / elapsedHrs) * 10) / 10;
        if (speedKmh > 120) {
          reasons.push(`IMPOSSIBLE_TRAVEL_SPEED_${Math.round(speedKmh)}kmh`);
        }
      }
    }
  }

  return {
    isFlagged: reasons.length > 0,
    reasons,
    speedKmh,
    accuracy: Number(accuracy ?? 0)
  };
}

/**
 * Deterministic fallback hash if SubtleCrypto is unavailable on non-HTTPS origin.
 */
function fnv1aHex(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Generate a persistent browser/hardware fingerprint hash for device binding.
 */
export async function generateDeviceFingerprint() {
  let canvasSig = 'no-canvas';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 44;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#111815';
      ctx.fillRect(0, 0, 220, 44);
      ctx.fillStyle = '#84CC16';
      ctx.font = '600 14px Poppins, sans-serif';
      ctx.fillText('VECTRA-DEV-FP-v1', 10, 26);
      canvasSig = canvas.toDataURL().slice(-64);
    }
  } catch {
    canvasSig = 'canvas-err';
  }

  const rawSignals = [
    navigator.userAgent || '',
    navigator.language || '',
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    String(navigator.hardwareConcurrency || 0),
    String(navigator.maxTouchPoints || 0),
    canvasSig
  ].join('|');

  try {
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const encoded = new TextEncoder().encode(rawSignals);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `dev_${hex.slice(0, 12)}`;
    }
  } catch {
    // Fallback below
  }

  return `dev_${fnv1aHex(rawSignals).slice(0, 12)}`;
}

/**
 * Compute 15-second TOTP-style rotating token for Kiosk QR verification.
 */
export async function generateRotatingQrToken(secretKey, branchCode, nowMs = Date.now()) {
  const slice = Math.floor(nowMs / (TOTP_STEP_SECONDS * 1000));
  const elapsedInSlice = Math.floor((nowMs % (TOTP_STEP_SECONDS * 1000)) / 1000);
  const expiresInSec = TOTP_STEP_SECONDS - elapsedInSlice;
  const input = `${secretKey}:${branchCode}:${slice}`;

  let tokenHex = '';
  try {
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      tokenHex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 10)
        .toUpperCase();
    } else {
      tokenHex = fnv1aHex(input).slice(0, 10).toUpperCase();
    }
  } catch {
    tokenHex = fnv1aHex(input).slice(0, 10).toUpperCase();
  }

  return {
    token: tokenHex,
    slice,
    expiresInSec,
    payload: `VECTRA|${branchCode}|${slice}|${tokenHex}`
  };
}

/**
 * Validate a scanned Kiosk QR payload against current and previous 15s slice.
 */
export async function verifyRotatingQrPayload(scannedPayload, secretKey, branchCode, nowMs = Date.now()) {
  if (!scannedPayload || typeof scannedPayload !== 'string') {
    return { valid: false, reason: 'Payload QR kosong.' };
  }
  const parts = scannedPayload.trim().split('|');
  if (parts.length !== 4 || parts[0] !== 'VECTRA') {
    return { valid: false, reason: 'Format token QR VECTRA tidak dikenali.' };
  }
  const [, code, sliceStr, token] = parts;
  if (code !== branchCode) {
    return { valid: false, reason: `QR milik cabang ${code}, bukan cabang Anda (${branchCode}).` };
  }
  const currentSlice = Math.floor(nowMs / (TOTP_STEP_SECONDS * 1000));
  const parsedSlice = Number(sliceStr);
  if (parsedSlice < currentSlice - 1 || parsedSlice > currentSlice + 1) {
    return { valid: false, reason: 'Token QR sudah kedaluwarsa (melebihi jendela 15 detik).' };
  }

  const expected = await generateRotatingQrToken(secretKey, branchCode, parsedSlice * TOTP_STEP_SECONDS * 1000);
  if (expected.token !== token) {
    return { valid: false, reason: 'Tanda tangan kriptografis QR tidak cocok.' };
  }
  return { valid: true, slice: parsedSlice, token };
}

// ----------------------------------------------------------------------------
// PURE-JS QR CODE MATRIX ENCODER (ISO/IEC 18004 Byte Mode, ECC-L/M)
// Zero third-party dependency so Kiosk QR renders crisply even offline.
// ----------------------------------------------------------------------------

const QR_GF_EXP = new Uint8Array(512);
const QR_GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    QR_GF_EXP[i] = x;
    QR_GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    QR_GF_EXP[i] = QR_GF_EXP[i - 255];
  }
})();

function qrGfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]];
}

function qrRsGeneratorPoly(ecCount) {
  let poly = [1];
  for (let i = 0; i < ecCount; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= qrGfMul(poly[j], QR_GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function qrRsEncode(data, ecCount) {
  const gen = qrRsGeneratorPoly(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const factor = res[i];
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j += 1) {
        res[i + j] ^= qrGfMul(gen[j], factor);
      }
    }
  }
  return res.slice(data.length);
}

// Version capacity specs for ECC Level L (single block versions 1..5)
const QR_VERSIONS_L = [
  null,
  { size: 21, totalCodewords: 26, ecCodewords: 7, dataCodewords: 19, align: [] },
  { size: 25, totalCodewords: 44, ecCodewords: 10, dataCodewords: 34, align: [6, 18] },
  { size: 29, totalCodewords: 70, ecCodewords: 15, dataCodewords: 55, align: [6, 22] },
  { size: 33, totalCodewords: 100, ecCodewords: 20, dataCodewords: 80, align: [6, 26] },
  { size: 37, totalCodewords: 134, ecCodewords: 26, dataCodewords: 108, align: [6, 30] }
];

function buildQrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  for (let v = 1; v < QR_VERSIONS_L.length; v += 1) {
    if (bytes.length + 2 <= QR_VERSIONS_L[v].dataCodewords) {
      ver = v;
      break;
    }
    ver = v;
  }
  const spec = QR_VERSIONS_L[ver];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
  };

  // Mode 0100 (Byte), 8-bit length (versions 1..9)
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = spec.dataCodewords * 8;
  const terminatorLen = Math.min(4, maxBits - bits.length);
  pushBits(0, terminatorLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byteVal = 0;
    for (let b = 0; b < 8; b += 1) byteVal = (byteVal << 1) | bits[i + b];
    dataBytes.push(byteVal);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (dataBytes.length < spec.dataCodewords) {
    dataBytes.push(padBytes[padIdx % 2]);
    padIdx += 1;
  }

  const ecBytes = qrRsEncode(new Uint8Array(dataBytes), spec.ecCodewords);
  const allCodewords = [...dataBytes, ...ecBytes];

  const n = spec.size;
  const modules = Array.from({ length: n }, () => new Array(n).fill(null));
  const isFunc = Array.from({ length: n }, () => new Array(n).fill(false));

  const setModule = (r, c, val, fn = true) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    modules[r][c] = val ? 1 : 0;
    if (fn) isFunc[r][c] = true;
  };

  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= n || c >= n) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(r, c, inOuter && (inBorder || inInner), true);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // Alignment pattern for versions >= 2
  if (spec.align.length >= 2) {
    const pos = spec.align[1];
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        setModule(pos + dr, pos + dc, dark, true);
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < n - 8; i += 1) {
    if (!isFunc[6][i]) setModule(6, i, i % 2 === 0, true);
    if (!isFunc[i][6]) setModule(i, 6, i % 2 === 0, true);
  }

  // Dark module & reserve format info areas
  setModule(n - 8, 8, 1, true);
  for (let i = 0; i < 9; i += 1) {
    if (!isFunc[8][i]) isFunc[8][i] = true;
    if (!isFunc[i][8]) isFunc[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    if (!isFunc[8][n - 1 - i]) isFunc[8][n - 1 - i] = true;
    if (!isFunc[n - 1 - i][8]) isFunc[n - 1 - i][8] = true;
  }

  // Place data bits in zigzag
  const bitStream = [];
  for (const cw of allCodewords) {
    for (let b = 7; b >= 0; b -= 1) bitStream.push((cw >>> b) & 1);
  }
  let bitIndex = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < n; step += 1) {
      const r = upward ? n - 1 - step : step;
      for (let colOffset = 0; colOffset < 2; colOffset += 1) {
        const c = right - colOffset;
        if (!isFunc[r][c]) {
          const rawBit = bitIndex < bitStream.length ? bitStream[bitIndex] : 0;
          bitIndex += 1;
          // Mask pattern 0: (r + c) % 2 === 0
          const masked = ((r + c) % 2 === 0) ? rawBit ^ 1 : rawBit;
          modules[r][c] = masked;
        }
      }
    }
    upward = !upward;
  }

  // Format bits for ECC Level L (01) + Mask 0 (000) -> 15-bit BCH + mask 0x5412 = 0x77C4
  const formatVal = 0x77c4;
  for (let i = 0; i < 15; i += 1) {
    const bit = (formatVal >>> (14 - i)) & 1;
    if (i < 6) modules[8][i] = bit;
    else if (i < 8) modules[8][i + 1] = bit;
    else modules[8][n - 15 + i] = bit;

    if (i < 8) modules[n - 1 - i][8] = bit;
    else if (i === 8) modules[7][8] = bit;
    else modules[14 - i][8] = bit;
  }

  return modules;
}

/**
 * Draw crisp QR matrix onto a target <canvas> element.
 */
export function drawQrCodeToCanvas(canvas, text, fgColor = '#111815', bgColor = '#FFFFFF') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const matrix = buildQrMatrix(text);
  const count = matrix.length;
  const quiet = 3;
  const total = count + quiet * 2;
  const size = canvas.width || 240;
  const cell = Math.floor(size / total);
  const offset = Math.floor((size - cell * count) / 2);

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = fgColor;
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (matrix[r][c]) {
        ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
      }
    }
  }
}

// ----------------------------------------------------------------------------
// LIVE CAMERA & METADATA CANVAS WATERMARK ENGINE
// ----------------------------------------------------------------------------

export async function startLiveCamera(videoEl) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Browser tidak mendukung akses kamera getUserMedia.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
    audio: false
  });
  if (videoEl) {
    videoEl.srcObject = stream;
    await videoEl.play();
  }
  return stream;
}

export function stopCameraStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

/**
 * Draw realistic fallback camera frame on canvas when running on headless/no-webcam machines in Demo Mode.
 */
export function renderDemoCameraFrame(canvas, employeeName = 'Karyawan', branchName = 'Cabang') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#1E2823';
  ctx.fillRect(0, 0, w, h);

  // Subtle industrial framing reticle
  ctx.strokeStyle = '#65A30D';
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 28, w - 64, h - 140);

  // Geometric avatar silhouette
  ctx.fillStyle = '#33443C';
  ctx.beginPath();
  ctx.arc(w / 2, h / 2 - 65, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(w / 2 - 92, h / 2 + 6, 184, 110, 28);
  ctx.fill();

  ctx.fillStyle = '#ECFCCB';
  ctx.font = '600 18px Poppins, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`LIVE CHECK-IN PREVIEW: ${employeeName}`, w / 2, 62);
  ctx.fillStyle = '#D1D5DB';
  ctx.font = '400 13px Poppins, sans-serif';
  ctx.fillText(`Lokasi Terverifikasi: ${branchName}`, w / 2, 86);
  ctx.textAlign = 'left';
}

/**
 * Capture video or canvas frame onto HTML5 canvas and burn immutable audit watermark.
 */
export async function captureWatermarkedPhoto(sourceEl, meta) {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#111815';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (sourceEl) {
    const srcW = sourceEl.videoWidth || sourceEl.width || 800;
    const srcH = sourceEl.videoHeight || sourceEl.height || 600;
    const scale = Math.max(canvas.width / srcW, canvas.height / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    const dx = (canvas.width - dw) / 2;
    const dy = (canvas.height - dh) / 2;
    ctx.drawImage(sourceEl, dx, dy, dw, dh);
  }

  // Burn permanent metadata stamp on bottom strip
  const barHeight = 112;
  const barY = canvas.height - barHeight;
  ctx.fillStyle = 'rgba(17, 24, 21, 0.90)';
  ctx.fillRect(0, barY, canvas.width, barHeight);
  ctx.fillStyle = '#84CC16';
  ctx.fillRect(0, barY, canvas.width, 3);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '600 16px Poppins, sans-serif';
  ctx.fillText(
    `${meta.employeeCode || 'EMP'} | ${meta.fullName || 'User'} | ${meta.branchName || 'Cabang'}`,
    20,
    barY + 30
  );

  ctx.fillStyle = '#D1D5DB';
  ctx.font = '500 14px Poppins, sans-serif';
  const latStr = meta.lat != null ? Number(meta.lat).toFixed(6) : '-';
  const lonStr = meta.lon != null ? Number(meta.lon).toFixed(6) : '-';
  const distStr = meta.distanceMeters != null ? `${Math.round(meta.distanceMeters)}m` : 'WFH/Dinas';
  const accStr = meta.accuracy != null ? `${Math.round(meta.accuracy)}m` : '-';
  ctx.fillText(
    `GPS: ${latStr}, ${lonStr} | Jarak: ${distStr} | Akurasi: ${accStr} | Mode: ${meta.workMode || 'WFO'}`,
    20,
    barY + 58
  );

  ctx.fillStyle = '#A3E635';
  ctx.font = '500 13px Poppins, sans-serif';
  ctx.fillText(
    `Server: ${meta.serverTimeLabel || formatWibDateTime()} | Device: ${meta.deviceHash || '-'} | ${meta.method || 'GPS_SELFIE'}`,
    20,
    barY + 86
  );

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return { dataUrl, blob };
}

export function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const [header, b64] = dataUrl.split(',');
  if (!b64) return null;
  const mimeMatch = header.match(/data:([^;]+);base64/i);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

// ----------------------------------------------------------------------------
// OFFLINE-FIRST INDEXEDDB ATTENDANCE QUEUE
// ----------------------------------------------------------------------------

const DB_NAME = 'vectra_offline_db';
const STORE_NAME = 'pending_attendance';
const LS_FALLBACK_KEY = 'vectra_offline_queue_fallback';

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const OfflineQueue = {
  async enqueue(item) {
    const entry = {
      ...item,
      localId: `off_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      queuedAt: new Date().toISOString()
    };
    try {
      const db = await openOfflineDb();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(entry);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
      return entry;
    } catch {
      const current = JSON.parse(localStorage.getItem(LS_FALLBACK_KEY) || '[]');
      const { photoBlob: _omitBlob, ...serializablePayload } = entry.payload || {};
      current.push({ ...entry, payload: serializablePayload });
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(current));
      return entry;
    }
  },

  async getAll() {
    try {
      const db = await openOfflineDb();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    } catch {
      return JSON.parse(localStorage.getItem(LS_FALLBACK_KEY) || '[]');
    }
  },

  async remove(localId) {
    try {
      const db = await openOfflineDb();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).delete(localId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    } catch {
      const current = JSON.parse(localStorage.getItem(LS_FALLBACK_KEY) || '[]');
      localStorage.setItem(
        LS_FALLBACK_KEY,
        JSON.stringify(current.filter((x) => x.localId !== localId))
      );
    }
  }
};
