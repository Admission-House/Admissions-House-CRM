/**
 * Phone numbers are stored as country code plus digits, with no plus sign or spaces, so the same
 * number always has the same form and can be compared and de-duplicated. Numbers typed without a
 * country code are taken to be Indian.
 *
 * Returns null when the text cannot be a phone number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  const n = digits.replace(/^\+/, '');

  if (/^[6-9]\d{9}$/.test(n)) return `91${n}`; // 9876543210
  if (/^0[6-9]\d{9}$/.test(n)) return `91${n.slice(1)}`; // 09876543210
  if (/^91[6-9]\d{9}$/.test(n)) return n; // 919876543210
  if (/^00\d{8,15}$/.test(n)) return n.slice(2); // 00 international prefix
  // A number that starts with India's code but is not a valid Indian number is a typo, not a foreign number.
  if (n.startsWith('91')) return null;
  // Another country's number, given with its country code.
  return digits.startsWith('+') && /^[1-9]\d{7,14}$/.test(n) ? n : null;
}
