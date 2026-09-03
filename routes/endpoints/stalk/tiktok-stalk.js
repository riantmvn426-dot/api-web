'use strict';

const { Router } = require('express');
const https       = require('https');

const { asyncHandler, ValidationError, validate } = require('../../../utils/validation');
const { sendSuccessResponse }                      = require('../../../config/apikeyConfig');

const router = Router();

const SOLVER = 'https://cf.dongtube.cyou/v1';

function fetchPage(url, timeout = 30000) {
  return new Promise((ok, no) => {
    const body = JSON.stringify({ url, maxTimeout: 60 });
    const r = https.request(SOLVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { ok(JSON.parse(d)); } catch { no(new Error('parse error')); } });
    });
    r.on('error', no);
    r.on('timeout', () => { r.destroy(); no(new Error('timeout')); });
    r.write(body);
    r.end();
  });
}

async function stalkTikTokV2(username) {
  const clean = String(username).replace(/^@/, '').trim();
  if (!clean) throw new ValidationError('Username tidak boleh kosong.', 400);

  let resp;
  try {
    resp = await fetchPage('https://www.tiktok.com/@' + clean);
  } catch (e) {
    throw new ValidationError(`Gagal menghubungi solver: ${e.message}`, 502);
  }
  if (resp.status !== 'ok') throw new ValidationError(resp.message || 'Solver gagal memproses request.', 502);

  const html = Buffer.from(resp.solution.body, 'base64').toString('utf8');
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new ValidationError('Gagal parse data TikTok.', 502);

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new ValidationError('Gagal parse JSON data TikTok.', 502);
  }

  const ud = data['__DEFAULT_SCOPE__']?.['webapp.user-detail'] || {};
  const u  = ud.userInfo?.user  || {};
  const s  = ud.userInfo?.stats || {};
  if (!u.uniqueId && !u.nickname) throw new ValidationError(`User "${clean}" tidak ditemukan di TikTok.`, 404);

  const followers = s.followerCount  || 0;
  const likes     = s.heartCount     || 0;
  const videos    = s.videoCount     || 0;
  const following = s.followingCount || 0;

  const avgLikesPerVideo   = videos ? Math.round(likes / videos) : 0;
  const engagementRate     = (followers && videos) ? ((likes / followers / videos) * 100).toFixed(2) : '0.00';
  const estimatedEarnings  = avgLikesPerVideo ? Math.round(avgLikesPerVideo * 0.00005) : 0;
  const fanRatio           = following ? (followers / following).toFixed(1) : '0';

  return {
    profile: {
      username:  u.uniqueId || clean,
      nickname:  u.nickname || '',
      avatar:    u.avatarLarger || u.avatarThumb || '',
      bio:       u.signature || '',
      verified:  u.verified || false,
      private:   u.private || false,
      followers, following, likes, videos,
    },
    analytics: {
      engagementRate:            engagementRate + '%',
      avgLikesPerVideo,
      estimatedEarningsPerPost:  '$' + estimatedEarnings,
      fanRatio:                  fanRatio + ':1',
      heartPerFollower:          followers ? (likes / followers).toFixed(2) : '0',
    },
    statsRaw: ud.userInfo?.statsV2 || {},
  };
}

// ── GET ──────────────────────────────────────────────────────────────────────
router.get('/api/stalk/tiktok-v2', asyncHandler(async (req, res) => {
  const username = req.query.username || req.query.user || req.query.q || '';
  const v = validate.fields({ username }, { username: { required: true, type: 'string' } });
  if (!v.valid) throw new ValidationError(v.errors.join(', '), 400);

  sendSuccessResponse(res, await stalkTikTokV2(username));
}));

// ── POST ─────────────────────────────────────────────────────────────────────
router.post('/api/stalk/tiktok-v2', asyncHandler(async (req, res) => {
  const username = req.body.username || req.body.user || req.body.q || '';
  const v = validate.fields({ username }, { username: { required: true, type: 'string' } });
  if (!v.valid) throw new ValidationError(v.errors.join(', '), 400);

  sendSuccessResponse(res, await stalkTikTokV2(username));
}));

// ── Metadata ─────────────────────────────────────────────────────────────────
router.metadata = {
  name:        'TikTok Stalk V2',
  path:        '/api/stalk/tiktok-v2',
  methods:     ['GET', 'POST'],
  category:    'STALK',
  description: 'Ambil profil & analitik dasar TikTok (followers, likes, engagement rate, estimasi earnings) via CF-solver.',
  params: [
    {
      name:        'username',
      type:        'text',
      required:    true,
      placeholder: 'tiktokusername',
      description: 'Username TikTok target, dengan atau tanpa @.',
    },
  ],
};

module.exports = router;
