// SeriesScreen
// Single-screen series browser (landscape): categories left, self-sizing
// 3-row poster grid right, marquee titles. The detail overlay shows season
// pills (empty seasons are filtered out in the DB layer) and a scrollable
// episode list with full descriptions.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet,
  ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  listCategories, listSeriesByCategory, getSeasonsForSeries, getEpisodesForSeason,
  listFavouriteSeries, listRecentSeries, isFavourite, addFavourite, removeFavourite,
  searchSeriesByName, hideCategory,
} from '../database/iptv';
import { ensureSeriesInfo } from '../services/catalogueSync';
import MarqueeText from '../components/MarqueeText';
import SearchBar from '../components/SearchBar';
import { C, R, G } from '../theme';

// Small first page so opening a category is instant; rest streams in on scroll.
const FIRST_PAGE = 60;
const PAGE = 200;
const GAP = 8;
const NAME_H = 15;
const ROWS = 3;

const FAV_CAT = '__favourites__';
const RECENT_CAT = '__recent__';
const VIRTUAL_CATS = [
  { category_id: FAV_CAT, name: '★ Favourites' },
  { category_id: RECENT_CAT, name: 'Recently watched' },
];

const SORTS = [
  { key: 'name',   label: 'A–Z' },
  { key: 'added',  label: 'New' },
  { key: 'rating', label: '★' },
];

function fetchSeriesPage(categoryId, limit, offset, query, sort) {
  if (query) return searchSeriesByName(query, limit, offset);
  if (categoryId === FAV_CAT) return listFavouriteSeries(limit, offset);
  if (categoryId === RECENT_CAT) return listRecentSeries(limit, offset);
  return listSeriesByCategory(categoryId, limit, offset, sort);
}

// Memoized poster card — see MoviesScreen for rationale.
const PosterCard = React.memo(function PosterCard({ item, grid, onPress }) {
  return (
    <TouchableOpacity
      style={[s.card, { width: grid.cardW, height: grid.cardH }]}
      onPress={() => onPress(item)}
      activeOpacity={0.8}
    >
      {item.cover
        ? <Image source={{ uri: item.cover }} style={[s.cardPoster, { height: grid.posterH }]} />
        : <View style={[s.cardPoster, s.cardPosterEmpty, { height: grid.posterH }]}>
            <FontAwesome name="list-alt" size={16} color={C.textMuted} />
          </View>}
      <MarqueeText text={item.name} style={s.cardName} />
      {item.rating ? (
        <View style={s.ratingChip}>
          <Text style={s.ratingChipText}>★ {Number(item.rating).toFixed(1)}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
});

function computeGrid(w, h) {
  const cardH = Math.floor((h - 12 - GAP * (ROWS - 1)) / ROWS);
  const posterH = cardH - NAME_H - 3;
  const cardW = Math.max(56, Math.floor(posterH * (2 / 3)));
  const cols = Math.max(3, Math.floor((w - 16 + GAP) / (cardW + GAP)));
  return { cardH, cardW, posterH, cols };
}

export default function SeriesScreen({ navigation }) {
  const [cats, setCats] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [eof, setEof] = useState(false);
  const [detail, setDetail] = useState(null); // { series, seasons, season, episodes, loading }
  const [grid, setGrid] = useState(null);
  const [query, setQuery] = useState('');
  const [clearSignal, setClearSignal] = useState(0);
  const [sortIdx, setSortIdx] = useState(0);

  // Picking a category cancels any active search.
  function pickCategory(categoryId) {
    if (query) {
      setQuery('');
      setClearSignal((n) => n + 1);
    }
    setSelectedCat(categoryId);
  }

  useEffect(() => {
    listCategories('series')
      .then((rows) => {
        setCats([...VIRTUAL_CATS, ...rows]);
        setSelectedCat(rows.length ? rows[0].category_id : FAV_CAT);
      })
      .catch(() => setCats([...VIRTUAL_CATS]));
  }, []);

  useEffect(() => {
    if (selectedCat == null && !query) return;
    let cancelled = false;
    setLoading(true);
    setItems([]);
    setEof(false);
    fetchSeriesPage(selectedCat, FIRST_PAGE, 0, query, SORTS[sortIdx].key)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setEof(rows.length < FIRST_PAGE);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedCat, query, sortIdx]);

  async function loadMore() {
    if (loading || eof) return;
    const next = await fetchSeriesPage(selectedCat, PAGE, items.length, query, SORTS[sortIdx].key);
    if (!next.length) { setEof(true); return; }
    setItems((cur) => cur.concat(next));
    if (next.length < PAGE) setEof(true);
  }

  // stable identity so memoized cards don't re-render on every parent update
  const openDetailStable = useCallback((series) => { openDetail(series); }, []);

  async function openDetail(series) {
    setDetail({ series, seasons: [], season: null, episodes: [], loading: true, fav: false });
    isFavourite('series', series.series_id)
      .then((f) => setDetail((d) => (d?.series.series_id === series.series_id ? { ...d, fav: f } : d)))
      .catch(() => {});
    try {
      await ensureSeriesInfo(series.series_id);
      const seasons = await getSeasonsForSeries(series.series_id);
      let season = null;
      let episodes = [];
      if (seasons.length) {
        season = seasons[0].season_number;
        episodes = await getEpisodesForSeason(series.series_id, season);
      }
      setDetail((d) => (d?.series.series_id === series.series_id
        ? { series, seasons, season, episodes, loading: false }
        : d));
    } catch {
      setDetail((d) => (d?.series.series_id === series.series_id
        ? { series, seasons: [], season: null, episodes: [], loading: false }
        : d));
    }
  }

  async function pickSeason(n) {
    if (!detail) return;
    const episodes = await getEpisodesForSeason(detail.series.series_id, n);
    setDetail((d) => (d ? { ...d, season: n, episodes } : d));
  }

  async function toggleFavourite() {
    if (!detail) return;
    const { series, fav } = detail;
    if (fav) await removeFavourite('series', series.series_id);
    else await addFavourite('series', series.series_id);
    setDetail((d) => (d?.series.series_id === series.series_id ? { ...d, fav: !fav } : d));
    if (selectedCat === FAV_CAT) {
      fetchSeriesPage(FAV_CAT, PAGE, 0).then(setItems).catch(() => {});
    }
  }

  function playEpisode(ep) {
    const { series } = detail;
    setDetail(null);
    navigation.navigate('Player', {
      kind: 'episode',
      episodeId: ep.episode_id,
      container: ep.container_extension || 'mp4',
      title: `${series.name} S${ep.season_number} E${ep.episode_num}`,
      // context for next-episode autoplay
      seriesId: series.series_id,
      seriesName: series.name,
      season: ep.season_number,
      episodeNum: ep.episode_num,
    });
  }

  const insets = useSafeAreaInsets();

  if (!cats) return <View style={s.center}><ActivityIndicator color={C.accentSoft} /></View>;

  return (
    <View style={[s.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      {/* Slim header */}
      <View style={s.topBar}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()}>
          <FontAwesome name="chevron-left" size={14} color={C.text} />
        </TouchableOpacity>
        <Text style={s.topTitle}>Series{query ? `  ·  results for "${query}"` : ''}</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={s.sortBtn} onPress={() => setSortIdx((i) => (i + 1) % SORTS.length)}>
          <FontAwesome name="sort" size={11} color={C.textSoft} />
          <Text style={s.sortText}>  {SORTS[sortIdx].label}</Text>
        </TouchableOpacity>
        <SearchBar placeholder="Search series…" onQuery={setQuery} clearSignal={clearSignal} />
      </View>

      <View style={s.container}>
        {/* Categories */}
        <View style={s.catPane}>
          <FlatList
            data={cats}
            keyExtractor={(c) => c.category_id}
            renderItem={({ item }) => {
              const active = item.category_id === selectedCat;
              return (
                <TouchableOpacity
                  style={s.catRow}
                  onPress={() => pickCategory(item.category_id)}
                  onLongPress={() => {
                    if (item.category_id === FAV_CAT || item.category_id === RECENT_CAT) return;
                    Alert.alert('Hide category', `Hide "${item.name}"? Restore from the Profile tab.`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Hide', style: 'destructive',
                        onPress: async () => {
                          await hideCategory('series', item.category_id);
                          setCats((cur) => cur.filter((c) => c.category_id !== item.category_id));
                          if (selectedCat === item.category_id) setSelectedCat(FAV_CAT);
                        },
                      },
                    ]);
                  }}
                >
                  {active ? (
                    <LinearGradient colors={G.series} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
                  ) : null}
                  <Text style={[s.catText, active && s.catTextActive]} numberOfLines={2}>{item.name}</Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>

        {/* Poster grid */}
        <View style={{ flex: 1 }} onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width && height) setGrid(computeGrid(width, height));
        }}>
          {loading || !grid ? (
            <ActivityIndicator color={C.accentSoft} style={{ marginTop: 30 }} />
          ) : (
            <FlatList
              data={items}
              key={`grid-${grid.cols}`}
              numColumns={grid.cols}
              keyExtractor={(v) => v.series_id}
              contentContainerStyle={{ padding: 8 }}
              columnWrapperStyle={{ gap: GAP }}
              onEndReachedThreshold={1.2}
              onEndReached={loadMore}
              initialNumToRender={grid.cols * 3}
              maxToRenderPerBatch={grid.cols * 2}
              windowSize={5}
              removeClippedSubviews
              getItemLayout={(_, index) => ({
                length: grid.cardH + 12,
                offset: (grid.cardH + 12) * Math.floor(index / grid.cols),
                index,
              })}
              renderItem={({ item }) => (
                <PosterCard item={item} grid={grid} onPress={openDetailStable} />
              )}
              ListEmptyComponent={<Text style={s.empty}>Nothing in this category.</Text>}
            />
          )}
        </View>
      </View>

      {/* Detail overlay */}
      {detail ? (
        <View style={s.overlay}>
          <TouchableOpacity style={s.overlayBackdrop} activeOpacity={1} onPress={() => setDetail(null)} />
          <LinearGradient colors={G.sheet} style={s.sheet}>
            <View style={s.sheetPosterCol}>
              {detail.series.cover
                ? <Image source={{ uri: detail.series.cover }} style={s.sheetPoster} />
                : <View style={[s.sheetPoster, s.cardPosterEmpty]}><FontAwesome name="list-alt" size={34} color={C.textMuted} /></View>}
              <Text style={s.sheetMetaSmall}>
                {detail.series.rating ? `★ ${Number(detail.series.rating).toFixed(1)}   ` : ''}
                {detail.series.release_date || ''}
              </Text>
            </View>

            <View style={s.sheetInfoCol}>
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle} numberOfLines={2}>{detail.series.name}</Text>
                <TouchableOpacity style={s.closeBtn} onPress={toggleFavourite}>
                  <FontAwesome name={detail.fav ? 'heart' : 'heart-o'} size={18} color={detail.fav ? C.danger : C.textSoft} />
                </TouchableOpacity>
                <TouchableOpacity style={s.closeBtn} onPress={() => setDetail(null)}>
                  <FontAwesome name="times" size={16} color={C.textSoft} />
                </TouchableOpacity>
              </View>

              {detail.loading ? (
                <ActivityIndicator color={C.accentSoft} style={{ marginTop: 20 }} />
              ) : (
                <>
                  {detail.seasons.length ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.seasonStrip}>
                      {detail.seasons.map((sn) => (
                        <TouchableOpacity
                          key={sn.season_number}
                          style={[s.seasonPill, detail.season === sn.season_number && s.seasonPillActive]}
                          onPress={() => pickSeason(sn.season_number)}
                        >
                          <Text style={s.seasonText}>S{sn.season_number}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  ) : null}

                  <ScrollView style={{ flex: 1, marginTop: 8 }}>
                    {detail.series.plot ? (
                      <Text style={s.sheetPlot} numberOfLines={3}>{detail.series.plot}</Text>
                    ) : null}
                    {detail.episodes.map((ep) => (
                      <TouchableOpacity key={ep.episode_id} style={s.epRow} onPress={() => playEpisode(ep)}>
                        <Text style={s.epNum}>{ep.episode_num}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={s.epTitle}>{ep.title || `Episode ${ep.episode_num}`}</Text>
                          {ep.plot ? <Text style={s.epPlot}>{ep.plot}</Text> : null}
                        </View>
                        <FontAwesome name="play-circle-o" size={20} color={C.accentSoft} />
                      </TouchableOpacity>
                    ))}
                    {!detail.episodes.length ? (
                      <Text style={s.empty}>No episodes found.</Text>
                    ) : null}
                  </ScrollView>
                </>
              )}
            </View>
          </LinearGradient>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  topBar: {
    flexDirection: 'row', alignItems: 'center',
    height: 34, paddingHorizontal: 8,
    backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border,
  },
  backBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  topTitle: { color: C.text, fontSize: 14, fontWeight: '700', marginLeft: 2 },
  sortBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: R.sm, paddingHorizontal: 10, height: 26, marginRight: 8,
  },
  sortText: { color: C.textSoft, fontSize: 11, fontWeight: '700' },

  container: { flex: 1, flexDirection: 'row' },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  empty: { color: C.textMuted, fontSize: 12, padding: 10 },

  catPane: { width: 150, borderRightWidth: 1, borderRightColor: C.border, backgroundColor: C.surface },
  catRow: { paddingVertical: 11, paddingHorizontal: 12, overflow: 'hidden' },
  catText: { color: C.textSoft, fontSize: 13 },
  catTextActive: { color: C.text, fontWeight: '700' },

  card: { borderRadius: R.sm, overflow: 'hidden' },
  cardPoster: { width: '100%', borderRadius: R.sm, backgroundColor: C.surface2 },
  cardPosterEmpty: { alignItems: 'center', justifyContent: 'center' },
  cardName: { color: C.textSoft, fontSize: 10, fontWeight: '600', marginTop: 3 },
  ratingChip: {
    position: 'absolute', top: 4, right: 4,
    backgroundColor: 'rgba(10,16,30,0.78)', borderRadius: 999,
    paddingHorizontal: 6, paddingVertical: 1,
  },
  ratingChipText: { color: C.green, fontSize: 8, fontWeight: '800' },

  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  overlayBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: C.overlay },
  sheet: {
    width: '82%', height: '86%',
    flexDirection: 'row',
    borderRadius: R.lg, borderWidth: 1, borderColor: C.border,
    padding: 16, gap: 16,
  },
  sheetPosterCol: { width: 150 },
  sheetPoster: { width: 150, aspectRatio: 2 / 3, borderRadius: R.md, backgroundColor: C.surface2 },
  sheetMetaSmall: { color: C.textSoft, fontSize: 12, marginTop: 8, textAlign: 'center' },
  sheetInfoCol: { flex: 1 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  sheetTitle: { flex: 1, color: C.text, fontSize: 19, fontWeight: '700' },
  closeBtn: { padding: 6, marginLeft: 8 },
  sheetPlot: { color: C.textMuted, fontSize: 12, lineHeight: 17, marginBottom: 8 },

  seasonStrip: { marginTop: 10, flexGrow: 0 },
  seasonPill: { paddingVertical: 7, paddingHorizontal: 14, backgroundColor: C.surface2, borderRadius: 999, marginRight: 8, borderWidth: 1, borderColor: C.border },
  seasonPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  seasonText: { color: C.text, fontWeight: '600', fontSize: 12 },

  epRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingVertical: 10, paddingHorizontal: 10, marginTop: 6,
    backgroundColor: C.surface2, borderRadius: R.sm,
  },
  epNum: { color: C.blue, width: 26, fontSize: 13, fontWeight: '700', marginTop: 1 },
  epTitle: { color: C.text, fontSize: 13, fontWeight: '600' },
  epPlot: { color: C.textMuted, fontSize: 11, marginTop: 3, lineHeight: 16 },
});
