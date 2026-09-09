// services/xtreamApi.js
// Device-side client for the user's Xtream Codes provider.
//
// The user's host/username/password are held in module state (set by
// AuthContext after login or signup). This means screens just call e.g.
//   xtreamApi.getLiveCategories()
// without having to thread creds through every layer.
//
// We talk to the user's provider DIRECTLY — the app's backend is just the
// credential vault, it doesn't proxy IPTV traffic.

let _host = null;
let _user = null;
let _pass = null;

function normaliseHost(h) {
  if (!h) return null;
  let s = String(h).trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

export function setXtreamCreds({ host, username, password }) {
  _host = normaliseHost(host);
  _user = username || null;
  _pass = password || null;
}

export function clearXtreamCreds() {
  _host = _user = _pass = null;
}

// ---------------------------------------------------------------------------
// Demo mode.
//
// The 'demo' playlist type has no provider, so any call that would hit the
// network has to be answered locally instead. Handling it here rather than in
// each screen keeps the seam in one place: screens carry on calling
// xtreamApi.getShortEpg() and xtreamApi.authPing() exactly as they do for a
// real provider, and get provider-shaped responses back.
// ---------------------------------------------------------------------------
let _demo = false;

export function setDemoMode(on) {
  _demo = !!on;
  if (_demo) _host = _user = _pass = null;
}

export function isDemoMode() {
  return _demo;
}

// Provider-shaped short-EPG payload: a 45-minute grid centred on now, so
// now/next is always populated. Titles are plain text; the app's decoder
// passes non-base64 strings through unchanged.
function demoShortEpg(streamId, limit) {
  const stride = 45 * 60;
  const now = Math.floor(Date.now() / 1000);
  const start0 = now - stride - (now % stride);
  const count = Math.max(1, Number(limit) || 4);
  const epg_listings = Array.from({ length: count }, (_, i) => {
    const start = start0 + i * stride;
    return {
      id: `demo_epg_${streamId}_${i}`,
      start_timestamp: String(start),
      stop_timestamp: String(start + stride),
      title: `Programme ${i + 1}`,
      description: `Placeholder programme description for ${streamId}.`,
    };
  });
  return { epg_listings };
}

export function getXtreamCreds() {
  return { host: _host, username: _user, password: _pass };
}

function require_(name, value) {
  if (!value) throw new Error(`xtream creds missing: ${name}`);
}

function apiUrl(params = {}) {
  require_('host', _host);
  require_('username', _user);
  require_('password', _pass);
  const qs = new URLSearchParams({ username: _user, password: _pass, ...params });
  return `${_host}/player_api.php?${qs.toString()}`;
}

async function fetchJsonOnce(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        accept: 'application/json',
        // some panels reject the default React Native user-agent
        'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
      },
    });
    if (!r.ok) throw new Error(`Xtream HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Panels are frequently served with expired/self-signed certificates (a
// browser lets you click through, fetch cannot) or only on plain http. A
// failed request is retried once with the opposite scheme before giving up.
async function getJSON(url, { timeoutMs = 45000 } = {}) {
  try {
    return await fetchJsonOnce(url, timeoutMs);
  } catch (e) {
    const alt = /^https:/i.test(url)
      ? url.replace(/^https:/i, 'http:')
      : /^http:/i.test(url) ? url.replace(/^http:/i, 'https:') : null;
    if (!alt) throw e;
    try {
      return await fetchJsonOnce(alt, timeoutMs);
    } catch (e2) {
      const msg = String(e?.message || e || '');
      if (/abort/i.test(msg)) {
        throw new Error('The provider took too long to respond. Check your connection and try again.');
      }
      throw new Error(
        `Could not reach your provider (${msg || 'network error'}). ` +
        'If the link opens in a browser but not here, the server may use an ' +
        'expired certificate — try entering the host as http:// instead of https://.'
      );
    }
  }
}

// ---- account info ----
export async function authPing() {
  if (_demo) {
    return {
      user_info: {
        auth: 1,
        status: 'Demo',
        exp_date: null,
        is_trial: '0',
        max_connections: '1',
      },
    };
  }
  const data = await getJSON(apiUrl());
  if (!data?.user_info || Number(data.user_info.auth) !== 1) {
    throw new Error('Your provider rejected these credentials. Check the username and password.');
  }
  return data;
}

/**
 * Interpret the provider's user_info block.
 *
 * A subscription can be accepted for auth (auth: 1) but still be unusable —
 * expired, banned, or disabled — in which case the catalogue calls return
 * empty or error out in confusing ways. Callers should check this BEFORE
 * committing to a full catalogue download.
 *
 * Returns { ok, expired, banned, status, expDate, daysLeft, message }
 */
export function accountState(userInfo) {
  const status = String(userInfo?.status || '').trim();
  const lower = status.toLowerCase();
  const expTs = Number(userInfo?.exp_date || 0);
  const now = Math.floor(Date.now() / 1000);

  const expired = lower === 'expired' || (expTs > 0 && expTs < now);
  const banned = lower === 'banned' || lower === 'disabled';
  const expDate = expTs > 0 ? new Date(expTs * 1000) : null;
  const daysLeft = expTs > 0 ? Math.ceil((expTs - now) / 86400) : null;

  let message = null;
  if (expired) {
    message = expDate
      ? `This subscription expired on ${expDate.toLocaleDateString()}. Renew it with your provider, then try again.`
      : 'This subscription has expired. Renew it with your provider, then try again.';
  } else if (banned) {
    message = `This account is ${status.toLowerCase()}. Contact your provider.`;
  }

  return { ok: !expired && !banned, expired, banned, status, expDate, daysLeft, message };
}

/**
 * Ping the provider and evaluate the subscription in one step.
 * Throws on network/credential failure; returns the account state otherwise.
 */
export async function checkAccount() {
  const data = await authPing();
  return { ...accountState(data.user_info), userInfo: data.user_info };
}

// ---- categories ----
export async function getLiveCategories()   { return getJSON(apiUrl({ action: 'get_live_categories' })); }
export async function getVodCategories()    { return getJSON(apiUrl({ action: 'get_vod_categories' })); }
export async function getSeriesCategories() { return getJSON(apiUrl({ action: 'get_series_categories' })); }

// ---- streams ----
export async function getLiveStreams(categoryId) {
  return getJSON(apiUrl(categoryId != null
    ? { action: 'get_live_streams', category_id: String(categoryId) }
    : { action: 'get_live_streams' }
  ));
}
export async function getVodStreams(categoryId) {
  return getJSON(apiUrl(categoryId != null
    ? { action: 'get_vod_streams', category_id: String(categoryId) }
    : { action: 'get_vod_streams' }
  ));
}
export async function getSeries(categoryId) {
  return getJSON(apiUrl(categoryId != null
    ? { action: 'get_series', category_id: String(categoryId) }
    : { action: 'get_series' }
  ));
}

// ---- details ----
export async function getVodInfo(vodId) {
  return getJSON(apiUrl({ action: 'get_vod_info', vod_id: String(vodId) }));
}
export async function getSeriesInfo(seriesId) {
  return getJSON(apiUrl({ action: 'get_series_info', series_id: String(seriesId) }));
}

// ---- EPG ----
export async function getShortEpg(streamId, limit = 4) {
  if (_demo) return demoShortEpg(streamId, limit);
  return getJSON(apiUrl({ action: 'get_short_epg', stream_id: String(streamId), limit }));
}
// Full EPG table for one channel — includes past programmes with
// has_archive flags, used by the Catch-Up screen.
export async function getSimpleDataTable(streamId) {
  return getJSON(apiUrl({ action: 'get_simple_data_table', stream_id: String(streamId) }));
}
// Returns the URL for the full XMLTV dump. Caller decides whether to parse it.
export function getXmltvUrl() {
  require_('host', _host); require_('username', _user); require_('password', _pass);
  return `${_host}/xmltv.php?username=${encodeURIComponent(_user)}&password=${encodeURIComponent(_pass)}`;
}

// ---- stream URLs (the bit that goes into the video player) ----
//
// Xtream URL shapes:
//   Live:   {host}/live/{user}/{pass}/{stream_id}.ts
//           (some panels also serve HLS at {host}/{user}/{pass}/{stream_id}.m3u8)
//   VOD:    {host}/movie/{user}/{pass}/{stream_id}.{ext}
//   Series: {host}/series/{user}/{pass}/{episode_id}.{ext}
export function liveStreamUrl(streamId, { hls = false } = {}) {
  require_('host', _host); require_('username', _user); require_('password', _pass);
  return hls
    ? `${_host}/live/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${streamId}.m3u8`
    : `${_host}/live/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${streamId}.ts`;
}
export function vodStreamUrl(streamId, ext = 'mp4') {
  require_('host', _host); require_('username', _user); require_('password', _pass);
  return `${_host}/movie/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${streamId}.${ext || 'mp4'}`;
}
export function episodeStreamUrl(episodeId, ext = 'mp4') {
  require_('host', _host); require_('username', _user); require_('password', _pass);
  return `${_host}/series/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${episodeId}.${ext || 'mp4'}`;
}
// Catch-up / timeshift replay of a past programme:
//   {host}/timeshift/{user}/{pass}/{durationMinutes}/{YYYY-MM-DD:HH-MM}/{streamId}.ts
// startTs is a unix timestamp (seconds, provider-local time as given by EPG).
export function timeshiftUrl(streamId, startTs, durationMinutes) {
  require_('host', _host); require_('username', _user); require_('password', _pass);
  const d = new Date(startTs * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}:${p(d.getHours())}-${p(d.getMinutes())}`;
  return `${_host}/timeshift/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${Math.max(1, Math.round(durationMinutes))}/${stamp}/${streamId}.ts`;
}

export default {
  setXtreamCreds, clearXtreamCreds, getXtreamCreds,
  setDemoMode, isDemoMode,
  authPing, accountState, checkAccount,
  getLiveCategories, getVodCategories, getSeriesCategories,
  getLiveStreams, getVodStreams, getSeries,
  getVodInfo, getSeriesInfo,
  getShortEpg, getSimpleDataTable, getXmltvUrl,
  liveStreamUrl, vodStreamUrl, episodeStreamUrl, timeshiftUrl,
};
