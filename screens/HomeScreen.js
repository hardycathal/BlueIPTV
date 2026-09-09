// HomeScreen
// Cinematic one-screen landscape dashboard:
//   header      — brand + playlist, TV Guide / Search shortcuts
//   rail        — "Continue watching" posters with progress bars (if any)
//   hero cards  — Live TV / Movies / Series gradient cards with counts

import { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, Image } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { LinearGradient } from 'expo-linear-gradient';
import { getCatalogueCounts, listContinueWatchingDetailed } from '../database/iptv';
import { useAuth } from '../context/AuthContext';
import xtreamApi from '../services/xtreamApi';
import { C, R, G } from '../theme';

function formatExpiry(expDate) {
  if (!expDate) return 'Unlimited';
  const d = new Date(Number(expDate) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { activePlaylist } = useAuth();
  const [counts, setCounts] = useState(null);
  const [resume, setResume] = useState([]);
  const [account, setAccount] = useState(null); // provider user_info | 'offline'

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getCatalogueCounts().then((c) => { if (!cancelled) setCounts(c); }).catch(() => {});
      listContinueWatchingDetailed(12).then((rows) => { if (!cancelled) setResume(rows); }).catch(() => {});
      if (activePlaylist?.type === 'm3u') {
        setAccount(null); // M3U and demo playlists have no account API to ping
      } else {
        xtreamApi.authPing()
          .then((data) => { if (!cancelled) setAccount(data.user_info || 'offline'); })
          .catch(() => { if (!cancelled) setAccount('offline'); });
      }
      return () => { cancelled = true; };
    }, [activePlaylist?.id])
  );

  const isM3u = activePlaylist?.type === 'm3u';
  const isDemo = activePlaylist?.type === 'demo';
  const online = account && account !== 'offline';
  const statusLabel = isDemo
    ? 'Demo'
    : isM3u
    ? 'M3U'
    : online
      ? (String(account.status || 'Active'))
      : (account === 'offline' ? 'Unreachable' : null);
  const expiryLabel = online ? formatExpiry(account.exp_date) : null;

  function playResume(item) {
    if (item.item_type === 'vod') {
      navigation.navigate('Player', {
        kind: 'vod',
        streamId: item.item_id,
        container: item.container_extension || 'mp4',
        title: item.name,
        directUrl: item.direct_url || null,
      });
    } else {
      navigation.navigate('Player', {
        kind: 'episode',
        episodeId: item.item_id,
        container: item.container_extension || 'mp4',
        title: `${item.name} S${item.season_number} E${item.episode_num}`,
        seriesId: item.series_id,
        seriesName: item.name,
        season: item.season_number,
        episodeNum: item.episode_num,
      });
    }
  }

  const HERO = [
    { key: 'live',    title: 'Live TV',  icon: 'television-classic', grad: G.live,    count: counts?.live,   to: () => navigation.navigate('LiveTv') },
    { key: 'catchup', title: 'Catch-Up', icon: 'history',            grad: G.catchup, count: null,           to: () => navigation.navigate('CatchUp') },
    { key: 'vod',     title: 'Movies',   icon: 'movie-open',         grad: G.movies,  count: counts?.vod,    to: () => navigation.navigate('Movies') },
    { key: 'series',  title: 'Series',   icon: 'television-play',    grad: G.series,  count: counts?.series, to: () => navigation.navigate('SeriesBrowse') },
  ];

  return (
    <View style={[s.container, { paddingTop: Math.max(insets.top, 12), paddingLeft: insets.left, paddingRight: insets.right }]}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={s.brand}> Blue IPTV</Text>
          <View style={s.playlistRow}>
            <Text style={s.playlistName} numberOfLines={1}>{activePlaylist?.name ?? ''}</Text>
            {statusLabel ? (
              <View style={s.statusChip}>
                <View style={[s.statusDot, { backgroundColor: (isM3u || isDemo) ? C.blue : online ? C.green : C.danger }]} />
                <Text style={[s.statusText, { color: (isM3u || isDemo) ? C.blue : online ? C.green : C.danger }]}>{statusLabel}</Text>
              </View>
            ) : null}
            {expiryLabel ? (
              <Text style={s.expiryText}>Expires {expiryLabel}</Text>
            ) : null}
          </View>
        </View>
        <TouchableOpacity style={s.ghostBtn} onPress={() => navigation.navigate('EpgGuide')}>
          <MaterialCommunityIcons name="calendar-clock" size={15} color={C.blue} />
          <Text style={s.ghostText}>  Guide</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.ghostBtn} onPress={() => navigation.navigate('Search')}>
          <MaterialCommunityIcons name="magnify" size={16} color={C.blue} />
          <Text style={s.ghostText}>  Search</Text>
        </TouchableOpacity>
      </View>

      {/* Continue watching rail */}
      {resume.length ? (
        <View style={s.railWrap}>
          <Text style={s.railLabel}>Continue watching</Text>
          <FlatList
            horizontal
            data={resume}
            keyExtractor={(i) => `${i.item_type}:${i.item_id}`}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}
            renderItem={({ item }) => {
              const frac = item.duration_seconds > 0
                ? Math.min(1, item.position_seconds / item.duration_seconds) : 0;
              return (
                <TouchableOpacity style={s.railCard} onPress={() => playResume(item)} activeOpacity={0.8}>
                  {item.image
                    ? <Image source={{ uri: item.image }} style={s.railPoster} />
                    : <View style={[s.railPoster, s.railPosterEmpty]}>
                        <MaterialCommunityIcons name="play" size={22} color={C.textMuted} />
                      </View>}
                  <LinearGradient colors={G.posterFade} style={s.railFade} />
                  <View style={s.railInfo}>
                    <Text style={s.railName} numberOfLines={1}>
                      {item.item_type === 'episode' ? `${item.name} S${item.season_number}E${item.episode_num}` : item.name}
                    </Text>
                    <View style={s.railTrack}>
                      <View style={[s.railFill, { width: `${frac * 100}%` }]} />
                    </View>
                  </View>
                  <View style={s.railPlayBadge}>
                    <MaterialCommunityIcons name="play" size={14} color={C.text} />
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        </View>
      ) : null}

      {/* Hero cards */}
      <View style={s.heroRow}>
        {HERO.map((t) => (
          <TouchableOpacity key={t.key} style={s.heroTouch} onPress={t.to} activeOpacity={0.85}>
            <LinearGradient colors={t.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.heroCard}>
              <MaterialCommunityIcons name={t.icon} size={resume.length ? 26 : 34} color="rgba(255,255,255,0.95)" />
              <View style={s.heroTextWrap}>
                <Text style={s.heroTitle} numberOfLines={1}>{t.title}</Text>
                <Text style={s.heroCount}>
                  {t.count == null ? '' : `${Number(t.count).toLocaleString()} items`}
                </Text>
              </View>
            </LinearGradient>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingVertical: 12 },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 10, gap: 10 },
  brand: { color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: 3 },
  playlistRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 1 },
  playlistName: { color: C.textMuted, fontSize: 11, maxWidth: 180 },
  statusChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 10, fontWeight: '800' },
  expiryText: { color: C.blue, fontSize: 10, fontWeight: '600' },
  ghostBtn: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 7, backgroundColor: 'rgba(27,42,74,0.5)',
  },
  ghostText: { color: C.textSoft, fontSize: 12, fontWeight: '600' },

  railWrap: { marginBottom: 10 },
  railLabel: {
    color: C.blue, fontSize: 11, fontWeight: '800', textTransform: 'uppercase',
    letterSpacing: 1.2, paddingHorizontal: 20, marginBottom: 6,
  },
  railCard: { width: 176, height: 104, borderRadius: R.md, overflow: 'hidden', backgroundColor: C.surface },
  railPoster: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined },
  railPosterEmpty: { alignItems: 'center', justifyContent: 'center' },
  railFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 },
  railInfo: { position: 'absolute', left: 8, right: 8, bottom: 6 },
  railName: { color: C.text, fontSize: 11, fontWeight: '600' },
  railTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(184,205,232,0.3)', marginTop: 5 },
  railFill: { height: 3, borderRadius: 2, backgroundColor: C.accentSoft },
  railPlayBadge: {
    position: 'absolute', top: 6, right: 6,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(139,31,168,0.85)',
    alignItems: 'center', justifyContent: 'center',
  },

  heroRow: { flex: 1, flexDirection: 'row', gap: 12, paddingHorizontal: 20 },
  heroTouch: { flex: 1 },
  heroCard: {
    flex: 1, borderRadius: R.xl,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, gap: 11,
  },
  heroTextWrap: { flex: 1 },
  heroTitle: { color: C.text, fontSize: 16, fontWeight: '800' },
  heroCount: { color: 'rgba(255,255,255,0.75)', fontSize: 10, fontWeight: '600', marginTop: 2 },
});
