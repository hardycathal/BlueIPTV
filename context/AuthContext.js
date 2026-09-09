// AuthContext
// Manages a list of saved playlists (Xtream Codes accounts) with one active
// at a time. The device talks directly to the active playlist's provider.
//
// Persistence (expo-secure-store, never plain AsyncStorage):
//   playlists_v1       -> JSON array [{ id, name, host, username, password }]
//   active_playlist_v1 -> id of the active playlist
//
// Switching the active playlist wipes the local SQLite catalogue (resetDb)
// so the next screen the navigator shows is the Sync screen for the new
// provider. AppNavigator remounts its tree on activeId change.
//
// useAuth returns: {
//   playlists, activePlaylist, xtream, hasXtream, loading,
//   addPlaylist(p, { makeActive }), removePlaylist(id),
//   selectPlaylist(id), logout()
// }

import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

import xtreamApi from '../services/xtreamApi';
import { resetDb } from '../database/iptv';

const PLAYLISTS_KEY = 'playlists_v1';
const ACTIVE_KEY = 'active_playlist_v1';
// Keys from older builds, migrated/cleared on boot.
const LEGACY_XTREAM_KEY = 'xtream_creds';
const LEGACY_KEYS = ['auth_token', 'account_info'];

const AuthContext = createContext(null);

function makeId() {
  return `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nameFromHost(host) {
  try {
    return String(host).replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || 'My playlist';
  } catch {
    return 'My playlist';
  }
}

export function AuthProvider({ children }) {
  const [playlists, setPlaylists] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function bootstrap() {
      try {
        let list = [];
        let active = null;

        const storedList = await SecureStore.getItemAsync(PLAYLISTS_KEY);
        if (storedList) list = JSON.parse(storedList) || [];
        const storedActive = await SecureStore.getItemAsync(ACTIVE_KEY);
        if (storedActive) active = storedActive;

        // Migrate a single-creds install from the previous build.
        if (!list.length) {
          const legacy = await SecureStore.getItemAsync(LEGACY_XTREAM_KEY);
          if (legacy) {
            const creds = JSON.parse(legacy);
            const migrated = { id: makeId(), name: nameFromHost(creds.host), ...creds };
            list = [migrated];
            active = migrated.id;
            await SecureStore.setItemAsync(PLAYLISTS_KEY, JSON.stringify(list));
            await SecureStore.setItemAsync(ACTIVE_KEY, active);
            await SecureStore.deleteItemAsync(LEGACY_XTREAM_KEY);
          }
        }
        for (const key of LEGACY_KEYS) {
          SecureStore.deleteItemAsync(key).catch(() => {});
        }

        if (active && !list.some((p) => p.id === active)) active = list[0]?.id ?? null;

        const activePl = list.find((p) => p.id === active);
        xtreamApi.setDemoMode(activePl?.type === 'demo');
        if (activePl && activePl.type !== 'm3u' && activePl.type !== 'demo') {
          xtreamApi.setXtreamCreds(activePl);
        }

        setPlaylists(list);
        setActiveId(active);
      } catch (e) {
        console.warn('Failed to restore playlists:', e);
      } finally {
        setLoading(false);
      }
    }
    bootstrap();
  }, []);

  async function persist(list, active) {
    await SecureStore.setItemAsync(PLAYLISTS_KEY, JSON.stringify(list));
    if (active) await SecureStore.setItemAsync(ACTIVE_KEY, active);
    else await SecureStore.deleteItemAsync(ACTIVE_KEY);
  }

  async function activate(playlist) {
    await resetDb().catch((e) => console.warn('resetDb failed', e));
    xtreamApi.setDemoMode(playlist?.type === 'demo');
    if (playlist && playlist.type !== 'm3u' && playlist.type !== 'demo') {
      xtreamApi.setXtreamCreds(playlist);
    } else {
      xtreamApi.clearXtreamCreds();
    }
  }

  // Add a playlist. Caller should have validated it first (xtreamApi.authPing
  // for Xtream, validateM3u for M3U).
  //   Xtream: { type?: 'xtream', name?, host, username, password }
  //   M3U:    { type: 'm3u', name?, url }
  async function addPlaylist(p, { makeActive = false } = {}) {
    const playlist = p.type === 'demo'
      ? {
          id: makeId(),
          type: 'demo',
          name: (p.name || '').trim() || 'Demo catalogue',
        }
      : p.type === 'm3u'
      ? {
          id: makeId(),
          type: 'm3u',
          name: (p.name || '').trim() || nameFromHost(p.url),
          url: p.url,
        }
      : {
          id: makeId(),
          type: 'xtream',
          name: (p.name || '').trim() || nameFromHost(p.host),
          host: p.host,
          username: p.username,
          password: p.password,
        };
    const list = [...playlists, playlist];
    const becomesActive = makeActive || !activeId;
    const nextActive = becomesActive ? playlist.id : activeId;

    if (becomesActive) await activate(playlist);
    await persist(list, nextActive);
    setPlaylists(list);
    setActiveId(nextActive);
    return playlist;
  }

  async function removePlaylist(id) {
    const list = playlists.filter((p) => p.id !== id);
    let nextActive = activeId;
    if (id === activeId) {
      nextActive = list[0]?.id ?? null;
      await activate(list[0] ?? null);
    }
    await persist(list, nextActive);
    setPlaylists(list);
    setActiveId(nextActive);
  }

  async function selectPlaylist(id) {
    if (id === activeId) return;
    const playlist = playlists.find((p) => p.id === id);
    if (!playlist) return;
    await activate(playlist);
    await persist(playlists, id);
    setActiveId(id);
  }

  // Removes everything: all playlists, creds, and the local catalogue.
  async function logout() {
    await SecureStore.deleteItemAsync(PLAYLISTS_KEY);
    await SecureStore.deleteItemAsync(ACTIVE_KEY);
    xtreamApi.setDemoMode(false);
    xtreamApi.clearXtreamCreds();
    setPlaylists([]);
    setActiveId(null);
    try { await resetDb(); } catch (e) { console.warn('resetDb failed', e); }
  }

  const activePlaylist = playlists.find((p) => p.id === activeId) ?? null;

  return (
    <AuthContext.Provider
      value={{
        playlists,
        activePlaylist,
        xtream: activePlaylist, // back-compat: { host, username, password }
        hasXtream: !!activePlaylist,
        loading,
        addPlaylist,
        removePlaylist,
        selectPlaylist,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
