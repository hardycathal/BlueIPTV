// LoginScreen
// First-run screen: adds the user's first playlist. Validates the Xtream
// creds directly against the provider's player_api.php (authPing), then
// saves the playlist via AuthContext.addPlaylist. More playlists can be
// added later from the Playlists tab.

import { useState } from 'react';
import { Alert } from 'react-native';
import AuthForm from '../components/AuthForm';
import xtreamApi from '../services/xtreamApi';
import { validateM3u } from '../services/m3u';
import { useAuth } from '../context/AuthContext';

export default function LoginScreen() {
  const { addPlaylist } = useAuth();
  const [loading, setLoading] = useState(false);

  async function handleConnect({ type, name, host, username, password, url }) {
    setLoading(true);
    try {
      if (type === 'm3u') {
        const trimmed = (url || '').trim();
        if (!trimmed) {
          Alert.alert('Validation', 'Playlist URL is required');
          return;
        }
        await validateM3u(trimmed);
        await addPlaylist({ type: 'm3u', name, url: trimmed }, { makeActive: true });
        return;
      }

      const creds = {
        host: (host || '').trim(),
        username: (username || '').trim(),
        password,
      };
      if (!creds.host || !creds.username || !creds.password) {
        Alert.alert('Validation', 'Host, username and password are required');
        return;
      }
      // Prime the client, then confirm the provider accepts the creds AND
      // that the subscription is actually usable before saving anything.
      xtreamApi.setXtreamCreds(creds);
      const account = await xtreamApi.checkAccount();
      if (!account.ok) {
        xtreamApi.clearXtreamCreds();
        Alert.alert(
          account.expired ? 'Subscription expired' : 'Account not active',
          account.message
        );
        return;
      }
      await addPlaylist({ type: 'xtream', name, ...creds }, { makeActive: true });
      if (account.daysLeft != null && account.daysLeft <= 7) {
        Alert.alert(
          'Subscription ending soon',
          `This subscription expires in ${account.daysLeft} day${account.daysLeft === 1 ? '' : 's'}.`
        );
      }
    } catch (err) {
      xtreamApi.clearXtreamCreds();
      Alert.alert('Connection failed', String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthForm
      title="IPTV"
      submitLabel="Connect"
      loading={loading}
      includeName
      onSubmit={handleConnect}
    />
  );
}
