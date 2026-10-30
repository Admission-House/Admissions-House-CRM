import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends email. With MAIL_DRIVER=smtp it goes out through the company's mail server (any provider
 * speaks SMTP). With "log" nothing leaves the machine: messages are kept in memory so developers
 * and tests can read them. Production refuses the "log" driver at start-up.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport?: Transporter;
  /** The last messages, newest last. Only filled by the "log" driver. */
  readonly outbox: Mail[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.MAIL_DRIVER === 'smtp') {
      this.transport = nodemailer.createTransport({
        host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, requireTLS: !env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      });
    }
  }

  /** Never throws: a mail failure must not break the request that caused it. Returns whether it was sent. */
  async send(mail: Mail): Promise<boolean> {
    if (!this.transport) {
      this.outbox.push(mail);
      if (this.outbox.length > 50) this.outbox.shift();
      return true;
    }
    try {
      await this.transport.sendMail({ from: this.env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
      return true;
    } catch (err) {
      this.logger.error(`email to a user failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
