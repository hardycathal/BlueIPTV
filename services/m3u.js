// services/m3u.js
// M3U / M3U8 playlist support: download, parse, and classify entries.
//
// M3U is the universal IPTV format but far less structured than Xtream:
//   - categories come from group-title attributes
//   - anything with a video-file extension is treated as a movie (VOD)
//   - there is no series/season structure, no plot/rating metadata, no EPG
//
// Entries are given synthetic stream ids ("m3u_<n>") and carry their playback
// URL in `direct_url`, which the player uses instead of building Xtream URLs.

const VOD_EXT_RE = /\.(mp4|mkv|avi|mov|flv|wmv|webm|m4v)(\?.*)?$/i;

export function isVodUrl(url) {
  return VOD_EXT_RE.test(String(url || ''));
}

export function containerFromUrl(url) {
  const m = String(url || '').match(VOD_EXT_RE);
  return m ? m[1].toLowerCase() : 'mp4';
}

export function parseM3u(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  let meta = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(line))) attrs[m[1].toLowerCase()] = m[2];
      const commaIdx = line.indexOf(',');
      const trailing = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      meta = {
        name: trailing || attrs['tvg-name'] || 'Unknown',
        logo: attrs['tvg-logo'] || null,
        group: attrs['group-title'] || 'Uncategorised',
        epgId: attrs['tvg-id'] || null,
      };
    } else if (line.startsWith('#')) {
      // other directives (#EXTM3U, #EXTVLCOPT…) — ignore
    } else if (meta) {
      entries.push({ ...meta, url: line });
      meta = null;
    }
  }
  return entries;
}

function swapScheme(url) {
  const s = String(url);
  if (/^https:\/\//i.test(s)) return s.replace(/^https:/i, 'http:');
  if (/^http:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
  return null;
}

async function fetchOnce(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: {
        // some panels reject the default RN user-agent
        'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        accept: '*/*',
      },
    });
    if (!r.ok) throw new Error(`Playlist HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a playlist. Providers commonly serve M3U over plain http or with
 * an expired TLS certificate (browsers let you click through, fetch cannot),
 * so a failure is retried once with the opposite scheme before giving up.
 * Returns the text; throws with a readable message.
 */
export async function fetchM3uText(url, { timeoutMs = 60000 } = {}) {
  let raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;

  let text = null;
  let firstErr = null;
  try {
    text = await fetchOnce(raw, timeoutMs);
  } catch (e) {
    firstErr = e;
    const alt = swapScheme(raw);
    if (alt) {
      try {
        text = await fetchOnce(alt, timeoutMs);
      } catch (e2) {
        // fall through to the error below
      }
    }
  }

  if (text == null) {
    const msg = String(firstErr?.message || firstErr || '');
    if (/aborted|abort/i.test(msg)) {
      throw new Error('Playlist download timed out. The server may be slow or the playlist very large.');
    }
    throw new Error(
      `Could not download the playlist (${msg || 'network error'}). ` +
      'If the URL opens in a browser but not here, the server may use an expired ' +
      'certificate — try the http:// version of the link.'
    );
  }

  if (!text.includes('#EXTINF')) {
    throw new Error('That URL did not return an M3U playlist (no #EXTINF entries found).');
  }
  return text;
}

// Validates the URL by downloading and parsing it. Returns entry counts.
export async function validateM3u(url) {
  const text = await fetchM3uText(url);
  const entries = parseM3u(text);
  if (!entries.length) throw new Error('Playlist contains no entries');
  const vod = entries.filter((e) => isVodUrl(e.url)).length;
  return { total: entries.length, vod, live: entries.length - vod };
}

export default { parseM3u, fetchM3uText, validateM3u, isVodUrl, containerFromUrl };
