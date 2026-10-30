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

/** Returns a problem with an otherwise valid password, or null. Needs to know who it is for. */
export function passwordProblem(password: string, email: string): string | null {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    return 'The password must not contain your email name';
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
