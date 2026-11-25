'use client';

import { ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '@/components/ui';

export interface SearchOption {
  id: string;
  label: string;
  /** A short grey note on the right, for example the course level. */
  note?: string;
}

/**
 * A drop-down that can be typed in: the list narrows as the person types, and it is asked for from the server,
 * so a long list (hundreds of courses, every university) is never cut short. Arrow keys move, Enter chooses,
 * Escape closes.
 */
export function SearchSelect({
  id,
  value,
  onChange,
  load,
  placeholder = 'Type to search',
  emptyText = 'Nothing matches',
  disabled,
}: {
  id?: string;
  /** The chosen option, or null. */
  value: SearchOption | null;
  onChange: (option: SearchOption | null) => void;
  /**
   * Returns the options for what was typed ('' for the first ones). Keep it stable (useCallback): when it changes, because
   * something it depends on changed (a study mode, a course...), the list is asked for again.
   */
  load: (q: string, signal: AbortSignal) => Promise<SearchOption[]>;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<SearchOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    const t = setTimeout(
      () => {
        setLoading(true);
        load(text.trim(), ctl.signal)
          .then((r) => {
            setOptions(r);
            setActive(0);
          })
          .catch(() => undefined)
          .finally(() => {
            if (!ctl.signal.aborted) setLoading(false);
          });
      },
      text ? 200 : 0,
    );
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, open, load]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        setText('');
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (o: SearchOption) => {
    onChange(o);
    setText('');
    setOpen(false);
  };

  function key(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && options[active]) {
        e.preventDefault();
        pick(options[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setText('');
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  return (
    <div ref={box} className="relative">
      <div
        className={cx(
          'flex h-9 items-center rounded-md border border-line-strong bg-surface pl-3 pr-1 focus-within:border-teal-600',
          disabled && 'opacity-60',
        )}
      >
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          disabled={disabled}
          value={open ? text : (value?.label ?? '')}
          placeholder={value && open ? value.label : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={key}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-subtle"
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setText('');
              input.current?.focus();
            }}
            aria-label="Clear"
            className="grid h-7 w-7 place-items-center rounded text-subtle hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => {
            setOpen((o) => !o);
            input.current?.focus();
          }}
          aria-label="Show the list"
          className="grid h-7 w-7 place-items-center rounded text-subtle hover:text-ink"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg"
        >
          {options.map((o, i) => (
            <li key={o.id} id={`${listId}-${i}`} role="option" aria-selected={value?.id === o.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={cx(
                  'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm',
                  i === active ? 'bg-head' : '',
                  value?.id === o.id && 'font-semibold text-brand',
                )}
              >
                <span className="truncate">{o.label}</span>
                {o.note && <span className="shrink-0 text-xs text-subtle">{o.note}</span>}
              </button>
            </li>
          ))}
          {options.length === 0 && (
            <li className="px-3 py-2 text-sm text-subtle">{loading ? 'Searching…' : emptyText}</li>
          )}
        </ul>
      )}
    </div>
  );
}
