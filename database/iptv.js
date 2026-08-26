// database/iptv.js
// On-device catalogue cache for the IPTV app. Everything the user can browse
// (live channels / VOD / series / EPG) gets normalised into these tables on
// first sync so the UI can scroll instantly without going back to the
// provider on every screen.
//
// Tables:
//   categories          - flat list per type (live | vod | series)
//   live_streams        - flat list, indexed by category
//   vod_streams         - flat list, indexed by category (lazy-loaded info JSON)
//   series              - one row per series, indexed by category
//   seasons             - one row per (series, season_number)
//   episodes            - one row per episode
//   epg                 - electronic program guide rows, indexed by channel
//   favourites          - user faves across all three types
//   continue_watching   - resume points across vod + episodes
//   sync_meta           - last-sync timestamps per section
//
// Versioned schema: bump SCHEMA_VERSION to force a reset.

import * as SQLite from 'expo-sqlite';
import { groupLiveChannels } from '../utils/liveVariants';

const DB_NAME = 'iptv.db';
const SCHEMA_VERSION = 2; // v2: live_streams.tv_archive_duration (catch-up)

let _db = null;

async function db() {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return _db;
}

async function getMeta(key) {
  const d = await db();
  const row = await d.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [key]).catch(() => null);
  return row ? row.value : null;
}

async function setMeta(key, value) {
  const d = await db();
  await d.runAsync(
    'INSERT INTO sync_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

export async function initDb() {
  const d = await db();

  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const current = await getMeta('schema_version');
  if (current !== String(SCHEMA_VERSION)) {
    // Hard reset on schema bump — keeps migrations simple while we iterate.
    await d.execAsync(`
      DROP TABLE IF EXISTS categories;
      DROP TABLE IF EXISTS live_streams;
      DROP TABLE IF EXISTS vod_streams;
      DROP TABLE IF EXISTS series;
      DROP TABLE IF EXISTS seasons;
      DROP TABLE IF EXISTS episodes;
      DROP TABLE IF EXISTS epg;
      DROP TABLE IF EXISTS favourites;
      DROP TABLE IF EXISTS continue_watching;
    `);
  }

  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS categories (
      type        TEXT NOT NULL,                   -- 'live' | 'vod' | 'series'
      category_id TEXT NOT NULL,
      name        TEXT NOT NULL,
      parent_id   TEXT,
      PRIMARY KEY (type, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type);

    CREATE TABLE IF NOT EXISTS live_streams (
      stream_id      TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      category_id    TEXT,
      logo_url       TEXT,
      epg_channel_id TEXT,
      stream_icon    TEXT,
      tv_archive     INTEGER DEFAULT 0,
      tv_archive_duration INTEGER DEFAULT 0,       -- days of catch-up available
      added          TEXT,
      sort           INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_live_streams_cat ON live_streams(category_id);

    CREATE TABLE IF NOT EXISTS vod_streams (
      stream_id          TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      category_id        TEXT,
      stream_icon        TEXT,
      rating             REAL,
      rating_5based      REAL,
      added              TEXT,
      container_extension TEXT,                    -- 'mp4' | 'mkv' | 'avi' | ...
      info_json          TEXT                      -- result of get_vod_info, cached lazily
    );
    CREATE INDEX IF NOT EXISTS idx_vod_streams_cat ON vod_streams(category_id);
    -- composite index so "category + sorted by name" pages without a full scan
    CREATE INDEX IF NOT EXISTS idx_vod_cat_name ON vod_streams(category_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS series (
      series_id    TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      category_id  TEXT,
      cover        TEXT,
      plot         TEXT,
      cast         TEXT,
      director     TEXT,
      genre        TEXT,
      release_date TEXT,
      rating       REAL,
      rating_5based REAL,
      info_loaded  INTEGER DEFAULT 0               -- 0 until we've fetched seasons+episodes
    );
    CREATE INDEX IF NOT EXISTS idx_series_cat ON series(category_id);
    CREATE INDEX IF NOT EXISTS idx_series_cat_name ON series(category_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS seasons (
      series_id     TEXT NOT NULL,
      season_number INTEGER NOT NULL,
      name          TEXT,
      cover         TEXT,
      overview      TEXT,
      air_date      TEXT,
      episode_count INTEGER,
      PRIMARY KEY (series_id, season_number)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      episode_id          TEXT PRIMARY KEY,
      series_id           TEXT NOT NULL,
      season_number       INTEGER NOT NULL,
      episode_num         INTEGER,
      title               TEXT,
      plot                TEXT,
      duration_secs       INTEGER,
      container_extension TEXT,
      added               TEXT,
      image               TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_series_season ON episodes(series_id, season_number);

    CREATE TABLE IF NOT EXISTS epg (
      channel_id    TEXT NOT NULL,                -- maps to live_streams.epg_channel_id
      start_ts      INTEGER NOT NULL,             -- unix seconds
      stop_ts       INTEGER NOT NULL,
      title         TEXT,
      description   TEXT,
      PRIMARY KEY (channel_id, start_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg(channel_id, start_ts);

    CREATE TABLE IF NOT EXISTS favourites (
      item_type TEXT NOT NULL,                    -- 'live' | 'vod' | 'series' | 'episode'
      item_id   TEXT NOT NULL,
      added_at  INTEGER NOT NULL,
      PRIMARY KEY (item_type, item_id)
    );

    CREATE TABLE IF NOT EXISTS continue_watching (
      item_type        TEXT NOT NULL,             -- 'vod' | 'episode'
      item_id          TEXT NOT NULL,
      position_seconds REAL NOT NULL,
      duration_seconds REAL,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (item_type, item_id)
    );
  `);

  // Categories the user has hidden via long-press (junk categories).
  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS hidden_categories (
      type        TEXT NOT NULL,
      category_id TEXT NOT NULL,
      PRIMARY KEY (type, category_id)
    );
  `);

  // Self-healing column migrations. The version-flag reset above can be
  // defeated (e.g. a DROP failing mid-hot-reload while queries hold locks,
  // after which the flag says "migrated" but the table is old). Checking the
  // actual columns makes initDb repair that state no matter what the flag says.
  await ensureColumn(d, 'live_streams', 'tv_archive_duration', 'tv_archive_duration INTEGER DEFAULT 0');
  // Direct playback URLs for M3U playlists (Xtream builds URLs from creds instead).
  await ensureColumn(d, 'live_streams', 'direct_url', 'direct_url TEXT');
  await ensureColumn(d, 'vod_streams', 'direct_url', 'direct_url TEXT');

  await setMeta('schema_version', SCHEMA_VERSION);
}

async function ensureColumn(d, table, column, ddl) {
  const cols = await d.getAllAsync(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await d.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// ============================================================
// Bulk upsert helpers used by the catalogue sync.
// Each one wraps a single transaction so a 10k-row write stays fast.
// ============================================================

/**
 * Insert many rows with as few native calls as possible.
 *
 * Inserting row-by-row means one JS->native round-trip per row, which on a
 * 20k-channel provider blocks the JS thread for the better part of a minute
 * (VirtualizedList then warns that the UI is unresponsive). Batching rows
 * into multi-VALUES statements cuts that to a few dozen calls, and we yield
 * to the event loop between batches so the UI keeps breathing.
 *
 *   columns       - column names, in order
 *   rows          - array of value arrays matching `columns`
 *   literalSuffix - optional trailing literal columns, e.g. 'NULL, 0'
 */
async function insertChunked(d, table, columns, rows, literalSuffix = '') {
  if (!rows.length) return;
  const perRow = columns.length;
  // Stay well under SQLite's bound-parameter limit.
  const chunkSize = Math.max(1, Math.floor(900 / perRow));
  const cols = literalSuffix
    ? `${columns.join(', ')}, ${literalSuffix.columns}`
    : columns.join(', ');
  const tuple = `(${columns.map(() => '?').join(', ')}${literalSuffix ? `, ${literalSuffix.values}` : ''})`;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const sql = `INSERT INTO ${table}(${cols}) VALUES ${chunk.map(() => tuple).join(', ')}`;
    await d.runAsync(sql, chunk.flat());
    // let pending UI work run between batches
    if (i % (chunkSize * 10) === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

export async function replaceCategories(type, categories) {
  const d = await db();
  await d.execAsync('BEGIN');
  try {
    await d.runAsync('DELETE FROM categories WHERE type = ?', [type]);
    await insertChunked(
      d,
      'categories',
      ['type', 'category_id', 'name', 'parent_id'],
      categories.map((c) => [
        type,
        String(c.category_id),
        String(c.category_name || ''),
        c.parent_id != null ? String(c.parent_id) : null,
      ])
    );
    await d.execAsync('COMMIT');
  } catch (e) {
    await d.execAsync('ROLLBACK');
    throw e;
  }
  await setMeta(`categories_${type}_synced_at`, Date.now());
}

export async function replaceLiveStreams(streams) {
  const d = await db();
  await d.execAsync('BEGIN');
  try {
    await d.runAsync('DELETE FROM live_streams');
    await insertChunked(
      d,
      'live_streams',
      ['stream_id', 'name', 'category_id', 'logo_url', 'epg_channel_id', 'stream_icon',
        'tv_archive', 'tv_archive_duration', 'added', 'sort', 'direct_url'],
      streams.map((s) => [
        String(s.stream_id),
        String(s.name || ''),
        s.category_id != null ? String(s.category_id) : null,
        s.stream_icon || null,
        s.epg_channel_id || null,
        s.stream_icon || null,
        Number(s.tv_archive || 0),
        Number(s.tv_archive_duration || 0),
        s.added || null,
        Number(s.num || 0),
        s.direct_url || null,
      ])
    );
    await d.execAsync('COMMIT');
  } catch (e) {
    await d.execAsync('ROLLBACK');
    throw e;
  }
  await setMeta('live_streams_synced_at', Date.now());
}

export async function replaceVodStreams(streams) {
  const d = await db();
  await d.execAsync('BEGIN');
  try {
    await d.runAsync('DELETE FROM vod_streams');
    await insertChunked(
      d,
      'vod_streams',
      ['stream_id', 'name', 'category_id', 'stream_icon', 'rating', 'rating_5based',
        'added', 'container_extension', 'direct_url'],
      streams.map((s) => [
        String(s.stream_id),
        String(s.name || ''),
        s.category_id != null ? String(s.category_id) : null,
        s.stream_icon || null,
        Number(s.rating || 0),
        Number(s.rating_5based || 0),
        s.added || null,
        s.container_extension || 'mp4',
        s.direct_url || null,
      ]),
      { columns: 'info_json', values: 'NULL' }
    );
    await d.execAsync('COMMIT');
  } catch (e) {
    await d.execAsync('ROLLBACK');
    throw e;
  }
  await setMeta('vod_streams_synced_at', Date.now());
}

export async function replaceSeries(seriesList) {
  const d = await db();
  await d.execAsync('BEGIN');
  try {
    await d.runAsync('DELETE FROM series');
    await insertChunked(
      d,
      'series',
      ['series_id', 'name', 'category_id', 'cover', 'plot', 'cast', 'director',
        'genre', 'release_date', 'rating', 'rating_5based'],
      seriesList.map((s) => [
        String(s.series_id),
        String(s.name || ''),
        s.category_id != null ? String(s.category_id) : null,
        s.cover || null,
        s.plot || null,
        s.cast || null,
        s.director || null,
        s.genre || null,
        s.releaseDate || s.release_date || null,
        Number(s.rating || 0),
        Number(s.rating_5based || 0),
      ]),
      { columns: 'info_loaded', values: '0' }
    );
    await d.execAsync('COMMIT');
  } catch (e) {
    await d.execAsync('ROLLBACK');
    throw e;
  }
  await setMeta('series_synced_at', Date.now());
}

// Stores the seasons+episodes for ONE series after a get_series_info call.
export async function saveSeriesInfo(seriesId, info) {
  const d = await db();
  await d.execAsync('BEGIN');
  try {
    await d.runAsync('DELETE FROM seasons   WHERE series_id = ?', [seriesId]);
    await d.runAsync('DELETE FROM episodes  WHERE series_id = ?', [seriesId]);

    const seasons = Array.isArray(info?.seasons) ? info.seasons : [];
    await insertChunked(
      d,
      'seasons',
      ['series_id', 'season_number', 'name', 'cover', 'overview', 'air_date', 'episode_count'],
      seasons.map((s) => [
        seriesId,
        Number(s.season_number),
        s.name || null,
        s.cover || null,
        s.overview || null,
        s.air_date || null,
        Number(s.episode_count || 0),
      ])
    );

    // Xtream returns episodes nested by season number key, e.g. { "1": [...], "2": [...] }
    const episodesBySeason = info?.episodes || {};
    const episodeRows = [];
    for (const [seasonKey, list] of Object.entries(episodesBySeason)) {
      const seasonNum = Number(seasonKey);
      for (const ep of (Array.isArray(list) ? list : [])) {
        const dur = ep.info?.duration_secs ?? ep.info?.duration ?? null;
        episodeRows.push([
          String(ep.id),
          seriesId,
          seasonNum,
          Number(ep.episode_num || 0),
          ep.title || null,
          ep.info?.plot || null,
          dur != null ? Number(dur) : null,
          ep.container_extension || 'mp4',
          ep.added || null,
          ep.info?.movie_image || ep.info?.cover_big || null,
        ]);
      }
    }
    await insertChunked(
      d,
      'episodes',
      ['episode_id', 'series_id', 'season_number', 'episode_num', 'title', 'plot',
        'duration_secs', 'container_extension', 'added', 'image'],
      episodeRows
    );

    await d.runAsync('UPDATE series SET info_loaded = 1 WHERE series_id = ?', [seriesId]);
    await d.execAsync('COMMIT');
  } catch (e) {
    await d.execAsync('ROLLBACK');
    throw e;
  }
}

// Cache the heavy "get_vod_info" payload (JSON blob) per VOD stream.
export async function saveVodInfo(streamId, infoJson) {
  const d = await db();
  await d.runAsync(
    'UPDATE vod_streams SET info_json = ? WHERE stream_id = ?',
    [JSON.stringify(infoJson || {}), streamId]
  );
}

// ============================================================
// Read helpers used by the UI.
// ============================================================

export async function hideCategory(type, categoryId) {
  const d = await db();
  await d.runAsync(
    'INSERT OR IGNORE INTO hidden_categories(type, category_id) VALUES(?, ?)',
    [type, String(categoryId)]
  );
}

export async function unhideAllCategories() {
  const d = await db();
  await d.runAsync('DELETE FROM hidden_categories');
}

export async function countHiddenCategories() {
  const d = await db();
  const row = await d.getFirstAsync('SELECT COUNT(*) AS n FROM hidden_categories');
  return row?.n ?? 0;
}

export async function listCategories(type) {
  const d = await db();
  return d.getAllAsync(
    `SELECT category_id, name FROM categories
      WHERE type = ?
        AND category_id NOT IN (SELECT category_id FROM hidden_categories WHERE type = ?)
   ORDER BY name COLLATE NOCASE`,
    [type, type]
  );
}

// Whitelisted ORDER BY clauses for the browse-grid sort button.
const VOD_ORDERS = {
  name:   'name COLLATE NOCASE',
  added:  'CAST(added AS INTEGER) DESC, name COLLATE NOCASE',
  rating: 'rating IS NULL, rating DESC, name COLLATE NOCASE',
};
const SERIES_ORDERS = {
  name:   'name COLLATE NOCASE',
  added:  'release_date DESC, name COLLATE NOCASE',
  rating: 'rating IS NULL, rating DESC, name COLLATE NOCASE',
};

export async function listLiveByCategory(categoryId, limit = 500, offset = 0) {
  const d = await db();
  const rows = await d.getAllAsync(
    `SELECT stream_id, name, stream_icon, epg_channel_id
       FROM live_streams
      WHERE category_id = ?
   ORDER BY name COLLATE NOCASE
      LIMIT ? OFFSET ?`,
    [String(categoryId), limit, offset]
  );
  return rows;
}

export async function listMergedLiveByCategory(categoryId, limit = 500, offset = 0) {
  const d = await db();
  const rows = await d.getAllAsync(
    `SELECT stream_id, name, category_id, stream_icon, epg_channel_id, direct_url
       FROM live_streams
      WHERE category_id = ?
   ORDER BY name COLLATE NOCASE`,
    [String(categoryId)]
  );
  return groupLiveChannels(rows).slice(offset, offset + limit);
}

export async function listLiveChannels(limit = 200, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT stream_id, name, category_id, stream_icon, epg_channel_id, direct_url
       FROM live_streams
   ORDER BY sort ASC, name COLLATE NOCASE
      LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

export async function listMergedLiveChannels(limit = 200, offset = 0) {
  const d = await db();
  const rows = await d.getAllAsync(
    `SELECT stream_id, name, category_id, stream_icon, epg_channel_id, direct_url
       FROM live_streams
   ORDER BY sort ASC, name COLLATE NOCASE`
  );
  return groupLiveChannels(rows).slice(offset, offset + limit);
}

export async function listVodByCategory(categoryId, limit = 500, offset = 0, orderBy = 'name') {
  const d = await db();
  return d.getAllAsync(
    `SELECT stream_id, name, stream_icon, rating, container_extension, direct_url
       FROM vod_streams
      WHERE category_id = ?
   ORDER BY ${VOD_ORDERS[orderBy] || VOD_ORDERS.name}
      LIMIT ? OFFSET ?`,
    [String(categoryId), limit, offset]
  );
}

export async function listSeriesByCategory(categoryId, limit = 500, offset = 0, orderBy = 'name') {
  const d = await db();
  return d.getAllAsync(
    `SELECT series_id, name, cover, rating
       FROM series
      WHERE category_id = ?
   ORDER BY ${SERIES_ORDERS[orderBy] || SERIES_ORDERS.name}
      LIMIT ? OFFSET ?`,
    [String(categoryId), limit, offset]
  );
}

export async function getVod(streamId) {
  const d = await db();
  return d.getFirstAsync('SELECT * FROM vod_streams WHERE stream_id = ?', [String(streamId)]);
}

export async function getSeries(seriesId) {
  const d = await db();
  return d.getFirstAsync('SELECT * FROM series WHERE series_id = ?', [String(seriesId)]);
}

export async function getSeasonsForSeries(seriesId) {
  const d = await db();
  // Only seasons that actually contain episodes — some providers list an
  // empty "S0" (specials) season that would otherwise show as a dead pill.
  return d.getAllAsync(
    `SELECT s.* FROM seasons s
      WHERE s.series_id = ?
        AND EXISTS (SELECT 1 FROM episodes e
                     WHERE e.series_id = s.series_id
                       AND e.season_number = s.season_number)
   ORDER BY s.season_number`,
    [String(seriesId)]
  );
}

export async function getEpisodesForSeason(seriesId, seasonNumber) {
  const d = await db();
  return d.getAllAsync(
    'SELECT * FROM episodes WHERE series_id = ? AND season_number = ? ORDER BY episode_num',
    [String(seriesId), Number(seasonNumber)]
  );
}

export async function searchAcross(query, type, limit = 100) {
  const d = await db();
  const q = `%${query}%`;
  if (type === 'live')
    return d.getAllAsync(
      `SELECT stream_id AS id, name, stream_icon AS image, 'live' AS type
         FROM live_streams
        WHERE name LIKE ? COLLATE NOCASE
     ORDER BY name COLLATE NOCASE
        LIMIT ?`,
      [q, limit]
    );
  if (type === 'vod')
    return d.getAllAsync(
      `SELECT stream_id AS id, name, stream_icon AS image, container_extension, 'vod' AS type
         FROM vod_streams
        WHERE name LIKE ? COLLATE NOCASE
     ORDER BY name COLLATE NOCASE
        LIMIT ?`,
      [q, limit]
    );
  if (type === 'series')
    return d.getAllAsync(
      `SELECT series_id AS id, name, cover AS image, 'series' AS type
         FROM series
        WHERE name LIKE ? COLLATE NOCASE
     ORDER BY name COLLATE NOCASE
        LIMIT ?`,
      [q, limit]
    );
  return [];
}

// Favourites
export async function isFavourite(itemType, itemId) {
  const d = await db();
  const row = await d.getFirstAsync(
    'SELECT 1 AS f FROM favourites WHERE item_type = ? AND item_id = ?',
    [itemType, String(itemId)]
  );
  return !!row;
}
export async function addFavourite(itemType, itemId) {
  const d = await db();
  await d.runAsync(
    'INSERT OR IGNORE INTO favourites(item_type, item_id, added_at) VALUES(?, ?, ?)',
    [itemType, String(itemId), Date.now()]
  );
}
export async function removeFavourite(itemType, itemId) {
  const d = await db();
  await d.runAsync(
    'DELETE FROM favourites WHERE item_type = ? AND item_id = ?',
    [itemType, String(itemId)]
  );
}
export async function listFavourites(itemType) {
  const d = await db();
  return d.getAllAsync(
    'SELECT item_id FROM favourites WHERE item_type = ? ORDER BY added_at DESC',
    [itemType]
  );
}

// Continue watching
export async function saveProgress(itemType, itemId, positionSeconds, durationSeconds) {
  const d = await db();
  await d.runAsync(
    `INSERT INTO continue_watching(item_type, item_id, position_seconds, duration_seconds, updated_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(item_type, item_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = excluded.duration_seconds,
       updated_at       = excluded.updated_at`,
    [itemType, String(itemId), Number(positionSeconds || 0), Number(durationSeconds || 0), Date.now()]
  );
}
export async function getProgress(itemType, itemId) {
  const d = await db();
  return d.getFirstAsync(
    'SELECT position_seconds, duration_seconds FROM continue_watching WHERE item_type = ? AND item_id = ?',
    [itemType, String(itemId)]
  );
}
export async function listContinueWatching(limit = 50) {
  const d = await db();
  return d.getAllAsync(
    'SELECT * FROM continue_watching ORDER BY updated_at DESC LIMIT ?',
    [limit]
  );
}

// EPG
export async function replaceEpgForChannel(channelId, entries) {
  const d = await db();
  await d.execAsync('BEGIN');
  try {
    await d.runAsync('DELETE FROM epg WHERE channel_id = ?', [String(channelId)]);
    const stmt = await d.prepareAsync(
      'INSERT INTO epg(channel_id, start_ts, stop_ts, title, description) VALUES(?, ?, ?, ?, ?)'
    );
    try {
      for (const e of entries) {
        await stmt.executeAsync([
          String(channelId),
          Number(e.start_ts),
          Number(e.stop_ts),
          e.title || null,
          e.description || null,
        ]);
      }
    } finally {
      await stmt.finalizeAsync();
    }
    await d.execAsync('COMMIT');
  } catch (e) {
    await d.execAsync('ROLLBACK');
    throw e;
  }
}

export async function getEpgForChannels(channelIds, startTs, stopTs) {
  const ids = channelIds.map(String).filter(Boolean);
  if (!ids.length) return [];
  const d = await db();
  const placeholders = ids.map(() => '?').join(',');
  return d.getAllAsync(
    `SELECT *
       FROM epg
      WHERE channel_id IN (${placeholders})
        AND stop_ts > ?
        AND start_ts < ?
   ORDER BY channel_id, start_ts`,
    [...ids, Number(startTs), Number(stopTs)]
  );
}

export async function getNowAndNext(channelId) {
  const d = await db();
  const now = Math.floor(Date.now() / 1000);
  const rows = await d.getAllAsync(
    `SELECT * FROM epg WHERE channel_id = ? AND stop_ts > ? ORDER BY start_ts LIMIT 2`,
    [String(channelId), now]
  );
  return rows;
}

// Favourited live channels (grouped by quality variants like the category lists).
export async function listFavouriteLive() {
  const d = await db();
  const rows = await d.getAllAsync(
    `SELECT l.stream_id, l.name, l.category_id, l.stream_icon, l.epg_channel_id, l.direct_url
       FROM favourites f
       JOIN live_streams l ON l.stream_id = f.item_id
      WHERE f.item_type = 'live'
   ORDER BY f.added_at DESC`
  );
  return groupLiveChannels(rows);
}

// ---- per-section name search (scoped search bars) ----

export async function searchVodByName(query, limit = 500, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT * FROM vod_streams WHERE name LIKE '%' || ? || '%'
   ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [query, limit, offset]
  );
}

export async function searchSeriesByName(query, limit = 500, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT * FROM series WHERE name LIKE '%' || ? || '%'
   ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [query, limit, offset]
  );
}

export async function searchLiveByName(query, limit = 2000) {
  const d = await db();
  const rows = await d.getAllAsync(
    `SELECT stream_id, name, category_id, stream_icon, epg_channel_id, direct_url
       FROM live_streams WHERE name LIKE '%' || ? || '%'
   ORDER BY name COLLATE NOCASE`,
    [query]
  );
  return groupLiveChannels(rows).slice(0, limit);
}

// ---- favourites / recently watched, joined with display rows ----
// Used by the virtual "Favourites" and "Recently watched" categories at the
// top of the Movies and Series screens.

export async function listFavouriteVod(limit = 500, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT v.* FROM favourites f
       JOIN vod_streams v ON v.stream_id = f.item_id
      WHERE f.item_type = 'vod'
   ORDER BY f.added_at DESC
      LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

export async function listFavouriteSeries(limit = 500, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT s.* FROM favourites f
       JOIN series s ON s.series_id = f.item_id
      WHERE f.item_type = 'series'
   ORDER BY f.added_at DESC
      LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

export async function listRecentVod(limit = 500, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT v.* FROM continue_watching cw
       JOIN vod_streams v ON v.stream_id = cw.item_id
      WHERE cw.item_type = 'vod'
   ORDER BY cw.updated_at DESC
      LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

// Series with at least one recently-watched episode, most recent first.
export async function listRecentSeries(limit = 500, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT s.*, MAX(cw.updated_at) AS last_watched FROM continue_watching cw
       JOIN episodes e ON e.episode_id = cw.item_id
       JOIN series s   ON s.series_id = e.series_id
      WHERE cw.item_type = 'episode'
   GROUP BY s.series_id
   ORDER BY last_watched DESC
      LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

// Channels that offer catch-up (TV archive), for the Catch-Up screen.
export async function listArchiveChannels(limit = 2000, offset = 0) {
  const d = await db();
  return d.getAllAsync(
    `SELECT stream_id, name, category_id, stream_icon, epg_channel_id, direct_url, tv_archive_duration
       FROM live_streams
      WHERE tv_archive = 1
   ORDER BY sort ASC, name COLLATE NOCASE
      LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

// Continue-watching entries joined with display metadata (name, image, and
// everything the Player needs to resume). Used by the Home screen rail.
export async function listContinueWatchingDetailed(limit = 12) {
  const d = await db();
  return d.getAllAsync(
    `SELECT cw.item_type, cw.item_id, cw.position_seconds, cw.duration_seconds, cw.updated_at,
            CASE cw.item_type WHEN 'vod' THEN v.name
                              ELSE COALESCE(s.name, e.title) END AS name,
            CASE cw.item_type WHEN 'vod' THEN v.stream_icon
                              ELSE COALESCE(e.image, s.cover) END AS image,
            CASE cw.item_type WHEN 'vod' THEN v.container_extension
                              ELSE e.container_extension END AS container_extension,
            CASE cw.item_type WHEN 'vod' THEN v.direct_url ELSE NULL END AS direct_url,
            e.season_number, e.episode_num, e.series_id
       FROM continue_watching cw
  LEFT JOIN vod_streams v ON cw.item_type = 'vod' AND v.stream_id = cw.item_id
  LEFT JOIN episodes e    ON cw.item_type = 'episode' AND e.episode_id = cw.item_id
  LEFT JOIN series s      ON s.series_id = e.series_id
      WHERE name IS NOT NULL
        AND cw.duration_seconds > 0
        AND cw.position_seconds < cw.duration_seconds * 0.97
   ORDER BY cw.updated_at DESC
      LIMIT ?`,
    [limit]
  );
}

// Item counts per type, for the Home dashboard.
export async function getCatalogueCounts() {
  const d = await db();
  const [live, vod, series] = await Promise.all([
    d.getFirstAsync(`SELECT COUNT(*) AS n FROM live_streams`),
    d.getFirstAsync(`SELECT COUNT(*) AS n FROM vod_streams`),
    d.getFirstAsync(`SELECT COUNT(*) AS n FROM series`),
  ]);
  return { live: live?.n ?? 0, vod: vod?.n ?? 0, series: series?.n ?? 0 };
}

export async function getSyncMeta(key) {
  return getMeta(key);
}
export async function setSyncMeta(key, value) {
  return setMeta(key, value);
}

// Wipe everything (used on logout and when switching playlists).
// Tables may not exist yet on a fresh install, so this runs initDb first and
// deletes table-by-table — a missing table must never fail the whole wipe.
export async function resetDb() {
  await initDb().catch(() => {});
  const d = await db();
  const tables = [
    'categories', 'live_streams', 'vod_streams', 'series', 'seasons',
    'episodes', 'epg', 'favourites', 'continue_watching',
    'hidden_categories', 'sync_meta',
  ];
  for (const t of tables) {
    try {
      await d.execAsync(`DELETE FROM ${t}`);
    } catch (e) {
      // table doesn't exist on this install — nothing to wipe
    }
  }
}
