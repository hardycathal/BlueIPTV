import { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, Image, StyleSheet, ActivityIndicator } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { searchAcross } from '../database/iptv';
import { C, R } from '../theme';

const TYPES = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'vod', label: 'Movies' },
  { key: 'series', label: 'Series' },
];

export default function SearchScreen({ navigation }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);

  useEffect(() => {
    navigation.setOptions({ title: 'Search' });
  }, [navigation]);

  const trimmed = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (trimmed.length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const types = type === 'all' ? ['live', 'vod', 'series'] : [type];
        const grouped = await Promise.all(types.map((t) => searchAcross(trimmed, t, type === 'all' ? 40 : 100)));
        if (!cancelled) setResults(grouped.flat());
      } catch (e) {
        console.warn('search failed', e);
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, type]);

  function openResult(item) {
    if (item.type === 'live') {
      navigation.navigate('Player', { kind: 'live', streamId: item.id, title: item.name });
    } else if (item.type === 'vod') {
      navigation.navigate('Detail', { kind: 'vod', id: item.id, title: item.name });
    } else if (item.type === 'series') {
      navigation.navigate('Detail', { kind: 'series', id: item.id, title: item.name });
    }
  }

  function iconFor(item) {
    if (item.type === 'live') return 'tv';
    if (item.type === 'vod') return 'film';
    return 'list-alt';
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <FontAwesome name="search" size={16} color={C.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search channels, movies, series"
          placeholderTextColor={C.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')} style={styles.clearButton}>
            <FontAwesome name="times" size={16} color={C.textSoft} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.filters}>
        {TYPES.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setType(t.key)}
            style={[styles.filter, type === t.key && styles.filterActive]}
          >
            <Text style={[styles.filterText, type === t.key && styles.filterTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? <ActivityIndicator color={C.accentSoft} style={styles.loader} /> : null}

      <FlatList
        data={results}
        keyExtractor={(item) => `${item.type}:${item.id}`}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={!loading ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.empty}>{trimmed.length < 2 ? 'Type at least 2 characters.' : 'No matches found.'}</Text>
          </View>
        ) : null}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => openResult(item)}>
            {item.image ? (
              <Image source={{ uri: item.image }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbFallback]}>
                <FontAwesome name={iconFor(item)} size={22} color={C.textMuted} />
              </View>
            )}
            <View style={styles.rowTextWrap}>
              <Text style={styles.title} numberOfLines={2}>{item.name}</Text>
              <Text style={styles.meta}>{item.type === 'vod' ? 'Movie' : item.type === 'live' ? 'Live TV' : 'Series'}</Text>
            </View>
            <FontAwesome name="chevron-right" size={14} color={C.textMuted} />
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  searchRow: {
    margin: 12,
    minHeight: 46,
    borderRadius: R.sm,
    paddingHorizontal: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: { flex: 1, color: C.text, fontSize: 16, marginLeft: 10 },
  clearButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  filters: { flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 10, gap: 8 },
  filter: { paddingHorizontal: 12, height: 34, borderRadius: R.sm, justifyContent: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  filterActive: { backgroundColor: C.accent, borderColor: C.accent },
  filterText: { color: C.textSoft, fontWeight: '700' },
  filterTextActive: { color: C.text },
  loader: { paddingVertical: 10 },
  row: { minHeight: 74, padding: 12, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center' },
  thumb: { width: 50, height: 50, borderRadius: R.sm, backgroundColor: C.surface2, marginRight: 12 },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  rowTextWrap: { flex: 1, paddingRight: 12 },
  title: { color: C.text, fontSize: 15, fontWeight: '600' },
  meta: { color: C.textMuted, marginTop: 4, fontSize: 12 },
  sep: { height: 1, backgroundColor: C.border },
  emptyWrap: { padding: 24, alignItems: 'center' },
  empty: { color: C.textMuted },
});
