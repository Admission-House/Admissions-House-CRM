'use client';

import { GripVertical } from 'lucide-react';
import { useCallback, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '@/components/ui';
import { mergeOrder, moved } from '@/lib/column-order';

/**
 * Columns of a table that a person can put in the order they like, by dragging the small grip in the heading (or with the
 * left and right arrow keys while the grip has focus). The order is kept for that person on this computer, per table. A column
 * that is not in the saved order (a newer one) goes at the end; one that no longer exists is dropped.
 */
const PREFIX = 'ah_cols:';

function read(key: string): string[] | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(PREFIX + key) ?? 'null') as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  } catch {
    return null;
  }
}

export interface ColumnOrder {
  /** Which table these columns belong to (so a drag from another table is ignored). */
  table: string;
  order: string[];
  move: (from: string, to: string) => void;
  /** One place left (-1) or right (1). */
  shift: (id: string, by: -1 | 1) => void;
  reset: () => void;
  /** The order is not the default one. */
  changed: boolean;
}

export function useColumnOrder(table: string, defaults: readonly string[]): ColumnOrder {
  const [saved, setSaved] = useState<string[] | null>(() =>
    typeof window === 'undefined' ? null : read(table),
  );
  const order = mergeOrder(saved, defaults);

  const store = useCallback(
    (next: string[] | null) => {
      setSaved(next);
      try {
        if (next) window.localStorage.setItem(PREFIX + table, JSON.stringify(next));
        else window.localStorage.removeItem(PREFIX + table);
      } catch {
        // storage is blocked: the order still works until the page is left
      }
    },
    [table],
  );

  return {
    table,
    order,
    move: (from, to) => store(moved(order, from, to)),
    shift: (id, by) => {
      const i = order.indexOf(id);
      const j = i + by;
      if (i >= 0 && j >= 0 && j < order.length) store(moved(order, id, order[j]!));
    },
    reset: () => store(null),
    changed: order.join('|') !== defaults.join('|'),
  };
}

/** A column heading with a grip to drag it. Dropping it on another heading puts it in that place. */
export function MovableTh({
  id,
  columns,
  className,
  children,
  label: name,
  ariaSort,
}: {
  id: string;
  columns: ColumnOrder;
  className?: string;
  children: ReactNode;
  label?: string;
  ariaSort?: 'ascending' | 'descending' | 'none';
}) {
  const [over, setOver] = useState(false);
  const type = 'application/x-ah-column';
  const label = name ?? (typeof children === 'string' ? children : id);

  function start(e: DragEvent) {
    e.dataTransfer.setData(type, JSON.stringify({ table: columns.table, id }));
    e.dataTransfer.effectAllowed = 'move';
  }
  function drop(e: DragEvent) {
    setOver(false);
    try {
      const d = JSON.parse(e.dataTransfer.getData(type)) as { table: string; id: string };
      if (d.table === columns.table) {
        e.preventDefault();
        columns.move(d.id, id);
      }
    } catch {
      // not one of our columns
    }
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      columns.shift(id, -1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      columns.shift(id, 1);
    }
  }

  return (
    <th
      aria-sort={ariaSort}
      className={cx(className, over && 'bg-mint-soft')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(type)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          draggable
          onDragStart={start}
          onDragEnd={() => setOver(false)}
          onKeyDown={key}
          aria-label={`Move the ${label} column. Drag it, or press the left or right arrow key.`}
          title="Drag to move this column"
          className="-ml-1 cursor-grab rounded p-0.5 text-subtle hover:bg-line/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden />
        </button>
        {children}
      </span>
    </th>
  );
}
