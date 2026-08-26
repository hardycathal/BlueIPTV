// SearchBar
// Compact search input that fits the slim section headers. Debounces input
// and calls onQuery with the trimmed text ('' when cleared / too short).

import { useEffect, useRef, useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { C, R } from '../theme';

/**
 * clearSignal: change this value (e.g. increment a counter) to clear the box
 * from the parent — used when picking a category should cancel the search.
 */
export default function SearchBar({ placeholder = 'Search…', onQuery, minChars = 2, style, clearSignal = 0 }) {
  const [text, setText] = useState('');
  const timer = useRef(null);
  const firstSignal = useRef(clearSignal);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const t = text.trim();
      onQuery(t.length >= minChars ? t : '');
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [text]);

  useEffect(() => {
    if (clearSignal === firstSignal.current) return; // ignore initial mount
    firstSignal.current = clearSignal;
    setText('');
  }, [clearSignal]);

  return (
    <View style={[s.wrap, style]}>
      <FontAwesome name="search" size={12} color={C.textMuted} />
      <TextInput
        style={s.input}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={C.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      {text ? (
        <TouchableOpacity onPress={() => setText('')} style={s.clear}>
          <FontAwesome name="times-circle" size={13} color={C.textMuted} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: R.sm, paddingHorizontal: 8, height: 26, minWidth: 170,
  },
  input: { flex: 1, color: C.text, fontSize: 12, paddingVertical: 0, marginLeft: 6 },
  clear: { padding: 2 },
});
