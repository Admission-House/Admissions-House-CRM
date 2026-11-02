import { newPasswordSchema, passwordProblem } from './password.service.js';

describe('passwordProblem', () => {
  const email = 'meera.sharma@example.com';

  it.each(['Password123', 'password@123', 'P@ssw0rd2026', 'Welcome#2026', 'Admin@123', 'Qwerty12345', 'Admissions2026', 'India@1234', 'abc12345', '12345678a', 'Iloveyou1'])(
    'refuses the common password %s',
    (password) => {
      expect(passwordProblem(password, email)).toMatch(/too easy to guess/);
    },
  );

  it.each(['Correct-horse-2026', 'Fresh-choice-2026', 'Brand-new-pass-77', 'blue tractor 4 harbour', 'Passwordless-login-7'])('accepts %s', (password) => {
    expect(passwordProblem(password, email)).toBeNull();
  });

  it('still refuses a password that contains the email name', () => {
    expect(passwordProblem('meera.sharma-2026-x', email)).toMatch(/email name/);
  });

  it('keeps the length and letters-and-digits rules in the schema', () => {
    expect(newPasswordSchema.safeParse('short1').success).toBe(false);
    expect(newPasswordSchema.safeParse('onlyletterspassword').success).toBe(false);
    expect(newPasswordSchema.safeParse('Correct-horse-2026').success).toBe(true);
  });
});
