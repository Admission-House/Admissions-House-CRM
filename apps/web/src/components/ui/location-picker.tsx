'use client';

import { MapPin, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Input, cx } from '@/components/ui';
import { api } from '@/lib/api';

export interface Place {
  id: string;
  name: string;
  type: 'state' | 'city';
  state?: string | null;
}

const label = (p: Place) => (p.type === 'city' && p.state ? `${p.name}, ${p.state}` : p.type === 'state' ? `${p.name} (state)` : p.name);

/** A search box over the shared list of states and cities. Choosing sets one place or, with `multiple`, adds to a list. */
export function LocationPicker({
  id, value, onChange, multiple, placeholder = 'Search a city or state', allow,
}: {
  id?: string;
  value: Place[];
  onChange: (places: Place[]) => void;
  multiple?: boolean;
  placeholder?: string;
  /** Limit the search to one kind of place. */
  allow?: 'state' | 'city';
}) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<Place[]>('/locations', { query: { q, limit: 12, type: allow }, signal: ctl.signal })
        .then((r) => setResults(r.filter((p) => !value.some((v) => v.id === p.id))))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, allow, value]);

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (p: Place) => {
    onChange(multiple ? [...value, p] : [p]);
    setText('');
    setResults([]);
    setOpen(false);
  };

  const shown = text.trim().length >= 2 ? results : [];

  return (
    <div ref={box} className="relative">
      <div className={cx('flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1 focus-within:border-teal-600 focus-within:ring-0')}>
        {value.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1 rounded bg-mint px-1.5 py-0.5 text-xs font-medium text-brand">
            <MapPin className="h-3 w-3" aria-hidden />
            {label(p)}
            <button type="button" onClick={() => onChange(value.filter((v) => v.id !== p.id))} aria-label={`Remove ${p.name}`} className="rounded text-brand/70 hover:text-brand"><X className="h-3 w-3" /></button>
          </span>
        ))}
        {(multiple || value.length === 0) && (
          <Input
            id={id}
            value={text}
            onChange={(e) => { setText(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={value.length === 0 ? placeholder : 'Add another'}
            autoComplete="off"
            className="h-7 min-w-32 flex-1 border-0 px-1 shadow-none focus:ring-0"
          />
        )}
      </div>
      {open && shown.length > 0 && (
        <ul role="listbox" className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg">
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" role="option" aria-selected={false} onClick={() => pick(p)} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-head">{label(p)}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
