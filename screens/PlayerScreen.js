// PlayerScreen
// VLC-backed fullscreen playback with an advanced overlay:
//   - icon controls, auto-hide after 4s
//   - tap-to-seek progress bar (VOD/episodes)
//   - audio track + subtitle track cycling (VLC text tracks)
//   - live quality variant switching, HLS -> TS fallback
//   - resume positions saved every ~5s (continue watching)
//
// route.params:
//   { kind: 'live',    streamId, title, liveVariants? }
//   { kind: 'vod',     streamId, container?, title }
//   { kind: 'episode', episodeId, container?, title }
//   { kind: 'catchup', streamId, start, durationMins, title }  (TV archive replay)

import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, StatusBar, Animated, ScrollView, AppState } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { LinearGradient } from 'expo-linear-gradient';
import { VLCPlayer } from 'react-native-vlc-media-player';
import { CastButton, useRemoteMediaClient } from 'react-native-google-cast';
import xtreamApi from '../services/xtreamApi';
import {
  saveProgress, getProgress,
  listMergedLiveByCategory, listMergedLiveChannels, listFavouriteLive,
  getSeasonsForSeries, getEpisodesForSeason,
} from '../database/iptv';
import { detectLiveQuality } from '../utils/liveVariants';
import { C, G, TABBAR } from '../theme';

// Local native module (modules/pip) — may be absent until the next prebuild.
let PipModule = null;
try {
  // eslint-disable-next-line global-require
  PipModule = require('expo-modules-core').requireNativeModule('Pip');
} catch { PipModule = null; }

const CONTROLS_TIMEOUT = 4000;

function secondsFromVlc(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 10000 ? n / 1000 : n;
}

// MIME type hint for the Chromecast receiver.
function castContentType(kind, container, liveFormat) {
  if (kind === 'live') return liveFormat === 'hls' ? 'application/x-mpegURL' : 'video/mp2t';
  if (kind === 'catchup') return 'video/mp2t';
  const ext = String(container || 'mp4').toLowerCase();
  if (ext === 'mkv') return 'video/x-matroska';
  if (ext === 'avi') return 'video/x-msvideo';
  return 'video/mp4';
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SLEEP_STEPS = [null, 15, 30, 60, 90]; // minutes

export default function PlayerScreen({ route, navigation }) {
  const {
    kind, streamId, episodeId, container, title, liveVariants = [], start, durationMins,
    liveCategoryId, seriesId, seriesName, season, episodeNum,
    directUrl, // M3U playlists play their entry URL directly (no Xtream creds)
  } = route.params;
  const [activeStreamId, setActiveStreamId] = useState(streamId);
  const [liveFormat, setLiveFormat] = useState('hls');
  const [error, setError] = useState(null);

  // tracks
  const [audioTracks, setAudioTracks] = useState([]);
  const [audioTrackId, setAudioTrackId] = useState(null);
  const [textTracks, setTextTracks] = useState([]);
  const [textTrackId, setTextTrackId] = useState(null); // null = player default, -1 = off
  const [subDelayMs, setSubDelayMs] = useState(0);      // subtitle sync offset
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);
  const menuX = useRef(new Animated.Value(320)).current;

  // transport
  const [controlsVisible, setControlsVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [seek, setSeek] = useState(undefined);
  const [toast, setToast] = useState(null);

  // hold-to-2x (TikTok/YouTube style) — non-live streams only
  const [rate, setRate] = useState(1);
  const [speedLocked, setSpeedLocked] = useState(false);
  const holdTimer = useRef(null);
  const holdEngaged = useRef(false);
  const speedZoneH = useRef(1);

  // channel zapping (live): the ordered channel list of the source category
  const [zapChannels, setZapChannels] = useState([]);
  const [currentChannel, setCurrentChannel] = useState(null); // { name, variants } after a zap
  const [activeDirectUrl, setActiveDirectUrl] = useState(directUrl ?? null);
  const zapZoneStartY = useRef(0);

  // live auto-reconnect
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const reconnectAttempts = useRef(0);

  // sleep timer
  const [sleepIdx, setSleepIdx] = useState(0);
  const sleepTimer = useRef(null);

  // resume prompt (vod/episode) + next-episode autoplay
  const [resumePrompt, setResumePrompt] = useState(null); // { position, duration }
  const [nextEp, setNextEp] = useState(null);             // { ep, secondsLeft }
  const nextEpTimer = useRef(null);

  // picture-in-picture: Android reports a PiP window as "backgrounded", so we
  // keep the player alive across app-state changes and decide ourselves
  // whether to pause (Home press = pause, PiP = keep playing).
  const pipRequested = useRef(false);
  const [inPip, setInPip] = useState(false);

  const castClient = useRemoteMediaClient(); // non-null while a cast session is active
  const didFallbackToTs = useRef(false);
  const progressKey = useRef(null);
  const controlsTimer = useRef(null);
  const toastTimer = useRef(null);
  const barWidth = useRef(1);
  const lastProgressUiUpdate = useRef(0);
  const lastProgressSave = useRef(0);

  const sourceUrl = useMemo(() => {
    try {
      if (kind === 'live') {
        if (activeDirectUrl) return activeDirectUrl; // m3u channel
        return xtreamApi.liveStreamUrl(activeStreamId, { hls: liveFormat === 'hls' });
      }
      if (activeDirectUrl) return activeDirectUrl; // m3u vod
      if (kind === 'vod') return xtreamApi.vodStreamUrl(streamId, container || 'mp4');
      if (kind === 'episode') return xtreamApi.episodeStreamUrl(episodeId, container || 'mp4');
      if (kind === 'catchup') return xtreamApi.timeshiftUrl(streamId, start, durationMins || 60);
    } catch (e) {
      return null;
    }
    return null;
  }, [kind, activeStreamId, streamId, episodeId, container, liveFormat, start, durationMins, activeDirectUrl]);

  const displayTitle = currentChannel?.name ?? title;

  const qualityVariants = useMemo(() => {
    if (kind !== 'live') return [];
    const source = currentChannel?.variants?.length ? currentChannel.variants : liveVariants;
    const variants = Array.isArray(source) && source.length
      ? source
      : [{ stream_id: streamId, name: displayTitle || 'Live', ...detectLiveQuality(displayTitle) }];

    return variants
      .map((variant) => {
        const quality = variant.quality
          ? { label: variant.quality, rank: Number(variant.qualityRank || 0) }
          : detectLiveQuality(variant.name);
        return {
          stream_id: String(variant.stream_id),
          name: variant.name || title || 'Live',
          quality: quality.label,
          qualityRank: quality.rank,
          direct_url: variant.direct_url || null,
        };
      })
      .filter((variant) => variant.stream_id)
      .sort((a, b) => a.qualityRank - b.qualityRank || a.name.localeCompare(b.name));
  }, [kind, liveVariants, streamId, displayTitle, currentChannel]);

  const currentQualityIndex = useMemo(() => (
    qualityVariants.findIndex((variant) => String(variant.stream_id) === String(activeStreamId))
  ), [qualityVariants, activeStreamId]);
  const currentQuality = currentQualityIndex >= 0 ? qualityVariants[currentQualityIndex] : null;

  // header hidden — this screen draws its own chrome; the bottom tab bar is
  // hidden too so playback is truly fullscreen, and restored on exit.
  useEffect(() => {
    navigation.setOptions({ headerShown: false });
    StatusBar.setHidden(true, 'fade');
    const tabNav = navigation.getParent();
    tabNav?.setOptions({ tabBarStyle: { display: 'none' } });
    return () => {
      StatusBar.setHidden(false, 'fade');
      tabNav?.setOptions({ tabBarStyle: TABBAR });
    };
  }, [navigation]);

  // Load the zap list (ordered channels of the category the user came from).
  useEffect(() => {
    if (kind !== 'live') return;
    let cancelled = false;
    const fetch = liveCategoryId === '__favourites__'
      ? listFavouriteLive()
      : liveCategoryId != null
        ? listMergedLiveByCategory(liveCategoryId, 2000, 0)
        : listMergedLiveChannels(2000, 0);
    fetch.then((rows) => { if (!cancelled) setZapChannels(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [kind, liveCategoryId]);

  function zap(delta) {
    if (kind !== 'live' || zapChannels.length < 2) return;
    const currentId = String(currentChannel?.stream_id ?? streamId);
    let idx = zapChannels.findIndex((c) =>
      String(c.stream_id) === currentId ||
      (c.variants || []).some((v) => String(v.stream_id) === String(activeStreamId)));
    if (idx < 0) idx = 0;
    const next = zapChannels[(idx + delta + zapChannels.length) % zapChannels.length];
    didFallbackToTs.current = false;
    reconnectAttempts.current = 0;
    setLiveFormat('hls');
    setError(null);
    setCurrentChannel(next);
    setActiveStreamId(next.stream_id);
    setActiveDirectUrl(next.direct_url ?? null);
    showToast(next.name);
  }

  // sleep timer
  useEffect(() => {
    if (sleepTimer.current) clearTimeout(sleepTimer.current);
    const mins = SLEEP_STEPS[sleepIdx];
    if (!mins) return undefined;
    sleepTimer.current = setTimeout(() => {
      setPaused(true);
      setSleepIdx(0);
      showToast('Sleep timer — playback paused');
    }, mins * 60 * 1000);
    return () => { if (sleepTimer.current) clearTimeout(sleepTimer.current); };
  }, [sleepIdx]);

  function cycleSleep() {
    const nextIdx = (sleepIdx + 1) % SLEEP_STEPS.length;
    setSleepIdx(nextIdx);
    const mins = SLEEP_STEPS[nextIdx];
    showToast(mins ? `Sleep timer: ${mins} min` : 'Sleep timer off');
  }

  // next-episode countdown
  useEffect(() => {
    if (!nextEp) { if (nextEpTimer.current) clearInterval(nextEpTimer.current); return undefined; }
    nextEpTimer.current = setInterval(() => {
      setNextEp((cur) => {
        if (!cur) return cur;
        if (cur.secondsLeft <= 1) {
          clearInterval(nextEpTimer.current);
          playNextEpisode(cur.ep);
          return null;
        }
        return { ...cur, secondsLeft: cur.secondsLeft - 1 };
      });
    }, 1000);
    return () => { if (nextEpTimer.current) clearInterval(nextEpTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextEp?.ep?.episode_id]);

  function playNextEpisode(ep) {
    navigation.replace('Player', {
      kind: 'episode',
      episodeId: ep.episode_id,
      container: ep.container_extension || 'mp4',
      title: `${seriesName} S${ep.season_number} E${ep.episode_num}`,
      seriesId,
      seriesName,
      season: ep.season_number,
      episodeNum: ep.episode_num,
    });
  }

  // Find the episode `delta` steps away (+1 next / -1 previous), crossing
  // season boundaries in either direction.
  async function findAdjacentEpisode(delta) {
    if (kind !== 'episode' || !seriesId) return null;
    const eps = await getEpisodesForSeason(seriesId, season);
    const idx = eps.findIndex((e) => Number(e.episode_num) === Number(episodeNum));
    let target = idx >= 0 ? eps[idx + delta] : null;
    if (!target) {
      const seasons = await getSeasonsForSeries(seriesId);
      const sIdx = seasons.findIndex((sn) => Number(sn.season_number) === Number(season));
      const adjSeason = sIdx >= 0 ? seasons[sIdx + delta] : null;
      if (adjSeason) {
        const adjEps = await getEpisodesForSeason(seriesId, adjSeason.season_number);
        target = delta > 0 ? adjEps[0] : adjEps[adjEps.length - 1];
      }
    }
    return target || null;
  }

  async function goEpisode(delta) {
    try {
      const target = await findAdjacentEpisode(delta);
      if (target) playNextEpisode(target);
      else showToast(delta > 0 ? 'No next episode' : 'No previous episode');
    } catch { /* ignore */ }
  }

  async function handleEnded() {
    if (kind !== 'episode' || !seriesId) return;
    try {
      const next = await findAdjacentEpisode(1);
      if (next) {
        setControlsVisible(true);
        setNextEp({ ep: next, secondsLeft: 10 });
      }
    } catch { /* no autoplay if lookup fails */ }
  }

  // When a cast session connects, hand the stream to the Chromecast and
  // pause local playback. Casting continues if the user leaves this screen.
  useEffect(() => {
    if (!castClient || !sourceUrl) return;
    castClient.loadMedia({
      mediaInfo: {
        contentUrl: sourceUrl,
        contentType: castContentType(kind, container, liveFormat),
        streamType: kind === 'live' ? 'live' : 'buffered',
        metadata: { type: kind === 'live' ? 'tvShow' : 'movie', title: title || 'IPTV' },
      },
    }).then(() => {
      setPaused(true);
      showToast('Casting to TV');
    }).catch(() => showToast('Cast failed — this stream format may not be supported by Chromecast'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castClient, sourceUrl]);

  // Pause when the app is genuinely backgrounded (Home / app switcher), but
  // not when we deliberately entered picture-in-picture.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && !pipRequested.current) {
        setPaused(true);
      }
      if (state === 'active') {
        pipRequested.current = false;
        setInPip(false);
      }
    });
    return () => sub.remove();
  }, []);

  // The play/pause button inside the PiP window is a system control; taps
  // arrive from the native module as an event.
  useEffect(() => {
    let sub = null;
    try {
      if (typeof PipModule?.addListener === 'function') {
        sub = PipModule.addListener('onPipAction', () => setPaused((p) => !p));
      }
    } catch (e) {
      sub = null; // event support missing — PiP still works, just no control
    }
    return () => {
      try { sub?.remove?.(); } catch (e) { /* noop */ }
      try { PipModule?.cleanup?.(); } catch (e) { /* noop */ }
    };
  }, []);

  // Keep the PiP icon in sync with the actual play state.
  useEffect(() => {
    if (!inPip) return;
    try {
      const r = PipModule?.updatePipActions?.(!paused);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* not in PiP any more */ }
  }, [paused, inPip]);

  // slide/fade the track menu from the right
  useEffect(() => {
    Animated.timing(menuX, {
      toValue: trackMenuOpen ? 0 : 320,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [trackMenuOpen, menuX]);

  // auto-hide controls
  useEffect(() => {
    if (!controlsVisible || paused) return undefined;
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_TIMEOUT);
    return () => { if (controlsTimer.current) clearTimeout(controlsTimer.current); };
  }, [controlsVisible, paused]);

  // reset state on source change
  useEffect(() => {
    didFallbackToTs.current = false;
    setActiveStreamId(streamId);
    setLiveFormat('hls');
    setError(null);
    setAudioTracks([]); setAudioTrackId(null);
    setTextTracks([]); setTextTrackId(null);
    setSubDelayMs(0);
    setTrackMenuOpen(false);
    setControlsVisible(true);
    setPaused(false); setMuted(false); setVolume(100);
    setCurrentTime(0); setDuration(0);
    setImmersive(false);
    setSeek(undefined);
    setRate(1); setSpeedLocked(false);
    holdEngaged.current = false;
    setCurrentChannel(null);
    setActiveDirectUrl(directUrl ?? null);
    setResumePrompt(null);
    setNextEp(null);
    reconnectAttempts.current = 0;
    lastProgressUiUpdate.current = 0;
    lastProgressSave.current = 0;
  }, [kind, streamId, episodeId]);

  // offer to resume (vod/episodes only) — playback starts from the beginning
  // and a card lets the user jump to their saved position
  useEffect(() => {
    if (kind !== 'vod' && kind !== 'episode') { progressKey.current = null; return; }
    const itemId = kind === 'vod' ? streamId : episodeId;
    progressKey.current = { type: kind, id: itemId };
    let cancelled = false;
    (async () => {
      const progress = await getProgress(kind, itemId);
      if (!cancelled && progress?.position_seconds > 5 && progress?.duration_seconds > 0) {
        setResumePrompt({ position: progress.position_seconds, duration: progress.duration_seconds });
      }
    })();
    return () => { cancelled = true; };
  }, [kind, streamId, episodeId]);

  function acceptResume() {
    if (!resumePrompt) return;
    setSeek(Math.min(0.98, resumePrompt.position / resumePrompt.duration));
    setCurrentTime(resumePrompt.position);
    setResumePrompt(null);
  }

  function showToast(message) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }

  function handleLoad(info = {}) {
    const audio = Array.isArray(info.audioTracks) ? info.audioTracks.filter((t) => Number(t.id) >= 0) : [];
    const text = Array.isArray(info.textTracks) ? info.textTracks.filter((t) => Number(t.id) >= 0) : [];
    setAudioTracks(audio);
    setTextTracks(text);
    setBuffering(false);
    setError(null);
  }

  function handleProgress(progress = {}) {
    const nextCurrentTime = secondsFromVlc(progress.currentTime);
    const nextDuration = secondsFromVlc(progress.duration);
    const now = Date.now();
    if (now - lastProgressUiUpdate.current > 500) {
      lastProgressUiUpdate.current = now;
      setCurrentTime(nextCurrentTime);
      if (nextDuration > 0) setDuration(nextDuration);
      // progress events mean playback is advancing — clear a stale
      // buffering badge (VLC doesn't always emit a "done buffering" event)
      setBuffering(false);
    }
    if ((kind === 'vod' || kind === 'episode') && nextCurrentTime > 0 && progressKey.current && now - lastProgressSave.current > 5000) {
      lastProgressSave.current = now;
      saveProgress(progressKey.current.type, progressKey.current.id, nextCurrentTime, nextDuration).catch(() => {});
    }
  }

  function handleError(err = {}) {
    const message = err?.message || err?.error || 'This stream could not be played.';
    if (kind === 'live' && liveFormat === 'hls' && !didFallbackToTs.current) {
      didFallbackToTs.current = true;
      showToast('Trying alternate stream format…');
      setLiveFormat('ts');
      return;
    }
    // live streams drop all the time — retry a couple of times before
    // surfacing the error to the user
    if (kind === 'live' && reconnectAttempts.current < 2) {
      reconnectAttempts.current += 1;
      showToast(`Reconnecting… (${reconnectAttempts.current}/2)`);
      setTimeout(() => setReconnectNonce((n) => n + 1), 1500);
      return;
    }
    setError(String(message));
  }

  function pickSubtitle(id) {
    setTextTrackId(id);
    if (id === -1) showToast('Subtitles: off');
    else {
      const track = textTracks.find((t) => Number(t.id) === Number(id));
      showToast(`Subtitles: ${track?.name || id}`);
    }
  }

  function pickAudio(id) {
    setAudioTrackId(Number(id));
    const track = audioTracks.find((t) => Number(t.id) === Number(id));
    showToast(`Audio: ${track?.name || id}`);
  }

  // ---- hold-to-2x gesture (right half of the video, controls hidden) ----
  function speedHoldIn() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdEngaged.current = true;
      setRate(2);
    }, 300);
  }

  function speedHoldOut(e) {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (!holdEngaged.current) {
      // short tap — behave like a normal video tap
      if (trackMenuOpen) setTrackMenuOpen(false);
      else setControlsVisible((v) => !v);
      return;
    }
    holdEngaged.current = false;
    const y = e?.nativeEvent?.locationY ?? 0;
    if (y > speedZoneH.current / 2) {
      // released on the bottom half — stay at 2x
      setSpeedLocked(true);
      showToast('2x locked — tap the badge to reset');
    } else {
      // released on the top half — back to normal
      setRate(1);
      setSpeedLocked(false);
    }
  }

  function resetSpeed() {
    setRate(1);
    setSpeedLocked(false);
    showToast('Speed: 1x');
  }

  function seekBy(seconds) {
    if (kind === 'live' || duration <= 0) return;
    const nextTime = Math.max(0, Math.min(duration - 1, currentTime + seconds));
    setSeek(nextTime / duration);
    setCurrentTime(nextTime);
    setControlsVisible(true);
  }

  function seekToFraction(fraction) {
    if (kind === 'live' || duration <= 0) return;
    const f = Math.max(0, Math.min(0.99, fraction));
    setSeek(f);
    setCurrentTime(f * duration);
    setControlsVisible(true);
  }

  function setVolumeBy(delta) {
    const nextVolume = Math.max(0, Math.min(100, volume + delta));
    setVolume(nextVolume);
    setMuted(nextVolume === 0);
    showToast(`Volume ${nextVolume}`);
    setControlsVisible(true);
  }

  function switchQuality(delta) {
    if (qualityVariants.length < 2) return;
    const idx = currentQualityIndex >= 0 ? currentQualityIndex : 0;
    const nextIndex = Math.max(0, Math.min(qualityVariants.length - 1, idx + delta));
    const next = qualityVariants[nextIndex];
    if (!next || String(next.stream_id) === String(activeStreamId)) return;
    didFallbackToTs.current = false;
    setLiveFormat('hls');
    setError(null);
    setActiveStreamId(next.stream_id);
    if (next.direct_url) setActiveDirectUrl(next.direct_url);
    showToast(`Quality: ${next.quality || 'Auto'}`);
    setControlsVisible(true);
  }

  if (Platform.OS === 'web') {
    return (
      <View style={s.center}>
        <Text style={s.error}>VLC playback is only available in native Android/iOS builds.</Text>
      </View>
    );
  }

  if (!sourceUrl) {
    return (
      <View style={s.center}>
        <Text style={s.error}>Could not build stream URL. Are your Xtream credentials set?</Text>
      </View>
    );
  }

  const playerKey = `${kind}:${activeStreamId || streamId || episodeId}:${liveFormat}:${reconnectNonce}`;
  const effectiveVolume = muted ? 0 : volume;
  const progressFraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const playerProps = {
    style: s.video,
    source: { uri: sourceUrl },
    autoplay: true,
    paused,
    volume: effectiveVolume,
    repeat: kind === 'live',
    resizeMode: 'contain',
    autoAspectRatio: true,
    // must stay true or VLC stops the moment the activity backgrounds, which
    // includes entering PiP; our AppState handler above does the pausing
    playInBackground: true,
    seek,
    onLoad: handleLoad,
    onProgress: handleProgress,
    onBuffering: () => setBuffering(true),
    onPlaying: () => { setBuffering(false); reconnectAttempts.current = 0; },
    onEnded: handleEnded,
    onError: handleError,
  };
  if (audioTrackId !== null) playerProps.audioTrack = audioTrackId;
  // null = leave VLC's default subtitle behaviour; -1 = force off; >=0 = pick
  if (textTrackId !== null) playerProps.textTrack = Number(textTrackId);
  playerProps.rate = rate;
  playerProps.subtitleDelay = subDelayMs;

  return (
    <View style={s.container}>
      <TouchableOpacity
        style={s.videoWrap}
        activeOpacity={1}
        onPress={() => {
          if (trackMenuOpen) { setTrackMenuOpen(false); return; }
          setControlsVisible((v) => !v);
        }}
      >
        <VLCPlayer key={playerKey} {...playerProps} />

        {/* channel-zap zone: left half while controls are hidden — swipe
            up/down to flick through the category's channels (live only) */}
        {kind === 'live' && !controlsVisible ? (
          <View
            style={s.zapZone}
            onStartShouldSetResponder={() => true}
            onResponderGrant={(e) => { zapZoneStartY.current = e.nativeEvent.pageY; }}
            onResponderRelease={(e) => {
              const dy = e.nativeEvent.pageY - zapZoneStartY.current;
              if (Math.abs(dy) > 50) zap(dy < 0 ? 1 : -1);
              else if (trackMenuOpen) setTrackMenuOpen(false);
              else setControlsVisible((v) => !v);
            }}
          />
        ) : null}

        {/* hold-to-2x zone: right half, only while controls are hidden so it
            never blocks the overlay buttons; live streams can't fast-forward */}
        {kind !== 'live' && !controlsVisible ? (
          <View
            style={s.speedZone}
            onLayout={(e) => { speedZoneH.current = e.nativeEvent.layout.height || 1; }}
            onStartShouldSetResponder={() => true}
            onResponderGrant={speedHoldIn}
            onResponderRelease={speedHoldOut}
            onResponderTerminate={speedHoldOut}
          />
        ) : null}

        {/* 2x badge */}
        {rate > 1 ? (
          <TouchableOpacity style={s.speedBadge} onPress={resetSpeed}>
            <Text style={s.speedBadgeText}>2x ▶▶{speedLocked ? '  ·  tap to reset' : ''}</Text>
          </TouchableOpacity>
        ) : null}

        {/* resume card */}
        {resumePrompt ? (
          <View style={s.resumeCard}>
            <TouchableOpacity style={s.resumeBtn} onPress={acceptResume}>
              <FontAwesome name="play" size={12} color={C.text} />
              <Text style={s.resumeText}>  Resume from {formatTime(resumePrompt.position)}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.resumeDismiss} onPress={() => setResumePrompt(null)}>
              <Text style={s.resumeDismissText}>Start over</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* next-episode card */}
        {nextEp ? (
          <View style={s.nextEpCard}>
            <Text style={s.nextEpTitle} numberOfLines={1}>
              Up next: S{nextEp.ep.season_number} E{nextEp.ep.episode_num}
              {nextEp.ep.title ? ` — ${nextEp.ep.title}` : ''}
            </Text>
            <View style={s.nextEpRow}>
              <TouchableOpacity style={s.resumeBtn} onPress={() => { setNextEp(null); playNextEpisode(nextEp.ep); }}>
                <FontAwesome name="play" size={12} color={C.text} />
                <Text style={s.resumeText}>  Play now ({nextEp.secondsLeft})</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.resumeDismiss} onPress={() => setNextEp(null)}>
                <Text style={s.resumeDismissText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* toast */}
        {toast ? (
          <View style={s.toast} pointerEvents="none">
            <Text style={s.toastText}>{toast}</Text>
          </View>
        ) : null}

        {buffering && !error ? (
          <View style={s.bufferBadge} pointerEvents="none">
            <Text style={s.bufferText}>Buffering…</Text>
          </View>
        ) : null}

        {controlsVisible ? (
          <View style={s.controls}>
            {/* Top bar */}
            <LinearGradient colors={G.playerTop} style={s.topBar}>
              <TouchableOpacity style={s.iconBtn} onPress={() => navigation.goBack()}>
                <FontAwesome name="chevron-left" size={16} color={C.text} />
              </TouchableOpacity>
              <Text style={s.nowPlaying} numberOfLines={1}>{displayTitle || 'Now Playing'}</Text>
              <TouchableOpacity
                style={s.iconBtn}
                onPress={async () => {
                  if (!PipModule?.enterPip) { showToast('Picture-in-picture needs a rebuild'); return; }
                  try {
                    setControlsVisible(false);
                    setPaused(false);          // make sure it's playing when it shrinks
                    pipRequested.current = true;
                    const ok = await PipModule.enterPip(true);
                    if (ok) {
                      setInPip(true);
                    } else {
                      pipRequested.current = false;
                      showToast('Picture-in-picture is not available on this device');
                    }
                  } catch (e) {
                    pipRequested.current = false;
                    showToast('Picture-in-picture failed');
                  }
                }}
              >
                <FontAwesome name="clone" size={13} color={C.text} />
              </TouchableOpacity>
              <View style={{ width: 8 }} />
              <CastButton style={s.castBtn} tintColor="#FFFFFF" />
              {kind === 'live' ? (
                <View style={s.liveBadge}>
                  <View style={s.liveDot} />
                  <Text style={s.liveBadgeText}>LIVE{currentQuality?.quality ? ` · ${currentQuality.quality}` : ''}</Text>
                </View>
              ) : null}
              {kind === 'catchup' ? (
                <View style={s.liveBadge}>
                  <FontAwesome name="history" size={10} color={C.green} />
                  <Text style={s.liveBadgeText}>CATCH-UP</Text>
                </View>
              ) : null}
            </LinearGradient>

            {/* Channel up/down (live) */}
            {kind === 'live' && zapChannels.length > 1 ? (
              <View style={s.zapButtons}>
                <TouchableOpacity style={s.zapBtn} onPress={() => zap(1)}>
                  <FontAwesome name="chevron-up" size={16} color={C.text} />
                </TouchableOpacity>
                <Text style={s.zapLabel}>CH</Text>
                <TouchableOpacity style={s.zapBtn} onPress={() => zap(-1)}>
                  <FontAwesome name="chevron-down" size={16} color={C.text} />
                </TouchableOpacity>
              </View>
            ) : null}

            {/* Center transport */}
            <View style={s.centerControls}>
              {kind === 'episode' && seriesId ? (
                <TouchableOpacity style={s.skipBtn} onPress={() => goEpisode(-1)}>
                  <FontAwesome name="step-backward" size={20} color={C.text} />
                </TouchableOpacity>
              ) : null}
              {kind !== 'live' ? (
                <TouchableOpacity style={s.skipBtn} onPress={() => seekBy(-15)}>
                  <FontAwesome name="rotate-left" size={22} color={C.text} />
                  <Text style={s.skipText}>15</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={s.playBtn} onPress={() => setPaused((v) => !v)}>
                <FontAwesome name={paused ? 'play' : 'pause'} size={26} color={C.text} style={paused ? { marginLeft: 4 } : null} />
              </TouchableOpacity>
              {kind !== 'live' ? (
                <TouchableOpacity style={s.skipBtn} onPress={() => seekBy(30)}>
                  <FontAwesome name="rotate-right" size={22} color={C.text} />
                  <Text style={s.skipText}>30</Text>
                </TouchableOpacity>
              ) : null}
              {kind === 'episode' && seriesId ? (
                <TouchableOpacity style={s.skipBtn} onPress={() => goEpisode(1)}>
                  <FontAwesome name="step-forward" size={20} color={C.text} />
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Bottom bar */}
            <LinearGradient colors={G.playerBottom} style={s.bottomBar}>
              {kind !== 'live' ? (
                <View style={s.progressRow}>
                  <Text style={s.timeText}>{formatTime(currentTime)}</Text>
                  <TouchableOpacity
                    activeOpacity={1}
                    style={s.barTouch}
                    onLayout={(e) => { barWidth.current = e.nativeEvent.layout.width || 1; }}
                    onPress={(e) => seekToFraction(e.nativeEvent.locationX / barWidth.current)}
                  >
                    <View style={s.barTrack}>
                      <View style={[s.barFill, { width: `${progressFraction * 100}%` }]} />
                      <View style={[s.barThumb, { left: `${progressFraction * 100}%` }]} />
                    </View>
                  </TouchableOpacity>
                  <Text style={s.timeText}>{formatTime(duration)}</Text>
                </View>
              ) : null}

              <View style={s.bottomButtons}>
                <TouchableOpacity style={s.iconBtn} onPress={() => { setMuted((v) => !v); showToast(muted ? 'Unmuted' : 'Muted'); }}>
                  <FontAwesome name={muted ? 'volume-off' : 'volume-up'} size={16} color={C.text} />
                </TouchableOpacity>
                <TouchableOpacity style={s.iconBtn} onPress={() => setVolumeBy(-10)}>
                  <FontAwesome name="minus" size={13} color={C.text} />
                </TouchableOpacity>
                <Text style={s.volText}>{muted ? 0 : volume}</Text>
                <TouchableOpacity style={s.iconBtn} onPress={() => setVolumeBy(10)}>
                  <FontAwesome name="plus" size={13} color={C.text} />
                </TouchableOpacity>

                <View style={s.spacer} />

                <TouchableOpacity
                  style={[s.pillBtn, SLEEP_STEPS[sleepIdx] && s.pillBtnActive]}
                  onPress={cycleSleep}
                >
                  <FontAwesome name="moon-o" size={13} color={C.text} />
                  <Text style={s.pillText}>  {SLEEP_STEPS[sleepIdx] ? `${SLEEP_STEPS[sleepIdx]}m` : 'Sleep'}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[s.pillBtn, (textTrackId !== null && textTrackId !== -1) && s.pillBtnActive]}
                  onPress={() => setTrackMenuOpen((v) => !v)}
                >
                  <FontAwesome name="cc" size={13} color={C.text} />
                  <Text style={s.pillText}>  Tracks</Text>
                </TouchableOpacity>
                {kind === 'live' && qualityVariants.length > 1 ? (
                  <>
                    <TouchableOpacity
                      style={[s.iconBtn, currentQualityIndex <= 0 && s.disabled]}
                      disabled={currentQualityIndex <= 0}
                      onPress={() => switchQuality(-1)}
                    >
                      <FontAwesome name="angle-down" size={16} color={C.text} />
                    </TouchableOpacity>
                    <Text style={s.volText}>{currentQuality?.quality || 'Auto'}</Text>
                    <TouchableOpacity
                      style={[s.iconBtn, currentQualityIndex >= qualityVariants.length - 1 && s.disabled]}
                      disabled={currentQualityIndex >= qualityVariants.length - 1}
                      onPress={() => switchQuality(1)}
                    >
                      <FontAwesome name="angle-up" size={16} color={C.text} />
                    </TouchableOpacity>
                  </>
                ) : null}
              </View>
            </LinearGradient>
          </View>
        ) : null}

        {/* Track menu — opaque panel sliding in from the right */}
        <Animated.View
          pointerEvents={trackMenuOpen ? 'auto' : 'none'}
          style={[
            s.trackMenu,
            {
              transform: [{ translateX: menuX }],
              opacity: menuX.interpolate({ inputRange: [0, 320], outputRange: [1, 0] }),
            },
          ]}
        >
          <View style={s.trackMenuHeader}>
            <Text style={s.trackMenuTitle}>Tracks</Text>
            <TouchableOpacity style={s.trackMenuClose} onPress={() => setTrackMenuOpen(false)}>
              <FontAwesome name="times" size={15} color={C.textSoft} />
            </TouchableOpacity>
          </View>
          <ScrollView>
            <Text style={s.trackSection}>Subtitles</Text>
            <TouchableOpacity
              style={[s.trackRow, (textTrackId === -1) && s.trackRowActive]}
              onPress={() => pickSubtitle(-1)}
            >
              <Text style={s.trackRowText}>Off</Text>
              {textTrackId === -1 ? <FontAwesome name="check" size={13} color={C.accentSoft} /> : null}
            </TouchableOpacity>
            {textTracks.map((t) => {
              const active = Number(textTrackId) === Number(t.id);
              return (
                <TouchableOpacity
                  key={`t${t.id}`}
                  style={[s.trackRow, active && s.trackRowActive]}
                  onPress={() => pickSubtitle(Number(t.id))}
                >
                  <Text style={s.trackRowText} numberOfLines={1}>{t.name || `Track ${t.id}`}</Text>
                  {active ? <FontAwesome name="check" size={13} color={C.accentSoft} /> : null}
                </TouchableOpacity>
              );
            })}
            {!textTracks.length ? (
              <Text style={s.trackEmpty}>No subtitle tracks in this stream.</Text>
            ) : null}

            {/* Sync controls stay available even when no track is detected —
                some streams expose subtitles only once playback starts. */}
            {(
              <View style={s.syncBox} key="subsync">
                <Text style={s.syncHint}>Subtitles out of sync? Nudge them:</Text>
                <View style={s.syncRow}>
                  <TouchableOpacity style={s.syncBtn} onPress={() => setSubDelayMs((v) => v - 500)}>
                    <FontAwesome name="backward" size={11} color={C.text} />
                    <Text style={s.syncBtnText}>  −0.5s</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSubDelayMs(0)} disabled={subDelayMs === 0}>
                    <Text style={[s.syncValue, subDelayMs !== 0 && { color: C.accentSoft }]}>
                      {subDelayMs === 0 ? 'In sync' : `${subDelayMs > 0 ? '+' : ''}${(subDelayMs / 1000).toFixed(1)}s`}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.syncBtn} onPress={() => setSubDelayMs((v) => v + 500)}>
                    <Text style={s.syncBtnText}>+0.5s  </Text>
                    <FontAwesome name="forward" size={11} color={C.text} />
                  </TouchableOpacity>
                </View>
                {subDelayMs !== 0 ? <Text style={s.syncReset}>Tap the value to reset</Text> : null}
              </View>
            )}

            {audioTracks.length > 1 ? (
              <>
                <Text style={[s.trackSection, { marginTop: 14 }]}>Audio</Text>
                {audioTracks.map((t) => {
                  const active = Number(audioTrackId) === Number(t.id);
                  return (
                    <TouchableOpacity
                      key={`a${t.id}`}
                      style={[s.trackRow, active && s.trackRowActive]}
                      onPress={() => pickAudio(t.id)}
                    >
                      <Text style={s.trackRowText} numberOfLines={1}>{t.name || `Track ${t.id}`}</Text>
                      {active ? <FontAwesome name="check" size={13} color={C.accentSoft} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </>
            ) : null}
          </ScrollView>
        </Animated.View>
      </TouchableOpacity>

      {error ? (
        <View style={s.errorBar}>
          <Text style={s.error}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => { setError(null); didFallbackToTs.current = false; setLiveFormat('hls'); }}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  videoWrap: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1, width: '100%' },
  center: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 24 },

  controls: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },

  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 22,
  },
  nowPlaying: { flex: 1, color: C.text, fontSize: 15, fontWeight: '700', marginHorizontal: 10 },
  castBtn: { width: 34, height: 34, marginRight: 8 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(46,139,87,0.25)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.green },
  liveBadgeText: { color: C.green, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },

  centerControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 34 },
  playBtn: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: 'rgba(139,31,168,0.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  skipBtn: { alignItems: 'center', justifyContent: 'center', width: 50, height: 50 },
  skipText: { position: 'absolute', color: C.text, fontSize: 8, fontWeight: '800', top: 21 },

  bottomBar: {
    paddingHorizontal: 14, paddingTop: 22, paddingBottom: 10,
  },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  barTouch: { flex: 1, height: 28, justifyContent: 'center' },
  barTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(184,205,232,0.25)' },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: C.accentSoft, borderRadius: 2 },
  barThumb: {
    position: 'absolute', top: -4, width: 12, height: 12,
    marginLeft: -6, borderRadius: 6, backgroundColor: C.text,
  },
  timeText: { color: C.textSoft, fontSize: 11, fontWeight: '600', minWidth: 44, textAlign: 'center' },

  bottomButtons: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: {
    width: 36, height: 32, borderRadius: 6,
    backgroundColor: 'rgba(184,205,232,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  pillBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(184,205,232,0.14)',
    borderRadius: 6, paddingHorizontal: 12, height: 32,
  },
  pillBtnActive: { backgroundColor: 'rgba(139,31,168,0.6)' },
  pillText: { color: C.text, fontSize: 12, fontWeight: '700' },
  volText: { color: C.text, minWidth: 30, textAlign: 'center', fontSize: 12, fontWeight: '700' },
  spacer: { flex: 1 },
  disabled: { opacity: 0.35 },

  speedZone: { position: 'absolute', top: 0, bottom: 0, right: 0, width: '45%' },
  zapZone: { position: 'absolute', top: 0, bottom: 0, left: 0, width: '45%' },
  zapButtons: {
    position: 'absolute', left: 14, top: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center', gap: 6,
  },
  zapBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(184,205,232,0.16)',
    alignItems: 'center', justifyContent: 'center',
  },
  zapLabel: { color: C.textSoft, fontSize: 9, fontWeight: '800', letterSpacing: 1 },

  resumeCard: {
    position: 'absolute', bottom: 96, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(16,26,48,0.92)', borderRadius: 10,
    borderWidth: 1, borderColor: C.border, padding: 10,
  },
  resumeBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.accent, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  resumeText: { color: C.text, fontSize: 13, fontWeight: '700' },
  resumeDismiss: { paddingHorizontal: 10, paddingVertical: 8 },
  resumeDismissText: { color: C.textSoft, fontSize: 13, fontWeight: '600' },
  nextEpCard: {
    position: 'absolute', bottom: 96, right: 14,
    backgroundColor: 'rgba(16,26,48,0.94)', borderRadius: 10,
    borderWidth: 1, borderColor: C.border, padding: 12, maxWidth: 340,
  },
  nextEpTitle: { color: C.text, fontSize: 13, fontWeight: '700', marginBottom: 10 },
  nextEpRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  speedBadge: {
    position: 'absolute', top: 14, alignSelf: 'center',
    backgroundColor: 'rgba(139,31,168,0.9)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  speedBadgeText: { color: C.text, fontSize: 12, fontWeight: '800' },

  toast: {
    position: 'absolute', top: 64, alignSelf: 'center',
    backgroundColor: 'rgba(16,26,48,0.9)', borderRadius: 8,
    paddingHorizontal: 16, paddingVertical: 8,
    borderWidth: 1, borderColor: C.border,
  },
  toastText: { color: C.text, fontSize: 13, fontWeight: '600' },
  bufferBadge: {
    position: 'absolute', bottom: 90, alignSelf: 'center',
    backgroundColor: 'rgba(16,26,48,0.8)', borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  bufferText: { color: C.textSoft, fontSize: 12 },

  trackMenu: {
    position: 'absolute', top: 0, bottom: 0, right: 0,
    width: 300,
    backgroundColor: C.surface, // fully opaque by design
    borderLeftWidth: 1, borderLeftColor: C.border,
    paddingBottom: 8,
  },
  trackMenuHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: 16, paddingRight: 8, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  trackMenuTitle: { color: C.text, fontSize: 15, fontWeight: '800' },
  trackMenuClose: { padding: 8 },
  trackSection: {
    color: C.blue, fontSize: 10, fontWeight: '800', textTransform: 'uppercase',
    letterSpacing: 1.2, paddingHorizontal: 16, marginTop: 12, marginBottom: 4,
  },
  trackRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 11, paddingHorizontal: 16,
  },
  trackRowActive: { backgroundColor: C.surface2 },
  trackRowText: { color: C.textSoft, fontSize: 13, flex: 1, marginRight: 10 },
  trackEmpty: { color: C.textMuted, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 },

  syncBox: {
    marginTop: 10, marginHorizontal: 12, padding: 12,
    backgroundColor: C.surface2, borderRadius: 8,
    borderWidth: 1, borderColor: C.border,
  },
  syncHint: { color: C.textSoft, fontSize: 12, marginBottom: 10 },
  syncRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  syncBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.accent, borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  syncBtnText: { color: C.text, fontSize: 12, fontWeight: '700' },
  syncValue: { color: C.textMuted, fontSize: 12, fontWeight: '800', minWidth: 56, textAlign: 'center' },
  syncReset: { color: C.textMuted, fontSize: 10, marginTop: 8, textAlign: 'center' },

  errorBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1a0f14', paddingHorizontal: 12 },
  error: { flex: 1, color: C.danger, padding: 8, fontSize: 12 },
  retryBtn: { backgroundColor: C.accent, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 6 },
  retryText: { color: C.text, fontWeight: '700', fontSize: 12 },
});
