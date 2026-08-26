// PlaylistsScreen
// Manage saved playlists (Xtream Codes accounts): add, remove, and switch
// the active one. Switching wipes the local catalogue and re-syncs.
// Landscape layout: playlist list on the left, add-form on the right.

import { useState } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  ActivityIndicator, Alert, StyleSheet, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../context/AuthContext';
import xtreamApi from '../services/xtreamApi';
import { validateM3u } from '../services/m3u';
import { C, R, G } from '../theme';

export default function PlaylistsScreen() {
  const { playlists, activePlaylist, addPlaylist, removePlaylist, selectPlaylist } = useAuth();
  const [type, setType] = useState('xtream'); // 'xtream' | 'm3u'
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function handleAdd() {
    setSaving(true);
    try {
      if (type === 'm3u') {
        const trimmed = url.trim();
        if (!trimmed) {
          Alert.alert('Validation', 'Playlist URL is required');
          return;
        }
        await validateM3u(trimmed);
        await addPlaylist({ type: 'm3u', name, url: trimmed });
        setName(''); setUrl('');
        return;
      }

      const creds = { host: host.trim(), username: username.trim(), password };
      if (!creds.host || !creds.username || !creds.password) {
        Alert.alert('Validation', 'Host, username and password are required');
        return;
      }
      const previous = xtreamApi.getXtreamCreds();
      let account;
      try {
        // Validate against the provider before saving.
        xtreamApi.setXtreamCreds(creds);
        account = await xtreamApi.checkAccount();
      } finally {
        // Restore the active playlist's creds; addPlaylist re-primes if needed.
        if (previous.host) xtreamApi.setXtreamCreds({ host: previous.host, username: previous.username, password: previous.password });
        else xtreamApi.clearXtreamCreds();
      }
      if (!account?.ok) {
        Alert.alert(
          account?.expired ? 'Subscription expired' : 'Account not active',
          account?.message || 'This subscription is not active.'
        );
        return;
      }
      await addPlaylist({ type: 'xtream', name, ...creds });
      setName(''); setHost(''); setUsername(''); setPassword('');
    } catch (err) {
      Alert.alert('Connection failed', String(err.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  function handleSelect(item) {
    if (item.id === activePlaylist?.id) return;
    Alert.alert(
      'Switch playlist',
      `Switch to "${item.name}"? The cached catalogue will be cleared and re-synced.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Switch',
          onPress: async () => {
            setSwitching(true);
            try { await selectPlaylist(item.id); }
            finally { setSwitching(false); }
          },
        },
      ],
    );
  }

  function handleRemove(item) {
    Alert.alert(
      'Remove playlist',
      `Remove "${item.name}"?${item.id === activePlaylist?.id ? ' It is currently active — the catalogue will be cleared.' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => removePlaylist(item.id) },
      ],
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Left: saved playlists */}
      <View style={s.listPane}>
        <Text style={s.paneTitle}>Saved playlists</Text>
        {switching ? <ActivityIndicator color={C.accentSoft} style={{ marginVertical: 10 }} /> : null}
        <FlatList
          data={playlists}
          keyExtractor={(p) => p.id}
          ListEmptyComponent={<Text style={s.empty}>No playlists yet — add one on the right.</Text>}
          renderItem={({ item }) => {
            const active = item.id === activePlaylist?.id;
            return (
              <TouchableOpacity
                style={[s.row, active && s.rowActive]}
                onPress={() => handleSelect(item)}
              >
                <View style={[s.dot, { backgroundColor: active ? C.green : C.border }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowName} numberOfLines={1}>
                    {item.name}
                    <Text style={s.rowType}>  {item.type === 'm3u' ? 'M3U' : 'XTREAM'}</Text>
                  </Text>
                  <Text style={s.rowHost} numberOfLines={1}>{item.type === 'm3u' ? item.url : item.host}</Text>
                </View>
                {active ? <Text style={s.activeBadge}>ACTIVE</Text> : null}
                <TouchableOpacity style={s.trash} onPress={() => handleRemove(item)}>
                  <FontAwesome name="trash-o" size={18} color={C.danger} />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }}
          ItemSeparatorComponent={() => <View style={s.sep} />}
        />
      </View>

      {/* Right: add a playlist */}
      <ScrollView style={s.formPane} contentContainerStyle={{ padding: 18 }} keyboardShouldPersistTaps="handled">
        <Text style={s.paneTitle}>Add playlist</Text>
        <View style={s.typeRow}>
          {[['xtream', 'Xtream Codes'], ['m3u', 'M3U URL']].map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[s.typePill, type === key && s.typePillActive]}
              onPress={() => setType(key)}
            >
              <Text style={[s.typeText, type === key && s.typeTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          style={s.input} placeholder="Name (optional)" placeholderTextColor={C.textMuted}
          value={name} onChangeText={setName}
        />
        {type === 'xtream' ? (
          <>
            <TextInput
              style={s.input} placeholder="Host URL  e.g. https://example.com" placeholderTextColor={C.textMuted}
              autoCapitalize="none" autoCorrect={false} keyboardType="url"
              value={host} onChangeText={setHost}
            />
            <TextInput
              style={s.input} placeholder="Username" placeholderTextColor={C.textMuted}
              autoCapitalize="none" autoCorrect={false}
              value={username} onChangeText={setUsername}
            />
            <TextInput
              style={s.input} placeholder="Password" placeholderTextColor={C.textMuted}
              secureTextEntry value={password} onChangeText={setPassword}
            />
          </>
        ) : (
          <TextInput
            style={s.input} placeholder="Playlist URL  e.g. https://example.com/list.m3u" placeholderTextColor={C.textMuted}
            autoCapitalize="none" autoCorrect={false} keyboardType="url"
            value={url} onChangeText={setUrl}
          />
        )}
        {saving ? (
          <ActivityIndicator color={C.accentSoft} style={{ marginVertical: 12 }} />
        ) : (
          <TouchableOpacity onPress={handleAdd} activeOpacity={0.85}>
            <LinearGradient colors={G.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.addBtn}>
              <FontAwesome name="plus" size={14} color={C.text} />
              <Text style={s.addBtnText}>  Add playlist</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}
        <Text style={s.hint}>
          Credentials are validated against the provider before saving, and stored
          only on this device.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', backgroundColor: C.bg },

  listPane: { flex: 1.2, padding: 18, borderRightWidth: 1, borderRightColor: C.border },
  formPane: { flex: 1 },
  paneTitle: { color: C.blue, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  empty: { color: C.textMuted, marginTop: 8 },

  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: R.md, padding: 14,
    borderWidth: 1, borderColor: C.border,
  },
  rowActive: { borderColor: C.green },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  rowName: { color: C.text, fontSize: 15, fontWeight: '700' },
  rowType: { color: C.blue, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  rowHost: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  typePill: {
    flex: 1, alignItems: 'center', paddingVertical: 9,
    backgroundColor: C.surface, borderRadius: R.sm,
    borderWidth: 1, borderColor: C.border,
  },
  typePillActive: { backgroundColor: C.accent, borderColor: C.accent },
  typeText: { color: C.textSoft, fontSize: 12, fontWeight: '600' },
  typeTextActive: { color: C.text, fontWeight: '700' },
  activeBadge: { color: C.green, fontSize: 10, fontWeight: '800', letterSpacing: 1, marginRight: 10 },
  trash: { padding: 8 },
  sep: { height: 10 },

  input: {
    backgroundColor: C.surface, color: C.text,
    borderRadius: R.sm, padding: 12, fontSize: 15, marginBottom: 10,
    borderWidth: 1, borderColor: C.border,
  },
  addBtn: {
    flexDirection: 'row',
    padding: 13, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  addBtnText: { color: C.text, fontSize: 15, fontWeight: '700' },
  hint: { color: C.textMuted, fontSize: 12, marginTop: 14, lineHeight: 17 },
});
