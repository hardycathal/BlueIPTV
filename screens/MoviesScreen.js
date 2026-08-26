// MoviesScreen
// Single-screen movie browser (landscape): categories left, poster grid
// right. The grid sizes itself so EXACTLY three rows fit the screen on any
// device. Long titles scroll horizontally (MarqueeText). Tapping a poster
// opens an in-screen detail overlay with an always-visible Play button.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet,
  ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  listCategories, listVodByCategory, listFavouriteVod, listRecentVod,
  isFavourite, addFavourite, removeFavourite, searchVodByName, hideCategory,
} from '../database/iptv';
import { ensureVodInfo } from '../services/catalogueSync';
import MarqueeText from '../components/MarqueeText';
import SearchBar from '../components/SearchBar';
import { C, R, G } from '../theme';

// First page is deliberately small — roughly one screenful — so opening a
// category is instant; the rest streams in as the user scrolls.
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

function fetchVodPage(categoryId, limit, offset, query, sort) {
  if (query) return searchVodByName(query, limit, offset);
  if (categoryId === FAV_CAT) return listFavouriteVod(limit, offset);
  if (categoryId === RECENT_CAT) return listRecentVod(limit, offset);
  return listVodByCategory(categoryId, limit, offset, sort);
}

// Memoized poster card: without this every card re-renders whenever the
// parent state changes (paging, detail overlay), which stutters on scroll.
const PosterCard = React.memo(function PosterCard({ item, grid, onPress }) {
  return (
    <TouchableOpacity
      style={[s.card, { width: grid.cardW, height: grid.cardH }]}
      onPress={() => onPress(item)}
      activeOpacity={0.8}
    >
      {item.stream_icon
        ? <Image source={{ uri: item.stream_icon }} style={[s.cardPoster, { height: grid.posterH }]} />
        : <View style={[s.cardPoster, s.cardPosterEmpty, { height: grid.posterH }]}>
            <FontAwesome name="film" size={16} color={C.textMuted} />
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

export default function MoviesScreen({ navigation }) {
  const [cats, setCats] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [eof, setEof] = useState(false);
  const [detail, setDetail] = useState(null); // { vod, info|null, loading }
  const [grid, setGrid] = useState(null);     // { cardH, cardW, posterH, cols }
  const [query, setQuery] = useState('');     // section-scoped search
  const [clearSignal, setClearSignal] = useState(0); // bump to clear the search box
  const [sortIdx, setSortIdx] = useState(0);  // index into SORTS

  // Picking a category cancels any active search.
  function pickCategory(categoryId) {
    if (query) {
      setQuery('');
      setClearSignal((n) => n + 1);
    }
    setSelectedCat(categoryId);
  }

  useEffect(() => {
    listCategories('vod')
      .then((rows) => {
        const all = [...VIRTUAL_CATS, ...rows];
        setCats(all);
        // land on the first provider category; favourites may well be empty
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
    fetchVodPage(selectedCat, FIRST_PAGE, 0, query, SORTS[sortIdx].key)
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
    const next = await fetchVodPage(selectedCat, PAGE, items.length, query, SORTS[sortIdx].key);
    if (!next.length) { setEof(true); return; }
    setItems((cur) => cur.concat(next));
    if (next.length < PAGE) setEof(true);
  }

  // stable identity so memoized cards don't re-render on every parent update
  const openDetailStable = useCallback((vod) => { openDetail(vod); }, []);

  async function openDetail(vod) {
    setDetail({ vod, info: null, loading: true, fav: false });
    isFavourite('vod', vod.stream_id)
      .then((f) => setDetail((d) => (d?.vod.stream_id === vod.stream_id ? { ...d, fav: f } : d)))
      .catch(() => {});
    try {
      const i = await ensureVodInfo(vod.stream_id);
      setDetail((d) => (d?.vod.stream_id === vod.stream_id ? { ...d, info: i?.info || i || null, loading: false } : d));
    } catch {
      setDetail((d) => (d?.vod.stream_id === vod.stream_id ? { ...d, info: null, loading: false } : d));
    }
  }

  async function toggleFavourite() {
    if (!detail) return;
    const { vod, fav } = detail;
    if (fav) await removeFavourite('vod', vod.stream_id);
    else await addFavourite('vod', vod.stream_id);
    setDetail((d) => (d?.vod.stream_id === vod.stream_id ? { ...d, fav: !fav } : d));
    // keep the Favourites grid in sync if it's the one on screen
    if (selectedCat === FAV_CAT) {
      fetchVodPage(FAV_CAT, PAGE, 0).then(setItems).catch(() => {});
    }
  }

  function play(vod) {
    setDetail(null);
    navigation.navigate('Player', {
      kind: 'vod',
      streamId: vod.stream_id,
      container: vod.container_extension || 'mp4',
      title: vod.name,
      directUrl: vod.direct_url || null,
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
        <Text style={s.topTitle}>Movies{query ? `  ·  results for "${query}"` : ''}</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={s.sortBtn} onPress={() => setSortIdx((i) => (i + 1) % SORTS.length)}>
          <FontAwesome name="sort" size={11} color={C.textSoft} />
          <Text style={s.sortText}>  {SORTS[sortIdx].label}</Text>
        </TouchableOpacity>
        <SearchBar placeholder="Search movies…" onQuery={setQuery} clearSignal={clearSignal} />
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
                          await hideCategory('vod', item.category_id);
                          setCats((cur) => cur.filter((c) => c.category_id !== item.category_id));
                          if (selectedCat === item.category_id) setSelectedCat(FAV_CAT);
                        },
                      },
                    ]);
                  }}
                >
                  {active ? (
                    <LinearGradient colors={G.movies} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
                  ) : null}
                  <Text style={[s.catText, active && s.catTextActive]} numberOfLines={2}>{item.name}</Text>
                </TouchableOpacity>
              );
            }}
          />
        </View>

        {/* Poster grid — sizes itself to fit exactly 3 rows */}
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
              keyExtractor={(v) => v.stream_id}
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
              {(detail.info?.movie_image || detail.info?.cover_big || detail.vod.stream_icon) ? (
                <Image
                  source={{ uri: detail.info?.movie_image || detail.info?.cover_big || detail.vod.stream_icon }}
                  style={s.sheetPoster}
                />
              ) : (
                <View style={[s.sheetPoster, s.cardPosterEmpty]}><FontAwesome name="film" size={34} color={C.textMuted} /></View>
              )}
            </View>
            <View style={s.sheetInfoCol}>
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle} numberOfLines={2}>{detail.vod.name}</Text>
                <TouchableOpacity style={s.closeBtn} onPress={toggleFavourite}>
                  <FontAwesome name={detail.fav ? 'heart' : 'heart-o'} size={18} color={detail.fav ? C.danger : C.textSoft} />
                </TouchableOpacity>
                <TouchableOpacity style={s.closeBtn} onPress={() => setDetail(null)}>
                  <FontAwesome name="times" size={16} color={C.textSoft} />
                </TouchableOpacity>
              </View>
              <Text style={s.sheetMeta}>
                {detail.vod.rating ? `★ ${Number(detail.vod.rating).toFixed(1)}   ` : ''}
                {detail.info?.releasedate || detail.info?.year || ''}
                {detail.info?.duration ? `   ${detail.info.duration}` : ''}
              </Text>
              <TouchableOpacity onPress={() => play(detail.vod)} activeOpacity={0.85}>
                <LinearGradient colors={G.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.playBtn}>
                  <FontAwesome name="play" size={14} color={C.text} />
                  <Text style={s.playText}>  Play</Text>
                </LinearGradient>
              </TouchableOpacity>
              <ScrollView style={{ flex: 1, marginTop: 10 }}>
                {detail.loading ? (
                  <ActivityIndicator color={C.accentSoft} size="small" style={{ marginTop: 8 }} />
                ) : (
                  <>
                    {detail.info?.plot || detail.info?.description
                      ? <Text style={s.sheetPlot}>{detail.info?.plot || detail.info?.description}</Text>
                      : <Text style={s.empty}>No description available.</Text>}
                    {detail.info?.cast || detail.info?.actors
                      ? <Text style={s.sheetCast}>Cast: {String(detail.info?.cast || detail.info?.actors)}</Text>
                      : null}
                    {detail.info?.genre ? <Text style={s.sheetCast}>Genre: {detail.info.genre}</Text> : null}
                  </>
                )}
              </ScrollView>
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
    width: '78%', height: '84%',
    flexDirection: 'row',
    borderRadius: R.lg, borderWidth: 1, borderColor: C.border,
    padding: 16, gap: 16,
  },
  sheetPosterCol: { width: 150 },
  sheetPoster: { width: 150, aspectRatio: 2 / 3, borderRadius: R.md, backgroundColor: C.surface2 },
  sheetInfoCol: { flex: 1 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  sheetTitle: { flex: 1, color: C.text, fontSize: 19, fontWeight: '700' },
  closeBtn: { padding: 6, marginLeft: 8 },
  sheetMeta: { color: C.textSoft, fontSize: 13, marginTop: 4 },
  playBtn: {
    flexDirection: 'row', alignSelf: 'flex-start',
    borderRadius: R.sm,
    paddingHorizontal: 22, paddingVertical: 10, marginTop: 12,
    alignItems: 'center',
  },
  playText: { color: C.text, fontSize: 15, fontWeight: '700' },
  sheetPlot: { color: C.textSoft, fontSize: 13, lineHeight: 19 },
  sheetCast: { color: C.textMuted, fontSize: 12, marginTop: 10 },
});
