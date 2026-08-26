// LiveTvScreen
// TiviMate-style single-screen live TV browser (landscape):
//
//   ┌────────────┬───────────────┬──────────────────────┐
//   │ Categories │ Channels      │ Preview player       │
//   │            │               ├──────────────────────┤
//   │            │               │ Now / Next EPG       │
//   └────────────┴───────────────┴──────────────────────┘
//
// Single tap a channel  -> plays in the preview pane
// Double tap a channel  -> opens fullscreen Player
// The preview is only mounted while this screen is focused.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet, ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { LinearGradient } from 'expo-linear-gradient';
import { VLCPlayer } from 'react-native-vlc-media-player';
import xtreamApi from '../services/xtreamApi';
import {
  listCategories, listMergedLiveByCategory, searchLiveByName,
  listFavouriteLive, listFavourites, isFavourite, addFavourite, removeFavourite, hideCategory,
} from '../database/iptv';
import { parseShortEpg, timeLabel } from '../utils/epgText';
import SearchBar from '../components/SearchBar';
import { C, R, G } from '../theme';

const DOUBLE_TAP_MS = 350;
const FAV_CAT = '__favourites__';
const CHANNEL_ROW_H = 46;

function qualityLabels(channel) {
  const labels = (channel.variants || []).map((v) => v.quality).filter(Boolean);
  return [...new Set(labels)];
}

// Memoized row: with ~2000 channels loaded, re-rendering every row on each
// tap makes the list visibly slow (VirtualizedList warning). This only
// re-renders rows whose `active`/`fav` props actually changed.
const ChannelRow = React.memo(function ChannelRow({ item, active, fav, onPress, onLongPress }) {
  return (
    <TouchableOpacity
      style={[s.chanRow, active && s.chanRowActive]}
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress(item)}
    >
      {item.stream_icon
        ? <Image source={{ uri: item.stream_icon }} style={s.chanLogo} />
        : <View style={[s.chanLogo, s.chanLogoEmpty]}><FontAwesome name="tv" size={12} color={C.textMuted} /></View>}
      <Text style={[s.chanName, active && { color: C.text }]} numberOfLines={1}>{item.name}</Text>
      {qualityLabels(item).map((q) => (
        <View key={q} style={s.qualityChip}>
          <Text style={s.qualityChipText}>{q}</Text>
        </View>
      ))}
      {fav ? <FontAwesome name="heart" size={10} color={C.danger} /> : null}
      {active ? <FontAwesome name="play" size={10} color={C.green} /> : null}
    </TouchableOpacity>
  );
});

export default function LiveTvScreen({ navigation }) {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [cats, setCats] = useState(null);
  const [selectedCat, setSelectedCat] = useState(null);
  const [channels, setChannels] = useState([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [selected, setSelected] = useState(null);     // channel object
  const [epg, setEpg] = useState(null);               // [{title,start_ts,...}]
  const [epgLoading, setEpgLoading] = useState(false);
  const [previewFormat, setPreviewFormat] = useState('hls');
  const [previewError, setPreviewError] = useState(null);
  const [query, setQuery] = useState('');
  const [clearSignal, setClearSignal] = useState(0);
  const [favIds, setFavIds] = useState(new Set());
  const lastTap = useRef({ id: null, at: 0 });
  const didFallback = useRef(false);

  // Load categories once (★ Favourites is a virtual category on top).
  useEffect(() => {
    listCategories('live')
      .then((rows) => {
        setCats([{ category_id: FAV_CAT, name: '★ Favourites' }, ...rows]);
        setSelectedCat(rows.length ? rows[0].category_id : FAV_CAT);
      })
      .catch(() => setCats([{ category_id: FAV_CAT, name: '★ Favourites' }]));
  }, []);

  // ids of favourited channels, so rows can show a heart
  function loadFavIds() {
    listFavourites('live')
      .then((rows) => setFavIds(new Set(rows.map((r) => String(r.item_id)))))
      .catch(() => {});
  }
  useEffect(() => { loadFavIds(); }, []);

  function isChannelFav(channel) {
    if (favIds.has(String(channel.stream_id))) return true;
    return (channel.variants || []).some((v) => favIds.has(String(v.stream_id)));
  }

  // Picking a category cancels any active search.
  function pickCategory(categoryId) {
    if (query) {
      setQuery('');
      setClearSignal((n) => n + 1);
    }
    setSelectedCat(categoryId);
  }

  function refreshCats() {
    listCategories('live')
      .then((rows) => setCats([{ category_id: FAV_CAT, name: '★ Favourites' }, ...rows]))
      .catch(() => {});
  }

  function onCategoryLongPress(cat) {
    if (cat.category_id === FAV_CAT) return;
    Alert.alert('Hide category', `Hide "${cat.name}" from the list? You can restore hidden categories from the Profile tab.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Hide',
        style: 'destructive',
        onPress: async () => {
          await hideCategory('live', cat.category_id);
          if (selectedCat === cat.category_id) setSelectedCat(FAV_CAT);
          refreshCats();
        },
      },
    ]);
  }

  async function onChannelLongPress(channel) {
    const fav = await isFavourite('live', channel.stream_id);
    if (fav) await removeFavourite('live', channel.stream_id);
    else await addFavourite('live', channel.stream_id);
    Alert.alert('Favourites', `${fav ? 'Removed' : 'Added'} "${channel.name}" ${fav ? 'from' : 'to'} favourites.`);
    loadFavIds();
    if (selectedCat === FAV_CAT) {
      listFavouriteLive().then(setChannels).catch(() => {});
    }
  }

  // Load channels when the category changes — or search across ALL
  // categories when a query is active.
  useEffect(() => {
    if (selectedCat == null && !query) return;
    let cancelled = false;
    setLoadingChannels(true);
    const fetch = query
      ? searchLiveByName(query, 2000)
      : (selectedCat === FAV_CAT ? listFavouriteLive() : listMergedLiveByCategory(selectedCat, 2000, 0));
    fetch
      .then((rows) => {
        if (cancelled) return;
        setChannels(rows);
      })
      .catch(() => { if (!cancelled) setChannels([]); })
      .finally(() => { if (!cancelled) setLoadingChannels(false); });
    return () => { cancelled = true; };
  }, [selectedCat, query]);

  // Load EPG when the selected channel changes.
  useEffect(() => {
    if (!selected) { setEpg(null); return; }
    let cancelled = false;
    setEpgLoading(true);
    xtreamApi.getShortEpg(selected.stream_id, 6)
      .then((res) => { if (!cancelled) setEpg(parseShortEpg(res)); })
      .catch(() => { if (!cancelled) setEpg([]); })
      .finally(() => { if (!cancelled) setEpgLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.stream_id]);

  function openFullscreen(channel) {
    navigation.navigate('Player', {
      kind: 'live',
      streamId: channel.stream_id,
      title: channel.name,
      liveVariants: channel.variants || [],
      directUrl: channel.direct_url || null,
      // zap context: the player can flick through this category's channels
      liveCategoryId: selectedCat === FAV_CAT ? FAV_CAT : selectedCat,
    });
  }

  // Stable callbacks (via refs) so memoized rows never re-render just
  // because the parent re-rendered.
  const selectedRef = useRef(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const openFullscreenRef = useRef(openFullscreen);
  useEffect(() => { openFullscreenRef.current = openFullscreen; });
  const longPressRef = useRef(onChannelLongPress);
  useEffect(() => { longPressRef.current = onChannelLongPress; });

  const onChannelPress = useCallback((channel) => {
    const now = Date.now();
    if (lastTap.current.id === channel.stream_id && now - lastTap.current.at < DOUBLE_TAP_MS) {
      lastTap.current = { id: null, at: 0 };
      openFullscreenRef.current(channel);
      return;
    }
    lastTap.current = { id: channel.stream_id, at: now };
    if (selectedRef.current?.stream_id !== channel.stream_id) {
      didFallback.current = false;
      setPreviewFormat('hls');
      setPreviewError(null);
      setSelected(channel);
    }
  }, []);

  const onChannelLongPressStable = useCallback((channel) => {
    longPressRef.current(channel);
  }, []);

  function onPreviewError() {
    if (previewFormat === 'hls' && !didFallback.current) {
      didFallback.current = true;
      setPreviewFormat('ts');
      return;
    }
    setPreviewError('Preview unavailable — double-tap the channel to try fullscreen.');
  }

  let previewUrl = null;
  if (selected) {
    if (selected.direct_url) {
      previewUrl = selected.direct_url; // m3u channel
    } else {
      try { previewUrl = xtreamApi.liveStreamUrl(selected.stream_id, { hls: previewFormat === 'hls' }); }
      catch { previewUrl = null; }
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const nowProg = epg?.find((p) => p.start_ts <= nowSec && p.stop_ts > nowSec) ?? null;
  const nextProgs = (epg ?? []).filter((p) => p.start_ts > nowSec).slice(0, 3);

  if (!cats) {
    return <View style={s.center}><ActivityIndicator color={C.accentSoft} /></View>;
  }

  return (
    <View style={[s.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      {/* Slim header (stack header is hidden to save vertical space) */}
      <View style={s.topBar}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()}>
          <FontAwesome name="chevron-left" size={14} color={C.text} />
        </TouchableOpacity>
        <Text style={s.topTitle}>Live TV{query ? '  ·  all categories' : ''}</Text>
        <View style={{ flex: 1 }} />
        <SearchBar placeholder="Search channels…" onQuery={setQuery} clearSignal={clearSignal} />
      </View>

      <View style={s.container}>
      {/* Categories */}
      <View style={s.catPane}>
        <Text style={s.paneLabel}>Categories</Text>
        <FlatList
          data={cats}
          keyExtractor={(c) => c.category_id}
          renderItem={({ item }) => {
            const active = item.category_id === selectedCat;
            return (
              <TouchableOpacity
                style={s.catRow}
                onPress={() => pickCategory(item.category_id)}
                onLongPress={() => onCategoryLongPress(item)}
              >
                {active ? (
                  <LinearGradient
                    colors={G.live}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={StyleSheet.absoluteFill}
                  />
                ) : null}
                <Text style={[s.catText, active && s.catTextActive]} numberOfLines={2}>{item.name}</Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Channels */}
      <View style={s.chanPane}>
        <Text style={s.paneLabel}>Channels{channels.length ? `  ·  ${channels.length}` : ''}</Text>
        {loadingChannels ? (
          <ActivityIndicator color={C.accentSoft} style={{ marginTop: 20 }} />
        ) : (
          <FlatList
            data={channels}
            keyExtractor={(c) => c.stream_id}
            initialNumToRender={16}
            maxToRenderPerBatch={16}
            windowSize={8}
            removeClippedSubviews
            extraData={`${selected?.stream_id}:${favIds.size}`}
            getItemLayout={(_, index) => ({ length: CHANNEL_ROW_H, offset: CHANNEL_ROW_H * index, index })}
            renderItem={({ item }) => (
              <ChannelRow
                item={item}
                active={item.stream_id === selected?.stream_id}
                fav={isChannelFav(item)}
                onPress={onChannelPress}
                onLongPress={onChannelLongPressStable}
              />
            )}
            ListEmptyComponent={<Text style={s.empty}>No channels in this category.</Text>}
          />
        )}
      </View>

      {/* Preview + EPG */}
      <View style={s.rightPane}>
       <View style={s.previewRow}>
        <View style={s.previewBox}>
          {selected && previewUrl && isFocused && !previewError ? (
            <VLCPlayer
              key={`${selected.stream_id}:${previewFormat}`}
              style={s.preview}
              source={{ uri: previewUrl }}
              autoplay
              repeat
              resizeMode="contain"
              onError={onPreviewError}
            />
          ) : (
            <View style={s.previewPlaceholder}>
              <FontAwesome name="tv" size={28} color={C.textMuted} />
              <Text style={s.previewHint}>
                {previewError || 'Tap a channel to preview\nDouble-tap for fullscreen'}
              </Text>
            </View>
          )}
        </View>

        {/* "Up next" sits in the dead space beside the 16:9 preview */}
        <View style={s.upNextCol}>
          <Text style={s.upNextLabel}>Up next</Text>
          {selected && nextProgs.length ? (
            nextProgs.map((p) => (
              <View key={p.start_ts} style={s.upNextItem}>
                <Text style={s.upNextTime}>{timeLabel(p.start_ts)}</Text>
                <Text style={s.upNextTitle} numberOfLines={2}>{p.title}</Text>
              </View>
            ))
          ) : (
            <Text style={s.upNextEmpty}>—</Text>
          )}
        </View>
       </View>

        <View style={s.epgBox}>
          {selected ? (
            <>
              <View style={s.epgHeaderRow}>
                <Text style={[s.epgChannel, { flex: 1 }]} numberOfLines={1}>{selected.name}</Text>
                <TouchableOpacity style={s.fullscreenBtn} onPress={() => openFullscreen(selected)}>
                  <FontAwesome name="expand" size={11} color={C.text} />
                  <Text style={s.fullscreenText}> Full</Text>
                </TouchableOpacity>
              </View>
              {epgLoading ? (
                <ActivityIndicator color={C.accentSoft} style={{ marginTop: 10 }} size="small" />
              ) : nowProg ? (
                <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                  <View style={s.nowRow}>
                    <View style={s.liveDot} />
                    <Text style={s.nowTitle} numberOfLines={1}>{nowProg.title}</Text>
                  </View>
                  <Text style={s.nowTime}>{timeLabel(nowProg.start_ts)} – {timeLabel(nowProg.stop_ts)}</Text>
                  {nowProg.description ? (
                    <Text style={s.nowDesc}>{nowProg.description}</Text>
                  ) : null}
                </ScrollView>
              ) : (
                <Text style={s.empty}>No EPG data for this channel.</Text>
              )}
            </>
          ) : (
            <Text style={s.empty}>Programme info appears here.</Text>
          )}
        </View>
      </View>
      </View>
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
  container: { flex: 1, flexDirection: 'row', backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  paneLabel: { color: C.blue, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, padding: 10, paddingBottom: 6 },
  empty: { color: C.textMuted, fontSize: 12, padding: 10 },

  catPane: { width: 150, borderRightWidth: 1, borderRightColor: C.border, backgroundColor: C.surface },
  catRow: { paddingVertical: 11, paddingHorizontal: 12, overflow: 'hidden' },
  catText: { color: C.textSoft, fontSize: 13 },
  catTextActive: { color: C.text, fontWeight: '700' },

  chanPane: { flex: 1, borderRightWidth: 1, borderRightColor: C.border },
  chanRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    height: CHANNEL_ROW_H, paddingHorizontal: 12,
  },
  chanRowActive: { backgroundColor: C.surface2 },
  chanLogo: { width: 28, height: 28, borderRadius: 4, backgroundColor: C.surface2 },
  chanLogoEmpty: { alignItems: 'center', justifyContent: 'center' },
  chanName: { flex: 1, color: C.textSoft, fontSize: 13 },
  qualityChip: {
    backgroundColor: C.surface2, borderRadius: 4,
    borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 4, paddingVertical: 1,
  },
  qualityChipText: { color: C.blue, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },

  rightPane: { width: '42%', padding: 10 },
  previewRow: { flexDirection: 'row', gap: 8 },
  previewBox: {
    flex: 1, aspectRatio: 16 / 9,
    backgroundColor: '#000', borderRadius: R.md, overflow: 'hidden',
    borderWidth: 1, borderColor: C.border,
  },
  upNextCol: { width: 112 },
  upNextLabel: {
    color: C.blue, fontSize: 9, fontWeight: '800',
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4,
  },
  upNextItem: { marginBottom: 6 },
  upNextTime: { color: C.green, fontSize: 9, fontWeight: '800' },
  upNextTitle: { color: C.textSoft, fontSize: 10, lineHeight: 13 },
  upNextEmpty: { color: C.textMuted, fontSize: 10 },
  preview: { flex: 1 },
  previewPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  previewHint: { color: C.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 17 },

  epgHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fullscreenBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.accent, borderRadius: R.sm,
    paddingHorizontal: 9, paddingVertical: 5,
  },
  fullscreenText: { color: C.text, fontSize: 11, fontWeight: '700' },

  epgBox: {
    flex: 1, marginTop: 8,
    backgroundColor: C.surface, borderRadius: R.md,
    borderWidth: 1, borderColor: C.border, padding: 10,
  },
  epgChannel: { color: C.blue, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  nowRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  nowTitle: { color: C.text, fontSize: 15, fontWeight: '700', flex: 1 },
  nowTime: { color: C.textSoft, fontSize: 12, marginTop: 3 },
  nowDesc: { color: C.textMuted, fontSize: 12, marginTop: 6, lineHeight: 16 },
});
