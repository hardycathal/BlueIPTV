// ProfileScreen
// Shows the connected provider account (pulled live from player_api.php),
// a refresh-catalogue action, and sign out. Landscape: info left, actions right.

import { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../context/AuthContext';
import xtreamApi from '../services/xtreamApi';
import { countHiddenCategories, unhideAllCategories } from '../database/iptv';
import { C, R, G } from '../theme';

function formatExpiry(expDate) {
  if (!expDate) return 'Unlimited';
  const d = new Date(Number(expDate) * 1000);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export default function ProfileScreen({ navigation }) {
  const { logout, activePlaylist } = useAuth();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hiddenCount, setHiddenCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      countHiddenCategories().then((n) => { if (!cancelled) setHiddenCount(n); }).catch(() => {});
      (async () => {
        setLoading(true);
        if (activePlaylist?.type === 'm3u') {
          // No account API for plain playlists
          if (!cancelled) { setInfo(null); setLoading(false); }
          return;
        }
        try {
          const data = await xtreamApi.authPing();
          if (!cancelled) setInfo(data.user_info);
        } catch (e) {
          if (!cancelled) setInfo(null);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }, [activePlaylist?.id])
  );

  function handleResync() {
    Alert.alert(
      'Refresh catalogue',
      'Re-download all channels, movies and series from your provider? Favourites and watch progress are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Refresh', onPress: () => navigation.navigate('Browse', { screen: 'Sync' }) },
      ],
    );
  }

  function handleSignOut() {
    Alert.alert('Sign Out', 'This removes all saved playlists and the cached catalogue.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  }

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color={C.accentSoft} />
      </View>
    );
  }

  const isM3u = activePlaylist?.type === 'm3u';
  const online = !!info;
  const rows = isM3u
    ? [
        ['Playlist', activePlaylist?.name ?? '—'],
        ['Type', 'M3U playlist'],
        ['URL', activePlaylist?.url ?? '—'],
      ]
    : [
        ['Playlist', activePlaylist?.name ?? '—'],
        ['Provider', activePlaylist?.host ?? '—'],
        ['Username', info?.username ?? activePlaylist?.username ?? '—'],
        ['Status', info?.status ?? 'Unreachable'],
        ['Expires', info ? formatExpiry(info.exp_date) : '—'],
        ['Connections', info ? `${info.active_cons ?? 0} / ${info.max_connections ?? '—'}` : '—'],
      ];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={s.container}>
      {/* Left: account info */}
      <View style={s.pane}>
        <View style={s.headerRow}>
          <View style={s.avatar}>
            <FontAwesome name="user" size={34} color={C.blue} />
          </View>
          <View style={{ marginLeft: 14 }}>
            <Text style={s.username}>{isM3u ? (activePlaylist?.name ?? 'M3U') : (info?.username ?? activePlaylist?.username ?? '—')}</Text>
            <View style={s.statusRow}>
              <View style={[s.statusDot, { backgroundColor: isM3u ? C.blue : online ? C.green : C.danger }]} />
              <Text style={[s.statusText, { color: isM3u ? C.blue : online ? C.green : C.danger }]}>
                {isM3u ? 'M3U playlist' : online ? 'Connected' : 'Unreachable'}
              </Text>
            </View>
          </View>
        </View>

        <View style={s.card}>
          {rows.map(([label, value]) => (
            <View key={label} style={s.row}>
              <Text style={s.rowLabel}>{label}</Text>
              <Text style={s.rowValue} numberOfLines={1}>{value}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Right: actions */}
      <View style={s.pane}>
        <Text style={s.paneTitle}>Actions</Text>

        <TouchableOpacity onPress={handleResync} activeOpacity={0.85}>
          <LinearGradient colors={G.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.actionBtn}>
            <FontAwesome name="refresh" size={16} color={C.text} />
            <Text style={s.actionText}>  Refresh catalogue</Text>
          </LinearGradient>
        </TouchableOpacity>
        <Text style={s.actionHint}>
          Pulls the latest channels, movies and series from your provider.
        </Text>

        {hiddenCount > 0 ? (
          <>
            <TouchableOpacity
              style={[s.actionBtn, s.secondaryBtn]}
              onPress={() => {
                Alert.alert('Restore categories', `Unhide all ${hiddenCount} hidden categories?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Unhide all', onPress: async () => { await unhideAllCategories(); setHiddenCount(0); } },
                ]);
              }}
            >
              <FontAwesome name="eye" size={16} color={C.text} />
              <Text style={s.actionText}>  Unhide categories ({hiddenCount})</Text>
            </TouchableOpacity>
            <Text style={s.actionHint}>
              Restores categories you hid with a long-press.
            </Text>
          </>
        ) : null}

        <TouchableOpacity style={[s.actionBtn, s.signOutBtn]} onPress={handleSignOut}>
          <FontAwesome name="sign-out" size={16} color={C.danger} />
          <Text style={[s.actionText, { color: C.danger }]}>  Sign Out</Text>
        </TouchableOpacity>
        <Text style={s.actionHint}>
          Removes all playlists and cached data from this device.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  centered: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  container: { flexDirection: 'row', padding: 20, gap: 20 },
  pane: { flex: 1 },
  paneTitle: { color: C.blue, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },

  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  avatar: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: C.surface, borderWidth: 2, borderColor: C.accent,
    justifyContent: 'center', alignItems: 'center',
  },
  username: { color: C.text, fontSize: 19, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { fontSize: 12, fontWeight: '700' },

  card: {
    backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border,
    borderRadius: R.md,
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  rowLabel: { color: C.textMuted, fontSize: 13 },
  rowValue: { color: C.text, fontSize: 13, maxWidth: '65%' },

  actionBtn: {
    flexDirection: 'row',
    borderRadius: R.sm, padding: 13,
    alignItems: 'center', justifyContent: 'center',
  },
  secondaryBtn: {
    backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border,
    marginTop: 18,
  },
  signOutBtn: {
    backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.danger,
    marginTop: 18,
  },
  actionText: { color: C.text, fontSize: 15, fontWeight: '600' },
  actionHint: { color: C.textMuted, fontSize: 12, marginTop: 8, marginBottom: 4 },
});
