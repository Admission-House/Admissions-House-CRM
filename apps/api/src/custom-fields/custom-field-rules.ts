export type DataType = 'text' | 'number' | 'date' | 'select';

export interface FieldDef {
  key: string;
  label: string;
  dataType: DataType;
  isRequired: boolean;
  options: { value: string; label: string }[];
}

export type Checked = { ok: true; value: string | null } | { ok: false; message: string };

const MAX_TEXT = 500;

/**
 * Checks what was entered for a field against its definition and returns the text to store.
 * null (or an empty string) clears the field, which a required field does not allow.
 */
export function checkValue(def: FieldDef, raw: unknown): Checked {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return def.isRequired ? { ok: false, message: `${def.label} is required` } : { ok: true, value: null };
  }
  switch (def.dataType) {
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, message: `${def.label} must be text` };
      const text = raw.trim();
      return text.length > MAX_TEXT ? { ok: false, message: `${def.label} must be at most ${MAX_TEXT} characters` } : { ok: true, value: text };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
      return Number.isFinite(n) && Math.abs(n) <= 1e12 ? { ok: true, value: String(n) } : { ok: false, message: `${def.label} must be a number` };
    }
    case 'date': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, message: `${def.label} must be a date such as 2026-11-03` };
      const d = new Date(`${raw}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(raw) ? { ok: true, value: raw } : { ok: false, message: `${def.label} is not a real date` };
    }
    case 'select': {
      const hit = typeof raw === 'string' && def.options.some((o) => o.value === raw);
      return hit ? { ok: true, value: raw as string } : { ok: false, message: `${def.label} must be one of: ${def.options.map((o) => o.label).join(', ')}` };
    }
  }
}
