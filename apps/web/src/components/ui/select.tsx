'use client';

import { Check, ChevronDown, Search } from 'lucide-react';
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { twMerge } from 'tailwind-merge';
import type { ChangeEvent, ReactNode, SelectHTMLAttributes } from 'react';

const join = (...parts: (string | false | null | undefined)[]) =>
  twMerge(parts.filter(Boolean).join(' '));

interface Opt {
  value: string;
  label: string;
  disabled: boolean;
}

const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) =>
      typeof c === 'string' || typeof c === 'number'
        ? String(c)
        : isValidElement(c)
          ? textOf((c.props as { children?: ReactNode }).children)
          : '',
    )
    .join('');

/** Reads the <option> elements given as children, however they were produced (lists, conditions, fragments). */
function optionsOf(children: ReactNode): Opt[] {
  const out: Opt[] = [];
  const walk = (nodes: ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === Fragment) return walk((child.props as { children?: ReactNode }).children);
      const p = child.props as {
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      };
      const label = textOf(p.children);
      out.push({
        value: p.value === undefined ? label : String(p.value),
        label,
        disabled: !!p.disabled,
      });
    });
  };
  walk(children);
  return out;
}

/** The sizing and placement classes of a given class list, so the wrapper sits in a row or grid the way the box was asked to. */
const layoutOf = (cls?: string) =>
  (cls ?? '')
    .split(/\s+/)
    .filter((c) =>
      /^((sm|md|lg|xl):)?(w-|min-w-|max-w-|flex-|grow|shrink|basis-|col-span-|self-)/.test(c),
    )
    .join(' ');

/** From this many choices on, the open list has a box to type in, which narrows it. */
const SEARCH_FROM = 8;

/**
 * A drop-down in the product's own look: the closed box matches the text boxes, and the list that opens
 * is white with a teal tick on the chosen line. It takes the same props and <option> children as a
 * plain <select>, and calls onChange with an event whose target.value is the chosen value.
 */
export function Select({
  className,
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  required,
  id,
  name,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = useMemo(() => optionsOf(children), [children]);
  const [inner, setInner] = useState(String(defaultValue ?? ''));
  const current = value === undefined ? inner : String(value);
  const shown = options.find((o) => o.value === current) ?? options[0];

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // A long list can be narrowed by typing: the box at its top (or typing on the closed drop-down) filters it.
  const searchable = options.length >= SEARCH_FROM;
  const [query, setQuery] = useState('');
  const shownOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.value !== '' && o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const search = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();

  function place() {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 200 && above > below;
    setBox({
      left: r.left,
      width: r.width,
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      maxHeight: Math.min(288, up ? above : below),
    });
  }

  function show(typed = '') {
    if (disabled) return;
    place();
    setQuery(typed);
    setActive(
      typed
        ? 0
        : Math.max(
            0,
            options.findIndex((o) => o.value === shown?.value),
          ),
    );
    setOpen(true);
  }

  function choose(o: Opt | undefined) {
    if (!o || o.disabled) return;
    setOpen(false);
    button.current?.focus();
    if (o.value === current) return;
    if (value === undefined) setInner(o.value);
    onChange?.({
      target: { value: o.value, name: name ?? '' },
      currentTarget: { value: o.value, name: name ?? '' },
    } as unknown as ChangeEvent<HTMLSelectElement>);
  }

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const close = (e: Event) => {
      if (!pop.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  // The search box takes the typing as soon as a long list opens.
  useEffect(() => {
    if (open && searchable) search.current?.focus();
  }, [open, searchable]);

  function key(e: React.KeyboardEvent, inSearch = false) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      // Typing on a closed long list opens it already searching for that letter.
      else if (searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        show(e.key);
      }
      return;
    }
    const items = shownOptions;
    const step = (from: number, dir: 1 | -1) => {
      for (let i = from + dir; i >= 0 && i < items.length; i += dir)
        if (!items[i]!.disabled) return i;
      return from;
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => step(a, -1));
    } else if (e.key === 'Home' && !inSearch) {
      e.preventDefault();
      setActive(step(-1, 1));
    } else if (e.key === 'End' && !inSearch) {
      e.preventDefault();
      setActive(step(items.length, -1));
    } else if (e.key === 'Enter' || (e.key === ' ' && !inSearch)) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Tab') setOpen(false);
    else if (e.key.length === 1 && !inSearch) {
      const at = items.findIndex(
        (o, i) =>
          i > active && !o.disabled && o.label.toLowerCase().startsWith(e.key.toLowerCase()),
      );
      const from =
        at >= 0
          ? at
          : items.findIndex(
              (o) => !o.disabled && o.label.toLowerCase().startsWith(e.key.toLowerCase()),
            );
      if (from >= 0) setActive(from);
    }
  }

  return (
    <div className={join('relative', layoutOf(className))}>
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => key(e)}
        className={join(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-surface pl-2.5 pr-2 text-left text-sm text-ink transition-colors focus:border-teal-600 focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:bg-head disabled:text-muted aria-[invalid=true]:border-bad',
          open && 'border-teal-600',
          className,
        )}
      >
        <span className={join('truncate', current === '' && 'text-subtle')}>
          {shown?.label || ' '}
        </span>
        <ChevronDown
          className={join(
            'h-4 w-4 shrink-0 text-muted transition-transform',
            open && 'rotate-180 text-brand',
          )}
          aria-hidden
        />
      </button>

      {required && (
        <input
          tabIndex={-1}
          aria-hidden
          required
          value={current}
          onChange={() => undefined}
          className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0"
        />
      )}

      {open &&
        box &&
        createPortal(
          <div
            ref={pop}
            style={{
              left: box.left,
              minWidth: box.width,
              top: box.top,
              bottom: box.bottom,
              maxHeight: box.maxHeight,
            }}
            className="fixed z-[80] flex w-max max-w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[0_8px_24px_rgb(20_38_43/0.14)]"
          >
            {searchable && (
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(e) => key(e, true)}
                  placeholder="Type to search"
                  aria-label={`Search ${ariaLabel ?? 'the list'}`}
                  aria-controls={listId}
                  autoComplete="off"
                  className="w-full min-w-40 bg-transparent text-sm text-ink outline-none placeholder:text-subtle"
                />
              </div>
            )}
            <ul
              ref={list}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {shownOptions.length === 0 && (
                <li className="px-3 py-2 text-sm text-subtle">Nothing matches</li>
              )}
              {shownOptions.map((o, i) => {
                const blank = o.value === ''; // the "Choose…" line is a prompt, not a choice
                const on = !blank && o.value === shown?.value;
                return (
                  <li
                    key={`${o.value}-${i}`}
                    role="option"
                    aria-selected={on}
                    aria-disabled={o.disabled || undefined}
                    onMouseEnter={() => !o.disabled && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                    className={join(
                      'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                      i === active && !o.disabled && 'bg-mint-soft',
                      on ? 'font-semibold text-brand' : 'text-ink',
                      blank && 'text-subtle',
                      o.disabled && 'cursor-not-allowed text-subtle',
                    )}
                  >
                    <span className="flex-1 whitespace-nowrap">{o.label}</span>
                    {on && <Check className="h-4 w-4 shrink-0 text-teal-600" aria-hidden />}
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
