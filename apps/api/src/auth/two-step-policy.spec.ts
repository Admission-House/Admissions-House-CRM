import { parseTwoStepPolicy, twoStepRequired } from './two-step-policy.js';

describe('who must use two-step sign-in', () => {
  it('requires nobody when the company leaves it to each person', () => {
    for (const role of ['super_admin', 'admin', 'counsellor', null] as const) expect(twoStepRequired('none', role)).toBe(false);
  });

  it('can require only the Super Admins', () => {
    expect(twoStepRequired('super_admin', 'super_admin')).toBe(true);
    expect(twoStepRequired('super_admin', 'admin')).toBe(false);
    expect(twoStepRequired('super_admin', 'counsellor')).toBe(false);
  });

  it('can require the Super Admins and the Admins, but never counsellors', () => {
    expect(twoStepRequired('admins', 'super_admin')).toBe(true);
    expect(twoStepRequired('admins', 'admin')).toBe(true);
    expect(twoStepRequired('admins', 'counsellor')).toBe(false);
  });

  it('does not cover a role the company made for itself', () => {
    expect(twoStepRequired('admins', null)).toBe(false);
    expect(twoStepRequired('super_admin', null)).toBe(false);
  });

  it('reads a stored setting that is missing or unknown as "nobody"', () => {
    expect(parseTwoStepPolicy(undefined)).toBe('none');
    expect(parseTwoStepPolicy(null)).toBe('none');
    expect(parseTwoStepPolicy('everyone')).toBe('none');
    expect(parseTwoStepPolicy(7)).toBe('none');
    expect(parseTwoStepPolicy('admins')).toBe('admins');
    expect(parseTwoStepPolicy('super_admin')).toBe('super_admin');
  });
});
