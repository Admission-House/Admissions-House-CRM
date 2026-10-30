import { FIELDS, MasterField } from './master-import-rules.js';
import type { Table } from '../imports/spreadsheet.js';

/** Where each of our fields lives in the provider's JSON: a name, or a dotted path such as "fees.annual". */
export type FieldMap = Partial<Record<MasterField, string>>;

/** Reads the COLLEGE_API_FIELD_MAP setting. Throws a message that says exactly what is wrong. */
export function parseFieldMap(text: string | undefined): FieldMap {
  if (!text || text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('COLLEGE_API_FIELD_MAP must be JSON such as {"college":"name","annualFee":"fees.annual"}');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('COLLEGE_API_FIELD_MAP must be a JSON object');
  const map: FieldMap = {};
  for (const [field, path] of Object.entries(value)) {
    if (!(FIELDS as readonly string[]).includes(field)) throw new Error(`COLLEGE_API_FIELD_MAP: "${field}" is not one of ${FIELDS.join(', ')}`);
    if (typeof path !== 'string' || path.trim() === '') throw new Error(`COLLEGE_API_FIELD_MAP: the path for "${field}" must be text`);
    map[field as MasterField] = path.trim();
  }
  return map;
}

const dig = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined), value);

const asText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));

/**
 * Turns the provider's JSON into the same table a spreadsheet gives, so the one import path (preview,
 * checks, problem rows, audit) serves both. `itemsPath` says where the list sits ("data.colleges");
 * empty means the response itself is the list. A field with no mapping is read under its own name.
 */
export function tableFromJson(body: unknown, opts: { itemsPath?: string; fieldMap: FieldMap }): Table {
  const items = opts.itemsPath ? dig(body, opts.itemsPath) : body;
  if (!Array.isArray(items)) {
    throw new Error(opts.itemsPath ? `The response has no list at "${opts.itemsPath}"` : 'The response is not a list. Set COLLEGE_API_ITEMS_PATH to say where the list is');
  }
  const rows = items.map((item) => FIELDS.map((f) => asText(dig(item, opts.fieldMap[f] ?? f))));
  return { header: [...FIELDS], rows };
}
