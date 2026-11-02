import { randomBytes, randomInt } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import argon2 from 'argon2';
import { z } from 'zod';

const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

/** Rules for a password someone chooses. Length matters more than symbols. */
export const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use both letters and numbers');

/**
 * The words that most guessed passwords are made of. A password is refused when, after taking out
 * digits and symbols and undoing simple swaps such as @ for a, nothing else is left. "Password@123"
 * and "Welcome#2026" are refused; a longer passphrase that merely contains one of these words is fine.
 */
const COMMON_STEMS = new Set([
  'password', 'passw', 'pass', 'passcode', 'welcome', 'admin', 'administrator', 'root', 'user', 'login', 'master', 'secret', 'changeme', 'letmein',
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'abc', 'abcd', 'abcde', 'abcdef', 'iloveyou', 'monkey', 'dragon', 'sunshine',
  'princess', 'football', 'cricket', 'baseball', 'superman', 'batman', 'shadow', 'trustno', 'hello', 'test', 'testing', 'demo', 'guest', 'default',
  'india', 'bharat', 'delhi', 'mumbai', 'noida', 'krishna', 'shiva', 'ganesh', 'radha', 'sachin', 'virat', 'rohit', 'dhoni',
  'admission', 'admissions', 'admissionhouse', 'admissionshouse', 'crm', 'college', 'student', 'counsellor', 'counselor', 'office', 'company', 'team',
]);

/**
 * The letters of a password in lower case, in two readings. "plain" drops every digit and symbol
 * ("India@1234" is "india"). "swapped" first undoes look-alike swaps that sit inside a word, so
 * "P@ssw0rd2026" is "password" while the zeros of 2026 are left alone.
 */
function stemsOf(password: string): [plain: string, swapped: string] {
  const lower = password.toLowerCase();
  const swapped = lower
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/(?<=[a-z])0(?=[a-z])/g, 'o')
    .replace(/[^a-z]/g, '');
  return [lower.replace(/[^a-z]/g, ''), swapped];
}

/** Returns a problem with an otherwise valid password, or null. Needs to know who it is for. */
export function passwordProblem(password: string, email: string): string | null {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    return 'The password must not contain your email name';
  }
  const [plain, swapped] = stemsOf(password);
  if (plain.length <= 2 || COMMON_STEMS.has(plain) || COMMON_STEMS.has(swapped)) {
    return 'This password is too easy to guess. Use a longer one, such as three or four unrelated words.';
  }
  if (/^(.)\1+$/.test(password.replace(/[^A-Za-z0-9]/g, ''))) {
    return 'This password is too easy to guess. Use a longer one, such as three or four unrelated words.';
  }
  return null;
}

@Injectable()
export class PasswordService implements OnModuleInit {
  /** A real hash of a random value. Checking against it costs the same as a real check. */
  private decoyHash = '';

  async onModuleInit(): Promise<void> {
    this.decoyHash = await argon2.hash(randomBytes(16).toString('hex'), HASH_OPTIONS);
  }

  /**
   * A one-time password for a new or reset account. It avoids look-alike characters so it can be
   * read out or typed, always meets the policy, and must be replaced at first sign-in.
   */
  generateTemporary(length = 14): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const digits = '23456789';
    const pick = (set: string) => set[randomInt(set.length)]!;
    let candidate: string;
    do {
      candidate = Array.from({ length }, () => pick(letters + digits)).join('');
    } while (!/[A-Za-z]/.test(candidate) || !/\d/.test(candidate));
    return candidate;
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, HASH_OPTIONS);
  }

  /** A malformed hash counts as a wrong password; it never throws. */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spend the same time as a real check when the account does not exist, so that response time
   * does not reveal which email addresses are registered.
   */
  async verifyDecoy(password: string): Promise<void> {
    await this.verify(this.decoyHash, password);
  }
}
