import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Place } from '@/models/types';
import { api } from './api';
import { color } from './theme';
import { Badge, Field, Muted } from './ui';

const label = (p: Place) => `${p.name}${p.state ? `, ${p.state}` : ''}`;

/** Search the shared list of states and cities, and pick one place or several. */
export function PlacePicker({ title, value, onChange, multiple = false, allow, disabled = false }: {
  title: string;
  value: Place[];
  onChange: (places: Place[]) => void;
  multiple?: boolean;
  /** Limit the search to states or to cities. */
  allow?: 'state' | 'city';
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<Place[]>([]);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) { setResults([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<Place[]>('/locations', { query: { q, limit: 8, type: allow }, signal: ctl.signal })
        .then((r) => setResults(r.filter((p) => !value.some((v) => v.id === p.id))))
        .catch(() => undefined);
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [text, allow, value]);

  const pick = (p: Place) => {
    onChange(multiple ? [...value, p] : [p]);
    setText('');
    setResults([]);
  };

  return (
    <View style={{ gap: 8 }}>
      <Muted>{title}</Muted>
      {value.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {value.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`Remove ${p.name}`} disabled={disabled} onPress={() => onChange(value.filter((v) => v.id !== p.id))}>
              <Badge tone="brand">{`${label(p)}${disabled ? '' : '  ✕'}`}</Badge>
            </Pressable>
          ))}
        </View>
      )}
      {!disabled && (multiple || value.length === 0) && (
        <>
          <Field label="" value={text} onChangeText={setText} placeholder="Type a city or state" autoCorrect={false} />
          {results.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" onPress={() => pick(p)} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: color.line }}>
              <Text style={{ color: color.ink, fontWeight: '600' }}>{p.name}</Text>
              <Muted>{p.state ?? p.type ?? ''}</Muted>
            </Pressable>
          ))}
        </>
      )}
    </View>
  );
}
