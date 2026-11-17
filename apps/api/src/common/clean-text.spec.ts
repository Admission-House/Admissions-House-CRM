import { findBadText } from './clean-text.js';

describe('findBadText', () => {
  it('accepts ordinary text in any script, emoji and line breaks', () => {
    expect(findBadText({ name: 'प्रिया वर्मा', note: 'Call 🔥\nafter 6 pm', list: ['a', { b: 'c' }] })).toBeNull();
    expect(findBadText('plain')).toBeNull();
    expect(findBadText(null)).toBeNull();
  });
  it('finds a NUL character and says where', () => {
    expect(findBadText({ name: 'ab\u0000c' })).toBe('name');
    expect(findBadText({ people: [{ note: 'ok' }, { note: 'x\u0000' }] })).toBe('people.1.note');
  });
  it('finds half of a surrogate pair, front or back', () => {
    expect(findBadText({ a: '\ud800' })).toBe('a');
    expect(findBadText({ a: 'x\udc00y' })).toBe('a');
    expect(findBadText({ a: '😀' })).toBeNull(); // a whole pair is fine
  });
});
