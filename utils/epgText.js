// utils/epgText.js
// Xtream short-EPG responses base64-encode titles/descriptions. These helpers
// decode them defensively (some panels send plain text).

export function decodeMaybeBase64(value) {
  if (!value) return '';
  const text = String(value);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return text;
  try {
    const decoded = typeof atob === 'function' ? atob(text) : text;
    const cleaned = decoded.replace(/[^\x20-\x7E]+/g, ' ').trim();
    return cleaned || text;
  } catch {
    return text;
  }
}

export function parseShortEpg(response) {
  const listings = Array.isArray(response?.epg_listings) ? response.epg_listings : [];
  return listings
    .map((e) => {
      const start = Number(e.start_timestamp ?? e.start_ts ?? e.start);
      const stop = Number(e.stop_timestamp ?? e.stop_ts ?? e.end ?? e.stop);
      if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return null;
      return {
        start_ts: start,
        stop_ts: stop,
        title: decodeMaybeBase64(e.title),
        description: decodeMaybeBase64(e.description),
      };
    })
    .filter(Boolean);
}

export function timeLabel(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
