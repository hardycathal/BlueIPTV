// services/demoData.js
//
// Placeholder catalogue used by the "demo" playlist type.
//
// Why this exists: the app is useless without a provider, which makes it
// impossible to screenshot, demo or manually test without pointing it at a
// real subscription. A real subscription's catalogue is also not something
// that belongs in a public repository. This module generates a synthetic
// catalogue with neutral names (Category 1, Channel 1, Movie 1, Series 1)
// that is written through the exact same database writers the real sync uses,
// so every screen renders from real SQLite reads rather than mocked state.
//
// Nothing here touches the network except the two playback URLs below.

// --------------------------------------------------------------------------
// Playback sources.
//
// Public, freely redistributable test assets (Big Buck Bunny, Blender
// Foundation, CC-BY). Live channels use the HLS stream, movies use the MP4.
// If either stops resolving, swap them for any public test stream — nothing
// else in this file depends on them.
// --------------------------------------------------------------------------
export const DEMO_LIVE_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
export const DEMO_VOD_URL =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

// --------------------------------------------------------------------------
// Artwork.
//
// Default is null, which makes the UI fall back to its own built-in placeholder
// tiles. That keeps the demo fully offline and puts no third-party images in
// screenshots. Set USE_REMOTE_POSTERS = true if you would rather have coloured
// tiles carrying the item name.
// --------------------------------------------------------------------------
const USE_REMOTE_POSTERS = false;
const NAVY = '1B2A4A';
const PALE = 'B8CDE8';

function poster(label, w, h) {
  if (!USE_REMOTE_POSTERS) return null;
  return `https://placehold.co/${w}x${h}/${NAVY}/${PALE}/png?text=${encodeURIComponent(label)}`;
}

// Counts. Enough to fill a landscape screen and demonstrate scrolling and
// pagination without making the seed slow.
const LIVE_CATEGORIES = 6;
const CHANNELS_PER_CATEGORY = 10;
const VOD_CATEGORIES = 5;
const MOVIES_PER_CATEGORY = 18;
const SERIES_CATEGORIES = 4;
const SERIES_PER_CATEGORY = 10;
const SEASONS_PER_SERIES = 3;
const EPISODES_PER_SEASON = 10;

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

function categories(count, prefix = 'demo') {
  return range(count).map((n) => ({
    category_id: `${prefix}_cat_${n}`,
    category_name: `Category ${n}`,
  }));
}

// --------------------------------------------------------------------------
// Live TV
// --------------------------------------------------------------------------

export function demoLiveCategories() {
  return categories(LIVE_CATEGORIES, 'live');
}

export function demoLiveStreams() {
  const out = [];
  let n = 0;
  for (const c of range(LIVE_CATEGORIES)) {
    for (const i of range(CHANNELS_PER_CATEGORY)) {
      n += 1;
      // Every third channel exposes a catch-up archive so the Catch-Up screen
      // has something to show. Two channels share a base name at different
      // qualities to exercise the quality-variant grouping in utils/liveVariants.
      const isVariantPair = i === 1 || i === 2;
      const base = isVariantPair ? `Channel ${c * 100 + 1}` : `Channel ${n}`;
      const quality = i === 1 ? ' HD' : i === 2 ? ' FHD' : '';
      out.push({
        stream_id: `demo_live_${n}`,
        name: `${base}${quality}`,
        category_id: `live_cat_${c}`,
        stream_icon: poster(`Channel ${n}`, 200, 200),
        epg_channel_id: `demo_epg_${n}`,
        tv_archive: n % 3 === 0 ? 1 : 0,
        tv_archive_duration: n % 3 === 0 ? 7 : 0,
        num: n,
        direct_url: DEMO_LIVE_URL,
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Movies
// --------------------------------------------------------------------------

export function demoVodCategories() {
  return categories(VOD_CATEGORIES, 'vod');
}

export function demoVodStreams() {
  const out = [];
  let n = 0;
  for (const c of range(VOD_CATEGORIES)) {
    for (const _ of range(MOVIES_PER_CATEGORY)) {
      n += 1;
      out.push({
        stream_id: `demo_vod_${n}`,
        name: `Movie ${n}`,
        category_id: `vod_cat_${c}`,
        stream_icon: poster(`Movie ${n}`, 300, 450),
        rating: Number((5 + ((n * 7) % 50) / 10).toFixed(1)),
        rating_5based: Number((2.5 + ((n * 7) % 25) / 10).toFixed(1)),
        added: String(Math.floor(Date.now() / 1000) - n * 86400),
        container_extension: 'mp4',
        direct_url: DEMO_VOD_URL,
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Series
// --------------------------------------------------------------------------

export function demoSeriesCategories() {
  return categories(SERIES_CATEGORIES, 'series');
}

export function demoSeries() {
  const out = [];
  let n = 0;
  for (const c of range(SERIES_CATEGORIES)) {
    for (const _ of range(SERIES_PER_CATEGORY)) {
      n += 1;
      out.push({
        series_id: `demo_series_${n}`,
        name: `Series ${n}`,
        category_id: `series_cat_${c}`,
        cover: poster(`Series ${n}`, 300, 450),
        plot: `Placeholder synopsis for Series ${n}. This catalogue is generated locally for demonstration and contains no real provider content.`,
        cast: 'Person 1, Person 2, Person 3',
        director: 'Person 4',
        genre: `Genre ${(n % 5) + 1}`,
        release_date: `20${10 + (n % 15)}-01-01`,
        rating: Number((5 + ((n * 5) % 50) / 10).toFixed(1)),
        rating_5based: Number((2.5 + ((n * 5) % 25) / 10).toFixed(1)),
      });
    }
  }
  return out;
}

// Shaped exactly like the Xtream get_series_info payload that
// database/iptv.js saveSeriesInfo expects: seasons array plus an episodes
// object keyed by season number.
export function demoSeriesInfo(seriesId) {
  const seasons = range(SEASONS_PER_SERIES).map((s) => ({
    season_number: s,
    name: `Season ${s}`,
    cover: poster(`Season ${s}`, 300, 450),
    overview: `Placeholder overview for Season ${s}.`,
    air_date: `20${18 + s}-01-01`,
    episode_count: EPISODES_PER_SEASON,
  }));

  const episodes = {};
  for (const s of range(SEASONS_PER_SERIES)) {
    episodes[String(s)] = range(EPISODES_PER_SEASON).map((e) => ({
      id: `${seriesId}_s${s}_e${e}`,
      episode_num: e,
      title: `Episode ${e}`,
      container_extension: 'mp4',
      added: String(Math.floor(Date.now() / 1000) - e * 86400),
      info: {
        plot: `Placeholder description for Season ${s}, Episode ${e}.`,
        duration_secs: 1500 + e * 30,
        movie_image: poster(`S${s}E${e}`, 400, 225),
      },
    }));
  }

  return { seasons, episodes };
}

// --------------------------------------------------------------------------
// EPG
//
// A programme grid running from three hours ago to twelve hours ahead, on a
// 45-minute stride, so "now" always lands mid-programme and now/next is
// populated on every channel.
// --------------------------------------------------------------------------

export function demoEpgForChannel(channelIndex) {
  const now = Math.floor(Date.now() / 1000);
  const stride = 45 * 60;
  const start0 = now - 3 * 3600 - (now % stride);
  const slots = Math.ceil((15 * 3600) / stride);

  return range(slots).map((i) => {
    const start = start0 + (i - 1) * stride;
    return {
      start_ts: start,
      stop_ts: start + stride,
      title: `Programme ${i}`,
      description: `Placeholder programme description for Channel ${channelIndex}, slot ${i}.`,
    };
  });
}

// --------------------------------------------------------------------------
// Favourites and continue-watching, so the Home dashboard rail and the
// virtual "Favourites" categories are populated rather than empty.
// --------------------------------------------------------------------------

export function demoFavourites() {
  return [
    ['live', 'demo_live_1'],
    ['live', 'demo_live_5'],
    ['live', 'demo_live_12'],
    ['vod', 'demo_vod_2'],
    ['vod', 'demo_vod_7'],
    ['series', 'demo_series_1'],
    ['series', 'demo_series_4'],
  ];
}

export function demoProgress() {
  return [
    ['vod', 'demo_vod_1', 1260, 5400],
    ['vod', 'demo_vod_3', 300, 6300],
    ['vod', 'demo_vod_6', 4200, 5100],
    ['episode', 'demo_series_1_s1_e2', 700, 1560],
    ['episode', 'demo_series_2_s1_e1', 180, 1530],
  ];
}

export const DEMO_COUNTS = {
  liveCategories: LIVE_CATEGORIES,
  channels: LIVE_CATEGORIES * CHANNELS_PER_CATEGORY,
  vodCategories: VOD_CATEGORIES,
  movies: VOD_CATEGORIES * MOVIES_PER_CATEGORY,
  seriesCategories: SERIES_CATEGORIES,
  series: SERIES_CATEGORIES * SERIES_PER_CATEGORY,
};

export default {
  demoLiveCategories, demoLiveStreams,
  demoVodCategories, demoVodStreams,
  demoSeriesCategories, demoSeries, demoSeriesInfo,
  demoEpgForChannel, demoFavourites, demoProgress,
  DEMO_LIVE_URL, DEMO_VOD_URL, DEMO_COUNTS,
};
