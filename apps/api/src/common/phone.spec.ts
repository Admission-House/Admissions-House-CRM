import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '919876543210'],
    ['98765 43210', '919876543210'],
    ['098765-43210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['919876543210', '919876543210'],
    ['(+91) 98765-43210', '919876543210'],
    ['+44 7911 123456', '447911123456'],
    ['0091 98765 43210', '919876543210'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '12345', '5876543210', '98765432101', '+0123456789', '9876 54321x', '+91 98765 4321'])(
    'refuses %j',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );

  it('gives the same result for the same number written differently', () => {
    const forms = ['9876543210', '+91 9876543210', '09876543210', '919876543210'];
    expect(new Set(forms.map(normalizePhone)).size).toBe(1);
  });
});
