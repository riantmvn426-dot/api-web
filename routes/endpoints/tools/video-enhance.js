'use strict';

const { Router }  = require('express');
const axios        = require('axios');
const FormData      = require('form-data');
const fs             = require('fs');
const path            = require('path');

const { asyncHandler, ValidationError, validate } = require('../../../utils/validation');
const { sendSuccessResponse }                      = require('../../../config/apikeyConfig');

const router = Router();

// ── free.ai config (hardcoded, tanpa env) ───────────────────────────────────
const BASE  = 'https://free.ai';
const API   = 'https://api.free.ai';
const EMAIL    = 'dongtubecs@gmail.com';
const PASSWORD = '12345678';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const NOISE_LEVELS = ['low', 'med', 'high'];

// Cache sesi supaya tidak login ulang tiap request
let sessionCache = { jar: null, apiKey: null, expiry: 0 };

// ── utilitas cookie ──────────────────────────────────────────────────────────
function parseCookies(res) {
  const out = {};
  const raw = res.headers['set-cookie'] || [];
  for (const c of raw) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── 1. login ──────────────────────────────────────────────────────────────────
async function login() {
  const jar = {};
  const r1 = await axios.get(`${BASE}/login/`, {
    headers: { 'User-Agent': UA },
    maxRedirects: 5,
    validateStatus: () => true,
  });
  Object.assign(jar, parseCookies(r1));

  const html = r1.data || '';
  const fm = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/);
  if (!fm) throw new ValidationError('CSRF token tidak ditemukan di halaman login free.ai.', 502);
  const formToken = fm[1];

  const r2 = await axios.post(`${BASE}/login/`, new URLSearchParams({
    csrfmiddlewaretoken: formToken,
    email: EMAIL,
    password: PASSWORD,
  }), {
    headers: {
      'User-Agent':   UA,
      'Referer':      `${BASE}/login/`,
      'Origin':       BASE,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       cookieHeader(jar),
    },
    maxRedirects: 0,
    validateStatus: s => s === 302 || s === 200,
  });
  Object.assign(jar, parseCookies(r2));

  const ok = /(sessionid=[^;]+)/.test(cookieHeader(jar));
  if (!ok) throw new ValidationError('Login ke free.ai gagal — cek email/password.', 502);
  return jar;
}

// ── 2. session-token → api_key ───────────────────────────────────────────────
async function getSession(jar) {
  const csrf = (jar.csrftoken || '').split(';')[0].split('=').pop();
  const r = await axios.post(`${BASE}/api/v1/session-token/`, null, {
    headers: {
      'User-Agent':   UA,
      'Referer':      `${BASE}/`,
      'Origin':       BASE,
      'Cookie':       cookieHeader(jar),
      'X-CSRFToken':  csrf,
    },
    maxRedirects: 5,
    validateStatus: () => true,
  });
  const d = r.data || {};
  if (!d.authenticated || !d.api_key) {
    throw new ValidationError('Session free.ai tidak terautentikasi.', 502);
  }
  return d;
}

async function getSessionCached() {
  if (sessionCache.apiKey && Date.now() < sessionCache.expiry) return sessionCache;
  const jar = await login();
  const session = await getSession(jar);
  sessionCache = { jar, apiKey: session.api_key, plan: session.plan, credits: session.credits, expiry: Date.now() + 3600_000 };
  return sessionCache;
}

// ── download video sumber (dari url yang dikirim user) ───────────────────────
async function downloadVideo(videoUrl) {
  try {
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 150000,
      headers: { 'User-Agent': UA },
    });
    return Buffer.from(response.data);
  } catch (e) {
    throw new ValidationError(`Gagal download video: ${e.message}`, 400);
  }
}

// ── 3. upload-temp + 4. enhance ───────────────────────────────────────────────
async function uploadTemp(apiKey, filePath) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'video/mp4',
  });
  const up = await axios.post(`${API}/v1/upload-temp/`, fd, {
    headers: { 'User-Agent': UA, 'Authorization': `Bearer ${apiKey}`, ...fd.getHeaders() },
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });
  if (up.status !== 200) {
    throw new ValidationError('Upload ke free.ai gagal: ' + JSON.stringify(up.data || {}), 502);
  }
  return up.data;
}

async function enhance(apiKey, filePath, noise) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'video/mp4',
  });
  if (noise && NOISE_LEVELS.includes(noise)) fd.append('noise', noise);

  const r = await axios.post(`${API}/v1/video/enhance/`, fd, {
    headers: { 'User-Agent': UA, 'Authorization': `Bearer ${apiKey}`, ...fd.getHeaders() },
    timeout: 400000,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });
  if (r.status !== 200) {
    throw new ValidationError(`Enhance gagal (HTTP ${r.status}): ` + JSON.stringify(r.data || {}), 502);
  }
  return r.data;
}

async function enhanceVideo(videoUrl, noise) {
  const videoBuffer = await downloadVideo(videoUrl);
  if (!videoBuffer || videoBuffer.length === 0) {
    throw new ValidationError('Gagal download video dari URL.', 400);
  }
  if (videoBuffer.length > 100 * 1024 * 1024) {
    throw new ValidationError('Ukuran video maksimal 100MB.', 400);
  }

  let ext = '.mp4';
  try { ext = path.extname(new URL(videoUrl).pathname) || '.mp4'; } catch (e) {}
  const tmpFile = path.join('/tmp', `enhance-${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, videoBuffer);

  try {
    const session = await getSessionCached();
    const uploadInfo = await uploadTemp(session.apiKey, tmpFile);
    const result = await enhance(session.apiKey, tmpFile, noise);

    return {
      video_url:    result.video_url || result.url,
      share_url:    result.share_url,
      duration:     result.duration,
      tokens_used:  result.tokens,
      noise:        result.noise,
      sharpness:    result.sharpness,
      color:        result.color,
      filter_chain: result.filter_chain,
      upload:       uploadInfo,
      account:      { plan: session.plan, credits: session.credits },
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// ── Handler bersama GET & POST ────────────────────────────────────────────────
async function handle(input, res) {
  const url   = String(input.url || '').trim();
  const noise = String(input.noise || 'low');

  const v = validate.fields({ url }, { url: { required: true, type: 'string' } });
  if (!v.valid) throw new ValidationError(v.errors.join(', '), 400);

  if (!NOISE_LEVELS.includes(noise)) {
    throw new ValidationError(`noise harus salah satu dari: ${NOISE_LEVELS.join(', ')}`, 400);
  }

  sendSuccessResponse(res, await enhanceVideo(url, noise));
}

// ── GET ────────────────────────────────────────────────────────────────────────
router.get('/api/video/enhance', asyncHandler(async (req, res) => {
  await handle(req.query, res);
}));

// ── POST ───────────────────────────────────────────────────────────────────────
router.post('/api/video/enhance', asyncHandler(async (req, res) => {
  await handle(req.body, res);
}));

// ── Metadata ───────────────────────────────────────────────────────────────────
router.metadata = {
  name:        'Video Enhance',
  path:        '/api/video/enhance',
  methods:     ['GET', 'POST'],
  category:    'MEDIA',
  description: 'Tingkatkan kualitas video (AI quality boost) lewat free.ai — login, upload-temp, lalu enhance.',
  params: [
    { name: 'url',   type: 'text',   required: true,  placeholder: 'https://.../video.mp4', description: 'URL video sumber (bisa dari endpoint /download/*).' },
    { name: 'noise', type: 'select', required: false, value: ['low', 'med', 'high'], default: 'low', description: 'Level noise reduction.' },
  ],
};

module.exports = router;
