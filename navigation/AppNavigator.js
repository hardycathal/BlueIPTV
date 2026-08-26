// AppNavigator
// Auth-gated navigation tree for the IPTV app.
//
//   No playlists            -> LoginScreen (add first playlist)
//   Connected               -> MainTabs
//     Browse tab            -> BrowseStack
//        Sync               (initial, until catalogue is populated)
//        Home               (one-screen dashboard)
//        LiveTv / Movies / SeriesBrowse / Detail / Search / EpgGuide / Player
//     Playlists tab         -> PlaylistsScreen (add / remove / switch)
//     Profile tab           -> ProfileScreen
//
// The NavigationContainer is keyed on the active playlist id: switching
// playlists remounts the tree, which re-runs the sync-meta check and lands
// on the Sync screen (the catalogue was wiped by the switch).

import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import FontAwesome from '@expo/vector-icons/FontAwesome';

import { useAuth } from '../context/AuthContext';
import LoginScreen        from '../screens/LoginScreen';
import SyncScreen         from '../screens/SyncScreen';
import HomeScreen         from '../screens/HomeScreen';
import LiveTvScreen       from '../screens/LiveTvScreen';
import CatchUpScreen      from '../screens/CatchUpScreen';
import MoviesScreen       from '../screens/MoviesScreen';
import SeriesScreen       from '../screens/SeriesScreen';
import DetailScreen       from '../screens/DetailScreen';
import PlayerScreen       from '../screens/PlayerScreen';
import SearchScreen       from '../screens/SearchScreen';
import EpgGuideScreen     from '../screens/EpgGuideScreen';
import ProfileScreen      from '../screens/ProfileScreen';
import PlaylistsScreen    from '../screens/PlaylistsScreen';
import { initDb, getSyncMeta } from '../database/iptv';
import { C, TABBAR } from '../theme';

const AuthStack   = createNativeStackNavigator();
const Tab         = createBottomTabNavigator();
const BrowseStack = createNativeStackNavigator();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: C.accentSoft,
    background: C.bg,
    card: C.surface,
    border: C.border,
    text: C.text,
  },
};

const darkHeader = {
  headerStyle:        { backgroundColor: C.surface },
  headerTintColor:    C.text,
  headerShadowVisible: false,
  contentStyle:       { backgroundColor: C.bg },
};

function BrowseNavigator({ initialRoute }) {
  return (
    <BrowseStack.Navigator initialRouteName={initialRoute} screenOptions={darkHeader}>
      <BrowseStack.Screen name="Sync"         component={SyncScreen}         options={{ headerShown: false }} />
      <BrowseStack.Screen name="Home"         component={HomeScreen}         options={{ headerShown: false }} />
      <BrowseStack.Screen name="LiveTv"       component={LiveTvScreen}       options={{ headerShown: false }} />
      <BrowseStack.Screen name="CatchUp"      component={CatchUpScreen}      options={{ headerShown: false }} />
      <BrowseStack.Screen name="Movies"       component={MoviesScreen}       options={{ headerShown: false }} />
      <BrowseStack.Screen name="SeriesBrowse" component={SeriesScreen}       options={{ headerShown: false }} />
      <BrowseStack.Screen name="Detail"       component={DetailScreen} />
      <BrowseStack.Screen name="Search"       component={SearchScreen} />
      <BrowseStack.Screen name="EpgGuide"     component={EpgGuideScreen}     options={{ title: 'TV Guide' }} />
      <BrowseStack.Screen name="Player"       component={PlayerScreen}       options={{ title: 'Now Playing' }} />
    </BrowseStack.Navigator>
  );
}

function MainTabs({ initialBrowseRoute }) {
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarStyle: TABBAR,
        tabBarLabelStyle:        { fontSize: 11, fontWeight: '600' },
        tabBarLabelPosition:     'beside-icon',
        tabBarActiveTintColor:   C.accentSoft,
        tabBarInactiveTintColor: C.textMuted,
      }}
    >
      <Tab.Screen
        name="Browse"
        options={{
          headerShown: false,
          tabBarIcon: ({ color, size }) => <FontAwesome name="tv" size={15} color={color} />,
        }}
      >
        {() => <BrowseNavigator initialRoute={initialBrowseRoute} />}
      </Tab.Screen>
      <Tab.Screen
        name="Playlists"
        component={PlaylistsScreen}
        options={{
          title: 'Playlists',
          headerStyle:     { backgroundColor: C.surface },
          headerTintColor: C.text,
          headerShadowVisible: false,
          tabBarIcon: ({ color, size }) => <FontAwesome name="list" size={15} color={color} />,
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          title: 'Profile',
          headerStyle:     { backgroundColor: C.surface },
          headerTintColor: C.text,
          headerShadowVisible: false,
          tabBarIcon: ({ color, size }) => <FontAwesome name="user" size={15} color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
    </AuthStack.Navigator>
  );
}

export default function AppNavigator() {
  const { hasXtream, activePlaylist, loading } = useAuth();
  const [initialBrowseRoute, setInitialBrowseRoute] = useState(null);

  // Decide whether to land on the Sync screen (fresh device, post-logout, or
  // freshly switched playlist — all of which wiped the catalogue) or Home.
  useEffect(() => {
    if (!hasXtream) { setInitialBrowseRoute(null); return; }
    let cancelled = false;
    setInitialBrowseRoute(null);
    (async () => {
      try {
        await initDb();
        const synced = await getSyncMeta('last_full_sync_at');
        // Auto-refresh: re-sync silently when the catalogue is >3 days old,
        // so new channels/movies appear without a manual refresh.
        const STALE_MS = 3 * 24 * 60 * 60 * 1000;
        const stale = synced && Date.now() - Number(synced) > STALE_MS;
        if (!cancelled) setInitialBrowseRoute(synced && !stale ? 'Home' : 'Sync');
      } catch (e) {
        console.warn('initial route check failed', e);
        if (!cancelled) setInitialBrowseRoute('Sync');
      }
    })();
    return () => { cancelled = true; };
  }, [hasXtream, activePlaylist?.id]);

  if (loading || (hasXtream && !initialBrowseRoute)) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={C.accentSoft} />
      </View>
    );
  }

  return (
    <NavigationContainer key={activePlaylist?.id ?? 'no-playlist'} theme={navTheme}>
      {hasXtream
        ? <MainTabs initialBrowseRoute={initialBrowseRoute} />
        : <AuthNavigator />}
    </NavigationContainer>
  );
}
