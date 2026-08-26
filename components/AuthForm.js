// AuthForm
// Form for connecting to an IPTV provider: collects an optional playlist name
// plus the three Xtream Codes credentials (host URL, username, password).
//
// Props:
//   - title:        header text
//   - submitLabel:  primary button label
//   - loading:      shows ActivityIndicator instead of button
//   - includeName:  show the optional playlist-name field
//   - onSubmit({ name?, host, username, password }): called on press
//   - footer:       optional node rendered below the form

import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { C, R, G } from '../theme';

export default function AuthForm({
  title,
  submitLabel,
  loading,
  includeName = false,
  onSubmit,
  footer,
}) {
  const [type, setType] = useState('xtream'); // 'xtream' | 'm3u'
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');

  function handleSubmit() {
    const payload = type === 'm3u' ? { type, url } : { type, host, username, password };
    if (includeName) payload.name = name;
    onSubmit(payload);
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{title}</Text>

        {/* playlist type toggle */}
        <View style={styles.typeRow}>
          {[['xtream', 'Xtream Codes'], ['m3u', 'M3U URL']].map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[styles.typePill, type === key && styles.typePillActive]}
              onPress={() => setType(key)}
            >
              <Text style={[styles.typeText, type === key && styles.typeTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {includeName && (
          <TextInput
            style={styles.input}
            placeholder="Playlist name (optional)"
            placeholderTextColor={C.textMuted}
            value={name}
            onChangeText={setName}
          />
        )}

        {type === 'xtream' ? (
          <>
            <TextInput
              style={styles.input}
              placeholder="Host URL  e.g. https://example.com"
              placeholderTextColor={C.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={host}
              onChangeText={setHost}
            />
            <TextInput
              style={styles.input}
              placeholder="Username"
              placeholderTextColor={C.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              value={username}
              onChangeText={setUsername}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={C.textMuted}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
          </>
        ) : (
          <TextInput
            style={styles.input}
            placeholder="Playlist URL  e.g. https://example.com/list.m3u"
            placeholderTextColor={C.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={url}
            onChangeText={setUrl}
          />
        )}

        {loading ? (
          <ActivityIndicator color={C.accentSoft} style={{ marginVertical: 14 }} />
        ) : (
          <TouchableOpacity onPress={handleSubmit} activeOpacity={0.85}>
            <LinearGradient colors={G.button} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.button}>
              <Text style={styles.buttonText}>{submitLabel}</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}

        {footer}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 24, maxWidth: 560, width: '100%', alignSelf: 'center' },
  title: { fontSize: 32, fontWeight: 'bold', color: C.text, textAlign: 'center', marginBottom: 28 },
  section: { color: C.blue, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  typePill: {
    flex: 1, alignItems: 'center', paddingVertical: 10,
    backgroundColor: C.surface, borderRadius: R.sm,
    borderWidth: 1, borderColor: C.border,
  },
  typePillActive: { backgroundColor: C.accent, borderColor: C.accent },
  typeText: { color: C.textSoft, fontSize: 13, fontWeight: '600' },
  typeTextActive: { color: C.text, fontWeight: '700' },
  input: {
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: R.sm,
    padding: 14,
    fontSize: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  button: {
    padding: 14,
    borderRadius: R.sm,
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 12,
  },
  buttonText: { color: C.text, fontSize: 16, fontWeight: '700' },
});
