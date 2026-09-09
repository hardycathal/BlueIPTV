// services/catalogueSync.js
// First-run sync: pulls the user's full catalogue (categories + flat stream
// lists for live/vod/series) from their Xtream provider and writes it into
// SQLite via the bulk-upsert helpers in database/iptv.js.
//
// Detail payloads (get_vod_info, get_series_info, EPG) are intentionally
// NOT pulled here — those are fetched lazily when the user opens an item.
// First sync should feel fast and finish in well under a minute even on
// providers with 20k channels.

import xtream from './xtreamApi';
import * as iptv from '../database/iptv';
import { fetchM3uText, parseM3u, isVodUrl, containerFromUrl } from './m3u';
import * as demo from './demoData';

/**
 * Run a full catalogue sync, reporting progress via the supplied callback.
 *
 *   onProgress({ step, label, percent })
 *     step:    'init' | 'live_cats' | 'live_streams' | 'vod_cats' | 'vod_streams'
 *              | 'series_cats' | 'series' | 'done' | 'error'
 *     label:   human-readable description
 *     percent: 0-100
 */
export async function runFullSync(onProgress = () => {}, playlist = null) {
  const report = (step, label, percent, code = null) => onProgress({ step, label, percent, code });

  if (playlist?.type === 'demo') return runDemoSync(report);
  if (playlist?.type === 'm3u') return runM3uSync(playlist, report);

  try {
    report('init', 'Preparing local database', 0);
    await iptv.initDb();

    // Check the subscription before committing to a full catalogue download —
    // an expired account authenticates fine but returns empty/failing lists.
    report('init', 'Checking your subscription', 3);
    const account = await xtream.checkAccount();
    if (!account.ok) {
      const err = new Error(account.message || 'This subscription is not active.');
      err.code = account.expired ? 'EXPIRED' : 'INACTIVE';
      throw err;
    }

    report('live_cats', 'Loading live TV categories', 5);
    const liveCats = await xtream.getLiveCategories();
    await iptv.replaceCategories('live', liveCats || []);

    report('live_streams', 'Loading live TV channels', 15);
    const liveStreams = await xtream.getLiveStreams();
    await iptv.replaceLiveStreams(liveStreams || []);

    report('vod_cats', 'Loading movie categories', 35);
    const vodCats = await xtream.getVodCategories();
    await iptv.replaceCategories('vod', vodCats || []);

    report('vod_streams', 'Loading movies', 45);
    const vodStreams = await xtream.getVodStreams();
    await iptv.replaceVodStreams(vodStreams || []);

    report('series_cats', 'Loading series categories', 70);
    const seriesCats = await xtream.getSeriesCategories();
    await iptv.replaceCategories('series', seriesCats || []);

    report('series', 'Loading series', 80);
    const series = await xtream.getSeries();
    await iptv.replaceSeries(series || []);

    await iptv.setSyncMeta('last_full_sync_at', Date.now());
    report('done', 'Catalogue ready', 100);
  } catch (err) {
    report('error', err?.message || 'Sync failed', 0, err?.code || null);
    throw err;
  }
}

/**
 * Demo sync: seeds a synthetic catalogue with neutral placeholder names.
 *
 * Touches no network and needs no provider. It writes through the same bulk
 * writers the real syncs use, so every screen afterwards is reading genuine
 * SQLite rows rather than mocked component state — which is the point: it
 * exercises the real code path, and it makes the app screenshottable and
 * manually testable without pointing it at somebody's live subscription.
 */
async function runDemoSync(report) {
  try {
    report('init', 'Preparing local database', 0);
    await iptv.initDb();

    report('live_cats', 'Building demo categories', 10);
    await iptv.replaceCategories('live', demo.demoLiveCategories());

    report('live_streams', 'Building demo channels', 25);
    const liveStreams = demo.demoLiveStreams();
    await iptv.replaceLiveStreams(liveStreams);

    report('vod_cats', 'Building demo movie categories', 45);
    await iptv.replaceCategories('vod', demo.demoVodCategories());

    report('vod_streams', 'Building demo movies', 55);
    await iptv.replaceVodStreams(demo.demoVodStreams());

    report('series_cats', 'Building demo series categories', 70);
    await iptv.replaceCategories('series', demo.demoSeriesCategories());

    report('series', 'Building demo series', 78);
    const seriesList = demo.demoSeries();
    await iptv.replaceSeries(seriesList);

    // Seasons and episodes are normally fetched lazily per series. Seed the
    // first few up front so series browsing is populated straight away; the
    // rest fill in on demand through the usual ensureSeriesInfo path.
    report('series', 'Building demo episodes', 86);
    for (const s of seriesList.slice(0, 8)) {
      await iptv.saveSeriesInfo(s.series_id, demo.demoSeriesInfo(s.series_id));
    }

    report('series', 'Building demo programme guide', 92);
    for (let i = 0; i < Math.min(liveStreams.length, 30); i += 1) {
      const ch = liveStreams[i];
      await iptv.replaceEpgForChannel(ch.epg_channel_id, demo.demoEpgForChannel(i + 1));
    }

    report('series', 'Adding demo favourites and progress', 97);
    for (const [type, id] of demo.demoFavourites()) {
      await iptv.addFavourite(type, id);
    }
    for (const [type, id, pos, dur] of demo.demoProgress()) {
      await iptv.saveProgress(type, id, pos, dur);
    }

    await iptv.setSyncMeta('last_full_sync_at', Date.now());
    report('done', 'Demo catalogue ready', 100);
  } catch (err) {
    report('error', err?.message || 'Demo sync failed', 0);
    throw err;
  }
}

/**
 * M3U playlist sync: one download, parsed into live channels (grouped by
 * group-title) and movies (entries with video-file URLs). M3U has no series
 * structure, so the series tables are cleared.
 */
async function runM3uSync(playlist, report) {
  try {
    report('init', 'Preparing local database', 0);
    await iptv.initDb();

    report('live_cats', 'Downloading playlist', 10);
    const text = await fetchM3uText(playlist.url);

    report('live_streams', 'Parsing playlist', 40);
    const entries = parseM3u(text);
    const live = [];
    const vod = [];
    entries.forEach((e, i) => {
      (isVodUrl(e.url) ? vod : live).push({ idx: i, ...e });
    });

    report('vod_cats', 'Organising channels', 60);
    const liveGroups = [...new Set(live.map((e) => e.group))];
    await iptv.replaceCategories('live', liveGroups.map((g) => ({ category_id: g, category_name: g })));
    await iptv.replaceLiveStreams(live.map((e) => ({
      stream_id: `m3u_${e.idx}`,
      name: e.name,
      category_id: e.group,
      stream_icon: e.logo,
      epg_channel_id: e.epgId,
      tv_archive: 0,
      direct_url: e.url,
    })));

    report('vod_streams', 'Organising movies', 80);
    const vodGroups = [...new Set(vod.map((e) => e.group))];
    await iptv.replaceCategories('vod', vodGroups.map((g) => ({ category_id: g, category_name: g })));
    await iptv.replaceVodStreams(vod.map((e) => ({
      stream_id: `m3u_${e.idx}`,
      name: e.name,
      category_id: e.group,
      stream_icon: e.logo,
      container_extension: containerFromUrl(e.url),
      direct_url: e.url,
    })));

    report('series', 'Finishing up', 95);
    await iptv.replaceCategories('series', []);
    await iptv.replaceSeries([]);

    await iptv.setSyncMeta('last_full_sync_at', Date.now());
    report('done', 'Catalogue ready', 100);
  } catch (err) {
    report('error', err?.message || 'Sync failed', 0);
    throw err;
  }
}

/**
 * Lazy: fetch a single VOD's detail blob (poster, plot, rating, cast, year,
 * duration) and cache it on the existing vod_streams row.
 */
export async function ensureVodInfo(streamId) {
  const cached = await iptv.getVod(streamId);
  if (cached?.info_json) return JSON.parse(cached.info_json);
  const info = await xtream.getVodInfo(streamId);
  await iptv.saveVodInfo(streamId, info);
  return info;
}

/**
 * Lazy: fetch + cache the seasons/episodes tree for a series.
 */
export async function ensureSeriesInfo(seriesId) {
  const row = await iptv.getSeries(seriesId);
  if (row?.info_loaded) {
    // Already cached — caller can use getSeasonsForSeries / getEpisodesForSeason.
    return null;
  }
  const info = await xtream.getSeriesInfo(seriesId);
  await iptv.saveSeriesInfo(seriesId, info);
  return info;
}

/**
 * Lazy: pull the short EPG for one channel and store it.
 */
export async function refreshChannelEpg(epgChannelId, streamId) {
  const data = await xtream.getShortEpg(streamId, 8);
  const list = Array.isArray(data?.epg_listings) ? data.epg_listings : [];
  // Xtream encodes title/description in base64 in the short EPG response.
  const decoded = list.map((e) => ({
    start_ts: Number(e.start_timestamp || 0),
    stop_ts:  Number(e.stop_timestamp || 0),
    title:       safeB64(e.title),
    description: safeB64(e.description),
  }));
  await iptv.replaceEpgForChannel(epgChannelId || `stream-${streamId}`, decoded);
  return decoded;
}

function safeB64(s) {
  if (!s) return null;
  try {
    // React Native: global atob exists in modern Hermes
    return typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return s;
  }
}

export default { runFullSync, ensureVodInfo, ensureSeriesInfo, refreshChannelEpg };
