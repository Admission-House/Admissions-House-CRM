import { parseFieldMap, tableFromJson } from './college-api-rules.js';

describe('parseFieldMap', () => {
  it('reads a JSON object of known fields', () => {
    expect(parseFieldMap('{"college":"name","annualFee":"fees.annual"}')).toEqual({ college: 'name', annualFee: 'fees.annual' });
    expect(parseFieldMap(undefined)).toEqual({});
    expect(parseFieldMap('  ')).toEqual({});
  });
  it('says exactly what is wrong', () => {
    expect(() => parseFieldMap('not json')).toThrow(/must be JSON/);
    expect(() => parseFieldMap('[1]')).toThrow(/JSON object/);
    expect(() => parseFieldMap('{"colour":"x"}')).toThrow(/"colour" is not one of/);
    expect(() => parseFieldMap('{"college":5}')).toThrow(/must be text/);
  });
});

describe('tableFromJson', () => {
  it('reads our own field names when nothing is mapped', () => {
    const t = tableFromJson([{ college: 'A', course: 'B.Tech', mode: 'regular', annualFee: 100000 }], { fieldMap: {} });
    expect(t.header).toContain('annualFee');
    expect(t.rows[0]![t.header.indexOf('college')]).toBe('A');
    expect(t.rows[0]![t.header.indexOf('annualFee')]).toBe('100000');
    expect(t.rows[0]![t.header.indexOf('city')]).toBe('');
  });
  it('follows the mapping and the path to the list', () => {
    const t = tableFromJson({ data: { list: [{ inst: { n: 'A' }, c: 'MBA' }] } }, { itemsPath: 'data.list', fieldMap: { college: 'inst.n', course: 'c' } });
    expect(t.rows[0]![t.header.indexOf('college')]).toBe('A');
    expect(t.rows[0]![t.header.indexOf('course')]).toBe('MBA');
  });
  it('refuses a response that has no list', () => {
    expect(() => tableFromJson({ a: 1 }, { fieldMap: {} })).toThrow(/not a list/);
    expect(() => tableFromJson({ a: 1 }, { itemsPath: 'x.y', fieldMap: {} })).toThrow(/no list at "x.y"/);
  });
  it('does not turn nested objects into text', () => {
    const t = tableFromJson([{ college: { deep: 1 }, course: 'C' }], { fieldMap: {} });
    expect(t.rows[0]![t.header.indexOf('college')]).toBe('');
  });
});
