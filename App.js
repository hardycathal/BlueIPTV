// App
// Application entry point. Wraps the tree in AuthProvider so the navigator
// can decide which stack to show based on auth state.
//
// Also configures the global audio session on boot:
//   - playsInSilentMode: true  -> ignore iOS ringer switch (default behaviour
//     mutes media when the side switch is off, which is wrong for a video app)
//   - interruptionMode: 'duckOthers' -> if a phone call or other audio plays,
//     duck the video volume instead of pausing.

import { useEffect } from 'react';
import { Platform } from 'react-native';
import { enableScreens } from 'react-native-screens';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { setAudioModeAsync, setIsAudioActiveAsync } from 'expo-audio';
import { AuthProvider } from './context/AuthContext';
import AppNavigator from './navigation/AppNavigator';

enableScreens();

export default function App() {
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    (async () => {
      try {
        await setIsAudioActiveAsync(true);
        await setAudioModeAsync({
          playsInSilentMode: true,
          interruptionMode: 'doNotMix',
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
          allowsRecording: false,
        });
      } catch (e) {
        console.warn('audio setup failed', e);
      }
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AppNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
