import { checkValue, FieldDef } from './custom-field-rules.js';

const def = (dataType: FieldDef['dataType'], extra: Partial<FieldDef> = {}): FieldDef => ({ key: 'k', label: 'Field', dataType, isRequired: false, options: [], ...extra });

describe('checkValue', () => {
  it('clears an optional field with null or blank, and refuses to clear a required one', () => {
    for (const blank of [null, undefined, '', '   ']) {
      expect(checkValue(def('text'), blank)).toEqual({ ok: true, value: null });
      expect(checkValue(def('text', { isRequired: true }), blank)).toMatchObject({ ok: false });
    }
  });

  it('trims text and limits its length', () => {
    expect(checkValue(def('text'), '  hello ')).toEqual({ ok: true, value: 'hello' });
    expect(checkValue(def('text'), 'x'.repeat(500))).toMatchObject({ ok: true });
    expect(checkValue(def('text'), 'x'.repeat(501))).toMatchObject({ ok: false });
    expect(checkValue(def('text'), 5)).toMatchObject({ ok: false });
  });

  it.each([[12, '12'], ['12.50', '12.5'], ['-3', '-3'], [0, '0']])('accepts the number %j', (raw, stored) => {
    expect(checkValue(def('number'), raw)).toEqual({ ok: true, value: stored });
  });
  it.each([['abc'], ['1e3'], ['12,5'], [Number.NaN], [Infinity], [1e15], [true]])('refuses the number %j', (raw) => {
    expect(checkValue(def('number'), raw)).toMatchObject({ ok: false });
  });

  it('accepts real dates only', () => {
    expect(checkValue(def('date'), '2026-02-28')).toEqual({ ok: true, value: '2026-02-28' });
    for (const bad of ['2026-02-30', '2026-13-01', '03/11/2026', '2026-2-3', 20261103]) expect(checkValue(def('date'), bad)).toMatchObject({ ok: false });
  });

  it('accepts only the listed options and names them in the message', () => {
    const d = def('select', { options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] });
    expect(checkValue(d, 'a')).toEqual({ ok: true, value: 'a' });
    const bad = checkValue(d, 'Alpha');
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain('Alpha, Beta');
  });
});
