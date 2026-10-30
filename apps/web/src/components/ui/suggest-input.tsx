'use client';

import { useId } from 'react';
import { Input } from '@/components/ui';
import { useApi } from '@/lib/use-api';
import type { InputHTMLAttributes } from 'react';

/**
 * A text box that offers the values other leads already have (a board, a school, an occupation, an
 * exam), so the same thing is picked rather than typed a new way each time. A new value can still be typed.
 */
export function SuggestInput({ field, ...rest }: { field: 'board' | 'institution' | 'occupation' | 'exam' } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const options = useApi<string[]>('/lead-suggestions', { field });
  return (
    <>
      <Input {...rest} list={id} autoComplete="off" />
      <datalist id={id}>{options.data?.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}
