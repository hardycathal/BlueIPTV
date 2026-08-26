// CatchUpScreen
// Replay recently-aired programmes on channels that support TV archive
// (Xtream timeshift). Layout (landscape):
//
//   ┌────────────────────┬──────────────────────────────┐
//   │ Archive channels   │ Day pills (Today…-7d)        │
//   │                    │ Programme list for that day  │
//   └────────────────────┴──────────────────────────────┘
//
// Tapping a finished programme opens the Player with a timeshift URL.

import { useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet,
  ActivityIndicator, ScrollView,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import xtreamApi from '../services/xtreamApi';
import { listArchiveChannels } from '../database/iptv';
import { decodeMaybeBase64, timeLabel } from '../utils/epgText';
import SearchBar from '../components/SearchBar';
import { C, R, G } from '../theme';

function dayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return Math.floor(d.getTime() / 1000);
}

function dayLabel(offsetDays) {
  if (offsetDays === 0) return 'Today';
  if (offsetDays === 1) return 'Yesterday';
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
}

function parseArchiveEpg(response) {
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
        hasArchive: e.has_archive == null ? null : Number(e.has_archive),
      };
    })
    .filter(Boolean);
}

export default function CatchUpScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [channels, setChannels] = useState(null);
  const [selected, setSelected] = useState(null);   // channel
  const [day, setDay] = useState(0);                // days back
  const [epg, setEpg] = useState(null);             // all parsed entries for channel
  const [loadingEpg, setLoadingEpg] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    listArchiveChannels()
      .then((rows) => {
        setChannels(rows);
        if (rows.length) setSelected(rows[0]);
      })
      .catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    if (!selected) { setEpg(null); return; }
    let cancelled = false;
    setLoadingEpg(true);
    setEpg(null);
    xtreamApi.getSimpleDataTable(selected.stream_id)
      .then((res) => { if (!cancelled) setEpg(parseArchiveEpg(res)); })
      .catch(() => { if (!cancelled) setEpg([]); })
      .finally(() => { if (!cancelled) setLoadingEpg(false); });
    return () => { cancelled = true; };
  }, [selected?.stream_id]);

  const archiveDays = Math.max(1, Math.min(14, Number(selected?.tv_archive_duration || 7)));
  const now = Math.floor(Date.now() / 1000);
  const from = dayStart(day);
  const to = from + 24 * 3600;
  const programmes = (epg ?? [])
    .filter((p) => p.start_ts >= from && p.start_ts < to)
    .filter((p) => p.stop_ts < now)                        // finished only
    .filter((p) => p.hasArchive !== 0)                     // archived (or unknown)
    .sort((a, b) => a.start_ts - b.start_ts);

  function play(p) {
    const durationMins = Math.round((p.stop_ts - p.start_ts) / 60);
    navigation.navigate('Player', {
      kind: 'catchup',
      streamId: selected.stream_id,
      start: p.start_ts,
      durationMins,
      title: `${p.title || 'Programme'} — ${selected.name}`,
    });
  }

  if (!channels) {
    return <View style={s.center}><ActivityIndicator color={C.accentSoft} /></View>;
  }

  return (
    <View style={[s.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={s.topBar}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()}>
          <FontAwesome name="chevron-left" size={14} color={C.text} />
        </TouchableOpacity>
        <Text style={s.topTitle}>Catch-Up TV</Text>
        <View style={{ flex: 1 }} />
        <SearchBar placeholder="Search channels…" onQuery={setQuery} minChars={1} />
      </View>

      {!channels.length ? (
        <View style={s.center}>
          <Text style={s.emptyBig}>No catch-up channels</Text>
          <Text style={s.empty}>Your provider doesn't flag any channels with TV archive.{'\n'}
            If catch-up works in other apps, try Profile → Refresh catalogue first.</Text>
        </View>
      ) : (
        <View style={s.container}>
          {/* Channels */}
          <View style={s.chanPane}>
            <Text style={s.paneLabel}>Channels · {channels.length}</Text>
            <FlatList
              data={query
                ? channels.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
                : channels}
              keyExtractor={(c) => c.stream_id}
              initialNumToRender={16}
              windowSize={8}
              renderItem={({ item }) => {
                const active = item.stream_id === selected?.stream_id;
                return (
                  <TouchableOpacity style={[s.chanRow, active && s.chanRowActive]} onPress={() => { setSelected(item); setDay(0); }}>
                    {item.stream_icon
                      ? <Image source={{ uri: item.stream_icon }} style={s.chanLogo} />
                      : <View style={[s.chanLogo, s.chanLogoEmpty]}><FontAwesome name="tv" size={12} color={C.textMuted} /></View>}
                    <Text style={[s.chanName, active && { color: C.text }]} numberOfLines={1}>{item.name}</Text>
                    {item.tv_archive_duration ? (
                      <Text style={s.chanDays}>{item.tv_archive_duration}d</Text>
                    ) : null}
                  </TouchableOpacity>
                );
              }}
            />
          </View>

          {/* Day pills + programmes */}
          <View style={{ flex: 1 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.dayStrip} contentContainerStyle={{ paddingHorizontal: 10, gap: 8 }}>
              {Array.from({ length: archiveDays }, (_, i) => i).map((i) => (
                <TouchableOpacity key={i} style={s.dayPillWrap} onPress={() => setDay(i)}>
                  {day === i ? (
                    <LinearGradient colors={G.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.dayPill}>
                      <Text style={s.dayText}>{dayLabel(i)}</Text>
                    </LinearGradient>
                  ) : (
                    <View style={[s.dayPill, s.dayPillIdle]}>
                      <Text style={[s.dayText, { color: C.textSoft }]}>{dayLabel(i)}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>

            {loadingEpg ? (
              <ActivityIndicator color={C.accentSoft} style={{ marginTop: 24 }} />
            ) : (
              <FlatList
                data={programmes}
                keyExtractor={(p) => String(p.start_ts)}
                contentContainerStyle={{ padding: 10 }}
                renderItem={({ item }) => (
                  <TouchableOpacity style={s.progRow} onPress={() => play(item)}>
                    <View style={s.progTimeCol}>
                      <Text style={s.progTime}>{timeLabel(item.start_ts)}</Text>
                      <Text style={s.progDur}>{Math.round((item.stop_ts - item.start_ts) / 60)} min</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.progTitle} numberOfLines={1}>{item.title || 'Programme'}</Text>
                      {item.description ? <Text style={s.progDesc} numberOfLines={2}>{item.description}</Text> : null}
                    </View>
                    <FontAwesome name="play-circle-o" size={22} color={C.accentSoft} />
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <Text style={s.empty}>
                    {epg && !epg.length
                      ? 'This channel has no archive EPG data.'
                      : 'No finished programmes for this day.'}
                  </Text>
                }
              />
            )}
          </View>
        </View>
      )}
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

  container: { flex: 1, flexDirection: 'row' },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center', padding: 24 },
  paneLabel: { color: C.blue, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, padding: 10, paddingBottom: 6 },
  empty: { color: C.textMuted, fontSize: 12, padding: 10, textAlign: 'center', lineHeight: 18 },
  emptyBig: { color: C.text, fontSize: 16, fontWeight: '700', marginBottom: 6 },

  chanPane: { width: 250, borderRightWidth: 1, borderRightColor: C.border, backgroundColor: C.surface },
  chanRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12 },
  chanRowActive: { backgroundColor: C.surface2 },
  chanLogo: { width: 26, height: 26, borderRadius: 4, backgroundColor: C.surface2 },
  chanLogoEmpty: { alignItems: 'center', justifyContent: 'center' },
  chanName: { flex: 1, color: C.textSoft, fontSize: 13 },
  chanDays: { color: C.green, fontSize: 10, fontWeight: '800' },

  dayStrip: { flexGrow: 0, marginTop: 8 },
  dayPillWrap: {},
  dayPill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  dayPillIdle: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  dayText: { color: C.text, fontSize: 12, fontWeight: '700' },

  progRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.surface, borderRadius: R.md,
    borderWidth: 1, borderColor: C.border,
    padding: 12, marginBottom: 8,
  },
  progTimeCol: { width: 64 },
  progTime: { color: C.green, fontSize: 13, fontWeight: '800' },
  progDur: { color: C.textMuted, fontSize: 10, marginTop: 2 },
  progTitle: { color: C.text, fontSize: 14, fontWeight: '600' },
  progDesc: { color: C.textMuted, fontSize: 11, marginTop: 3, lineHeight: 15 },
});
