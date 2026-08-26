import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, ScrollView, TouchableOpacity, Image, StyleSheet, ActivityIndicator } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import xtreamApi from '../services/xtreamApi';
import { listMergedLiveChannels, replaceEpgForChannel, getEpgForChannels } from '../database/iptv';
import { C, R } from '../theme';

const CHANNEL_LIMIT = 80;
const SLOT_MINUTES = 30;
const SLOT_COUNT = 8;
const CHANNEL_WIDTH = 132;
const SLOT_WIDTH = 116;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

function decodeBase64Utf8(input) {
  const clean = String(input).replace(/\s/g, '');
  let output = '';
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    if (char === '=') break;
    const value = B64.indexOf(char);
    if (value < 0) return input;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  try {
    return decodeURIComponent(output.split('').map((char) => {
      return `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
    }).join(''));
  } catch {
    return output;
  }
}

function decodeMaybeBase64(value) {
  if (!value) return '';
  const text = String(value);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return text;
  try {
    const decoded = globalThis.atob ? globalThis.atob(text) : decodeBase64Utf8(text);
    return decoded.replace(/[^\x20-\x7E]+/g, ' ').trim() || text;
  } catch {
    return text;
  }
}

function parseEpgEntry(entry) {
  const start = Number(entry.start_timestamp ?? entry.start_ts ?? entry.start);
  const stop = Number(entry.stop_timestamp ?? entry.stop_ts ?? entry.end ?? entry.stop);
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return null;
  return {
    start_ts: start,
    stop_ts: stop,
    title: decodeMaybeBase64(entry.title),
    description: decodeMaybeBase64(entry.description),
  };
}

function floorToSlot(date) {
  const d = new Date(date);
  d.setMinutes(Math.floor(d.getMinutes() / SLOT_MINUTES) * SLOT_MINUTES, 0, 0);
  return d;
}

function timeLabel(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function EpgGuideScreen({ navigation }) {
  const [channels, setChannels] = useState([]);
  const [epgRows, setEpgRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [windowStart, setWindowStart] = useState(() => Math.floor(floorToSlot(new Date()).getTime() / 1000));

  const slots = useMemo(() => {
    return Array.from({ length: SLOT_COUNT }, (_, index) => {
      const start = windowStart + index * SLOT_MINUTES * 60;
      return { start, stop: start + SLOT_MINUTES * 60 };
    });
  }, [windowStart]);

  const windowStop = slots[slots.length - 1].stop;

  useEffect(() => {
    navigation.setOptions({ title: 'TV Guide' });
  }, [navigation]);

  const loadCached = useCallback(async (loadedChannels) => {
    const rows = await getEpgForChannels(loadedChannels.map((channel) => channel.stream_id), windowStart, windowStop);
    setEpgRows(rows);
    return rows;
  }, [windowStart, windowStop]);

  const syncEpg = useCallback(async (loadedChannels) => {
    if (!loadedChannels.length) return;
    setSyncing(true);
    setError(null);
    try {
      const batch = loadedChannels.slice(0, CHANNEL_LIMIT);
      for (const channel of batch) {
        const response = await xtreamApi.getShortEpg(channel.stream_id, 8);
        const listings = Array.isArray(response?.epg_listings) ? response.epg_listings : [];
        const parsed = listings.map(parseEpgEntry).filter(Boolean);
        if (parsed.length) await replaceEpgForChannel(channel.stream_id, parsed);
      }
      await loadCached(loadedChannels);
    } catch (e) {
      console.warn('EPG sync failed', e);
      setError(e?.message || 'Could not load EPG.');
    } finally {
      setSyncing(false);
    }
  }, [loadCached]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const live = await listMergedLiveChannels(CHANNEL_LIMIT, 0);
        if (cancelled) return;
        setChannels(live);
        const rows = await getEpgForChannels(live.map((channel) => channel.stream_id), windowStart, windowStop);
        if (cancelled) return;
        setEpgRows(rows);
        if (!rows.length) await syncEpg(live);
      } catch (e) {
        console.warn('guide load failed', e);
        if (!cancelled) setError(e?.message || 'Could not load guide.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [syncEpg, windowStart, windowStop]);

  const epgByChannel = useMemo(() => {
    const map = new Map();
    for (const row of epgRows) {
      const key = String(row.channel_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  }, [epgRows]);

  function programForSlot(channelId, slot) {
    const rows = epgByChannel.get(String(channelId)) || [];
    return rows.find((row) => row.start_ts < slot.stop && row.stop_ts > slot.start);
  }

  function openChannel(channel) {
    navigation.navigate('Player', {
      kind: 'live',
      streamId: channel.stream_id,
      title: channel.name,
      liveVariants: channel.variants || [],
    });
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={C.accentSoft} /></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TouchableOpacity style={styles.toolButton} onPress={() => setWindowStart((ts) => ts - SLOT_COUNT * SLOT_MINUTES * 60)}>
          <FontAwesome name="chevron-left" size={14} color={C.text} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.todayButton} onPress={() => setWindowStart(Math.floor(floorToSlot(new Date()).getTime() / 1000))}>
          <Text style={styles.todayText}>Now</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolButton} onPress={() => setWindowStart((ts) => ts + SLOT_COUNT * SLOT_MINUTES * 60)}>
          <FontAwesome name="chevron-right" size={14} color={C.text} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.refreshButton} onPress={() => syncEpg(channels)}>
          <FontAwesome name="refresh" size={14} color={C.text} />
          <Text style={styles.refreshText}>{syncing ? 'Loading' : 'Refresh'}</Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ScrollView horizontal style={styles.gridScroll}>
        <View>
          <View style={styles.headerRow}>
            <View style={styles.channelHeader}><Text style={styles.headerText}>Channel</Text></View>
            {slots.map((slot) => (
              <View key={slot.start} style={styles.slotHeader}>
                <Text style={styles.headerText}>{timeLabel(slot.start)}</Text>
              </View>
            ))}
          </View>

          <FlatList
            data={channels}
            keyExtractor={(item) => item.stream_id}
            renderItem={({ item }) => (
              <View style={styles.gridRow}>
                <TouchableOpacity style={styles.channelCell} onPress={() => openChannel(item)}>
                  {item.stream_icon ? <Image source={{ uri: item.stream_icon }} style={styles.logo} /> : null}
                  <View style={styles.channelTextWrap}>
                    <Text style={styles.channelName} numberOfLines={2}>{item.name}</Text>
                    {item.variant_count > 1 ? (
                      <Text style={styles.qualityText} numberOfLines={1}>{item.variants.map((variant) => variant.quality).join(' / ')}</Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
                {slots.map((slot) => {
                  const program = programForSlot(item.stream_id, slot);
                  return (
                    <TouchableOpacity key={`${item.stream_id}:${slot.start}`} style={styles.programCell} onPress={() => openChannel(item)}>
                      <Text style={styles.programTitle} numberOfLines={2}>{program?.title || 'No information'}</Text>
                      {program ? <Text style={styles.programTime}>{timeLabel(program.start_ts)} - {timeLabel(program.stop_ts)}</Text> : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            ListEmptyComponent={<View style={styles.emptyWrap}><Text style={styles.empty}>No live channels found.</Text></View>}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  toolbar: { minHeight: 50, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.surface },
  toolButton: { width: 38, height: 34, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface2 },
  todayButton: { height: 34, paddingHorizontal: 14, borderRadius: R.sm, justifyContent: 'center', backgroundColor: C.accent },
  todayText: { color: C.text, fontWeight: '800' },
  refreshButton: { height: 34, paddingHorizontal: 12, borderRadius: R.sm, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.surface2 },
  refreshText: { color: C.text, fontWeight: '700' },
  error: { color: C.danger, paddingHorizontal: 12, paddingVertical: 8 },
  gridScroll: { flex: 1 },
  headerRow: { flexDirection: 'row', backgroundColor: C.surface2 },
  channelHeader: { width: CHANNEL_WIDTH, height: 40, paddingHorizontal: 10, justifyContent: 'center', borderRightWidth: 1, borderRightColor: C.border },
  slotHeader: { width: SLOT_WIDTH, height: 40, paddingHorizontal: 8, justifyContent: 'center', borderRightWidth: 1, borderRightColor: C.border },
  headerText: { color: C.blue, fontSize: 12, fontWeight: '800' },
  gridRow: { minHeight: 72, flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border },
  channelCell: { width: CHANNEL_WIDTH, minHeight: 72, padding: 8, flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderRightWidth: 1, borderRightColor: C.border },
  logo: { width: 32, height: 32, borderRadius: 4, marginRight: 8, backgroundColor: C.surface2 },
  channelTextWrap: { flex: 1 },
  channelName: { color: C.text, fontSize: 12, fontWeight: '700' },
  qualityText: { color: C.textMuted, fontSize: 10, marginTop: 4, fontWeight: '700' },
  programCell: { width: SLOT_WIDTH, minHeight: 72, padding: 8, justifyContent: 'center', backgroundColor: C.bg, borderRightWidth: 1, borderRightColor: C.border },
  programTitle: { color: C.text, fontSize: 12, fontWeight: '600' },
  programTime: { color: C.textMuted, fontSize: 10, marginTop: 6 },
  emptyWrap: { width: CHANNEL_WIDTH + SLOT_WIDTH * SLOT_COUNT, padding: 24, alignItems: 'center' },
  empty: { color: C.textMuted },
});
