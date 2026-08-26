// SyncScreen
// Runs the full Xtream catalogue sync with live progress, then goes to Home.
// Reached on first run, after switching playlists (catalogue wiped), or via
// "Refresh catalogue" on the Profile screen.

import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { runFullSync } from '../services/catalogueSync';
import { useAuth } from '../context/AuthContext';
import { C, R, G } from '../theme';

export default function SyncScreen({ navigation }) {
  const { activePlaylist } = useAuth();
  const [progress, setProgress] = useState({ percent: 0, label: 'Starting…' });
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null);

  async function doSync() {
    setError(null);
    setErrorCode(null);
    setProgress({ percent: 0, label: 'Starting…' });
    try {
      await runFullSync(({ label, percent }) => setProgress({ label, percent }), activePlaylist);
      navigation.replace('Home');
    } catch (e) {
      setError(e?.message || 'Sync failed');
      setErrorCode(e?.code || null);
    }
  }

  const subscriptionProblem = errorCode === 'EXPIRED' || errorCode === 'INACTIVE';

  useEffect(() => { doSync(); /* eslint-disable-next-line */ }, []);

  return (
    <View style={styles.container}>
      <View style={styles.inner}>
        <Text style={styles.title}>Loading your catalogue</Text>
        <Text style={styles.subtitle}>Downloading channels, movies and series from your provider.</Text>

        <View style={styles.progressTrack}>
          <LinearGradient
            colors={G.button}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={[styles.progressFill, { width: `${Math.max(2, progress.percent)}%` }]}
          />
        </View>
        <Text style={styles.percent}>{progress.percent}%</Text>
        <Text style={styles.label}>{progress.label}</Text>

        {error ? (
          <>
            {subscriptionProblem ? (
              <Text style={styles.errorTitle}>
                {errorCode === 'EXPIRED' ? 'Subscription expired' : 'Account not active'}
              </Text>
            ) : null}
            <Text style={styles.error}>{error}</Text>
            {subscriptionProblem ? (
              <TouchableOpacity
                style={styles.button}
                onPress={() => navigation.getParent()?.navigate('Playlists')}
              >
                <Text style={styles.buttonText}>Manage playlists</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.button, subscriptionProblem && styles.secondaryButton]}
              onPress={doSync}
            >
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
          </>
        ) : (
          <ActivityIndicator color={C.accentSoft} style={{ marginTop: 20 }} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center', padding: 24 },
  inner: { width: '100%', maxWidth: 560 },
  title: { fontSize: 24, color: C.text, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: C.textSoft, textAlign: 'center', marginTop: 8, marginBottom: 32 },
  progressTrack: { height: 8, backgroundColor: C.surface, borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  progressFill: { height: 8, borderRadius: 4 },
  percent: { color: C.text, textAlign: 'center', marginTop: 12, fontSize: 16, fontWeight: '600' },
  label: { color: C.textSoft, textAlign: 'center', marginTop: 4 },
  errorTitle: { color: C.text, fontSize: 17, fontWeight: '700', textAlign: 'center', marginTop: 24 },
  error: { color: C.danger, textAlign: 'center', marginTop: 10, lineHeight: 19 },
  secondaryButton: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, marginTop: 10 },
  button: { marginTop: 16, padding: 14, backgroundColor: C.accent, borderRadius: R.sm, alignItems: 'center' },
  buttonText: { color: C.text, fontWeight: '700' },
});
