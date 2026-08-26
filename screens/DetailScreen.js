// DetailScreen
// Landscape layout: poster on the left, details + actions on the right.
//   - kind: 'vod'    -> calls ensureVodInfo, shows a "Play" button
//   - kind: 'series' -> calls ensureSeriesInfo, lists seasons → episodes
//
// route.params: { kind: 'vod'|'series', id: string, title: string }

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Image, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet,
} from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import {
  getVod, getSeries, getSeasonsForSeries, getEpisodesForSeason,
} from '../database/iptv';
import { ensureVodInfo, ensureSeriesInfo } from '../services/catalogueSync';
import { C, R } from '../theme';

export default function DetailScreen({ route, navigation }) {
  const { kind, id, title } = route.params;
  useEffect(() => navigation.setOptions({ title }), [title, navigation]);

  if (kind === 'vod') return <VodDetail navigation={navigation} streamId={id} />;
  if (kind === 'series') return <SeriesDetail navigation={navigation} seriesId={id} />;
  return null;
}

function Poster({ uri }) {
  if (!uri) return <View style={[s.poster, s.posterEmpty]}><FontAwesome name="film" size={40} color={C.textMuted} /></View>;
  return <Image source={{ uri }} style={s.poster} resizeMode="cover" />;
}

// -----------------------------------------------------------------------
// VOD detail
// -----------------------------------------------------------------------
function VodDetail({ navigation, streamId }) {
  const [vod, setVod] = useState(null);
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await getVod(streamId);
        if (!cancelled) setVod(row);
        const i = await ensureVodInfo(streamId);
        if (!cancelled) setInfo(i?.info || i || null);
      } catch (e) { if (!cancelled) setErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [streamId]);

  if (err)  return <View style={s.center}><Text style={s.err}>{err}</Text></View>;
  if (!vod) return <View style={s.center}><ActivityIndicator color={C.accentSoft} /></View>;

  const poster = info?.movie_image || info?.cover_big || vod.stream_icon;
  const plot   = info?.plot || info?.description || '';
  const rating = info?.rating || vod.rating;
  const year   = info?.releasedate || info?.releaseDate || info?.year;
  const cast   = info?.cast || info?.actors;
  const dur    = info?.duration || info?.duration_secs;

  return (
    <View style={s.splitRow}>
      <View style={s.posterPane}>
        <Poster uri={poster} />
      </View>

      <ScrollView style={s.infoPane} contentContainerStyle={{ padding: 18 }}>
        <Text style={s.h1}>{vod.name}</Text>
        <Text style={s.meta}>
          {rating ? `★ ${Number(rating).toFixed(1)}   ` : ''}
          {year ? `${year}   ` : ''}
          {dur ? `${dur}` : ''}
        </Text>
        <TouchableOpacity
          style={s.playBtn}
          onPress={() =>
            navigation.navigate('Player', {
              kind: 'vod',
              streamId: vod.stream_id,
              container: vod.container_extension || 'mp4',
              title: vod.name,
              directUrl: vod.direct_url || null,
            })
          }
        >
          <FontAwesome name="play" size={14} color={C.text} />
          <Text style={s.playText}>  Play</Text>
        </TouchableOpacity>
        {cast ? <Text style={s.cast}>Cast: {String(cast)}</Text> : null}
        {plot ? <Text style={s.plot}>{plot}</Text> : null}
      </ScrollView>
    </View>
  );
}

// -----------------------------------------------------------------------
// Series detail
// -----------------------------------------------------------------------
function SeriesDetail({ navigation, seriesId }) {
  const [series, setSeries] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [episodes, setEpisodes] = useState([]);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const row = await getSeries(seriesId);
      setSeries(row);
      await ensureSeriesInfo(seriesId);
      const ss = await getSeasonsForSeries(seriesId);
      setSeasons(ss);
      if (ss.length) {
        setSelectedSeason(ss[0].season_number);
        setEpisodes(await getEpisodesForSeason(seriesId, ss[0].season_number));
      }
    } catch (e) { setErr(e.message); }
  }, [seriesId]);

  useEffect(() => { load(); }, [load]);

  async function pickSeason(n) {
    setSelectedSeason(n);
    setEpisodes(await getEpisodesForSeason(seriesId, n));
  }

  if (err) return <View style={s.center}><Text style={s.err}>{err}</Text></View>;
  if (!series) return <View style={s.center}><ActivityIndicator color={C.accentSoft} /></View>;

  return (
    <View style={s.splitRow}>
      <View style={s.posterPane}>
        <Poster uri={series.cover} />
        <Text style={s.h1small}>{series.name}</Text>
        <Text style={s.meta}>
          {series.rating ? `★ ${Number(series.rating).toFixed(1)}   ` : ''}
          {series.release_date || ''}
        </Text>
      </View>

      <ScrollView style={s.infoPane} contentContainerStyle={{ padding: 18 }}>
        {series.plot ? <Text style={s.plot}>{series.plot}</Text> : null}
        {series.cast ? <Text style={s.cast}>Cast: {series.cast}</Text> : null}

        <Text style={[s.h2, { marginTop: 16 }]}>Seasons</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          {seasons.map((sn) => (
            <TouchableOpacity
              key={sn.season_number}
              style={[s.seasonPill, selectedSeason === sn.season_number && s.seasonPillActive]}
              onPress={() => pickSeason(sn.season_number)}
            >
              <Text style={s.seasonText}>S{sn.season_number}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <Text style={[s.h2, { marginTop: 16 }]}>Episodes</Text>
        {episodes.map((ep) => (
          <TouchableOpacity
            key={ep.episode_id}
            style={s.epRow}
            onPress={() =>
              navigation.navigate('Player', {
                kind: 'episode',
                episodeId: ep.episode_id,
                container: ep.container_extension || 'mp4',
                title: `${series.name} S${ep.season_number} E${ep.episode_num}`,
                seriesId,
                seriesName: series.name,
                season: ep.season_number,
                episodeNum: ep.episode_num,
              })
            }
          >
            <Text style={s.epNum}>{ep.episode_num}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.epTitle}>{ep.title || `Episode ${ep.episode_num}`}</Text>
              {ep.plot ? <Text style={s.epPlot} numberOfLines={2}>{ep.plot}</Text> : null}
            </View>
            <FontAwesome name="play-circle-o" size={20} color={C.accentSoft} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  center:    { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' },
  err:       { color: C.danger, padding: 16 },

  splitRow:  { flex: 1, flexDirection: 'row', backgroundColor: C.bg },
  posterPane:{ width: 170, padding: 16, alignItems: 'center' },
  infoPane:  { flex: 1, borderLeftWidth: 1, borderLeftColor: C.border },

  poster:    { width: 138, height: 196, borderRadius: R.md, backgroundColor: C.surface },
  posterEmpty:{ alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },

  h1:        { color: C.text, fontSize: 22, fontWeight: '700' },
  h1small:   { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 12, textAlign: 'center' },
  h2:        { color: C.blue, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  meta:      { color: C.textSoft, marginTop: 6 },
  cast:      { color: C.textMuted, marginTop: 10, fontStyle: 'italic' },
  plot:      { color: C.textSoft, marginTop: 6, lineHeight: 20 },

  playBtn:   {
    flexDirection: 'row', alignSelf: 'flex-start',
    backgroundColor: C.accent,
    paddingVertical: 10, paddingHorizontal: 26, borderRadius: R.sm,
    alignItems: 'center', justifyContent: 'center', marginTop: 12,
  },
  playText:  { color: C.text, fontWeight: '700', fontSize: 16 },

  seasonPill:       { padding: 10, paddingHorizontal: 16, backgroundColor: C.surface, borderRadius: 999, marginRight: 8, borderWidth: 1, borderColor: C.border },
  seasonPillActive: { backgroundColor: C.accent, borderColor: C.accent },
  seasonText:       { color: C.text, fontWeight: '600' },

  epRow:     { flexDirection: 'row', alignItems: 'center', padding: 12, marginTop: 8, backgroundColor: C.surface, borderRadius: R.md, borderWidth: 1, borderColor: C.border },
  epNum:     { color: C.blue, width: 30, fontSize: 14, fontWeight: '700' },
  epTitle:   { color: C.text, fontSize: 14 },
  epPlot:    { color: C.textMuted, fontSize: 12, marginTop: 4 },
});
