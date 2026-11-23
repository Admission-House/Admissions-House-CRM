'use client';

import { useCallback, useEffect, useState } from 'react';
import { SearchSelect, type SearchOption } from '@/components/ui/search-select';
import { api } from '@/lib/api';
import type { Page } from '@/lib/types';

interface CourseItem { id: string; name: string; level: string }

const toOption = (c: CourseItem): SearchOption => ({ id: c.id, label: c.name, note: c.level });

/**
 * Chooses one course by typing part of its name. The list is searched on the server, so every course can be found
 * however many there are. The value is the course id ('' for none), as with a plain drop-down.
 */
export function CoursePicker({
  id, value, onChange, placeholder = 'Type a course, e.g. MBA', exclude, disabled,
}: {
  id?: string;
  value: string;
  onChange: (courseId: string) => void;
  placeholder?: string;
  /** Courses not to offer (for example the ones a university already has). */
  exclude?: ReadonlySet<string>;
  disabled?: boolean;
}) {
  const [chosen, setChosen] = useState<SearchOption | null>(null);

  // A course chosen earlier (an edit form) is shown by its name.
  useEffect(() => {
    if (!value || chosen?.id === value) return;
    const ctl = new AbortController();
    api<CourseItem>(`/courses/${value}`, { signal: ctl.signal }).then((c) => setChosen(toOption(c))).catch(() => undefined);
    return () => ctl.abort();
  }, [value, chosen?.id]);

  const load = useCallback(
    async (q: string, signal: AbortSignal) => {
      const r = await api<Page<CourseItem>>('/courses', { query: { limit: 100, ...(q && { q }) }, signal });
      return r.items.filter((c) => !exclude?.has(c.id)).map(toOption);
    },
    [exclude],
  );

  return (
    <SearchSelect
      id={id}
      value={value ? (chosen?.id === value ? chosen : null) : null}
      onChange={(o) => { setChosen(o); onChange(o?.id ?? ''); }}
      load={load}
      placeholder={placeholder}
      emptyText="No course matches"
      disabled={disabled}
    />
  );
}
