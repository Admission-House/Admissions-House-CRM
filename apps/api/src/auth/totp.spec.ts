import { base32Decode, base32Encode, hashRecoveryCode, hotp, looksLikeRecoveryCode, newRecoveryCode, newSecret, otpauthUrl, stepOf, verifyTotp } from './totp.js';

// RFC 6238 appendix B: the secret is the ASCII text 12345678901234567890 and the codes are 8 digits.
// Ours are 6 digits: the last six of the RFC's eight.
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);
const RFC_CASES: [seconds: number, code: string][] = [
  [59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
];

describe('TOTP', () => {
  it.each(RFC_CASES)('gives the RFC 6238 code at %i seconds', (seconds, code) => {
    expect(hotp(RFC_SECRET, stepOf(seconds * 1000))).toBe(code);
  });

  it('accepts the current code and the steps either side of it, but not further away', () => {
    const now = 1111111111 * 1000;
    const at = (offsetSteps: number) => hotp(RFC_SECRET, stepOf(now) + offsetSteps);
    expect(verifyTotp(RFC_SECRET_B32, at(0), now, null)).toBe(stepOf(now));
    expect(verifyTotp(RFC_SECRET_B32, at(-1), now, null)).toBe(stepOf(now) - 1);
    expect(verifyTotp(RFC_SECRET_B32, at(1), now, null)).toBe(stepOf(now) + 1);
    expect(verifyTotp(RFC_SECRET_B32, at(-2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, at(2), now, null)).toBeNull();
  });

  it('refuses a code whose step was already used, or is older than the last used one', () => {
    const now = 1111111111 * 1000;
    const step = stepOf(now);
    expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step - 1), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it('ignores spaces and refuses anything that is not six digits', () => {
    const now = 59 * 1000;
    expect(verifyTotp(RFC_SECRET_B32, '287 082', now, null)).toBe(1);
    for (const bad of ['', '28708', '2870820', 'abcdef', '287-082']) expect(verifyTotp(RFC_SECRET_B32, bad, now, null)).toBeNull();
  });

  it('reads back the secret it wrote, and makes a new one each time', () => {
    const s = newSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(newSecret()).not.toBe(s);
    expect(base32Decode(RFC_SECRET_B32 + '====').equals(RFC_SECRET)).toBe(true);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('builds the address an authenticator app reads', () => {
    const url = otpauthUrl({ issuer: 'Admissions House CRM', account: 'asha@example.com', secret: 'ABC234' });
    expect(url).toBe('otpauth://totp/Admissions%20House%20CRM:asha%40example.com?secret=ABC234&issuer=Admissions+House+CRM&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('look like abcde-23456 and are different each time', () => {
    const a = newRecoveryCode();
    expect(a).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(a).not.toMatch(/[ilo01]/);
    expect(newRecoveryCode()).not.toBe(a);
  });

  it('are told apart from a 6-digit code, and match however they are typed', () => {
    expect(looksLikeRecoveryCode('abcde-23456')).toBe(true);
    expect(looksLikeRecoveryCode('ABCDE23456')).toBe(true);
    expect(looksLikeRecoveryCode('123456')).toBe(false);
    expect(hashRecoveryCode('abcde-23456')).toBe(hashRecoveryCode(' ABCDE 23456 '));
    expect(hashRecoveryCode('abcde-23456')).not.toBe(hashRecoveryCode('abcde-23457'));
  });
});
