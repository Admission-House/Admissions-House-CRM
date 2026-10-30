import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://ah_app:secret@localhost:5433/admission_house',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
};

describe('loadEnv', () => {
  it('applies safe defaults', () => {
    const env = loadEnv({ ...base });
    expect(env.PORT).toBe(3001);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(env.ENABLE_API_DOCS).toBe(false);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('splits and trims the CORS origins', () => {
    const env = loadEnv({ ...base, CORS_ORIGINS: ' https://a.example , https://b.example ,' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('refuses to start without a database url', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('refuses a signing secret that is too short', () => {
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses a port outside the valid range', () => {
    expect(() => loadEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  it('refuses an owner account as the application connection in production', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', ...base, DATABASE_URL: 'postgresql://postgres:x@db:5432/app' }),
    ).toThrow(/restricted application role/);
    expect(() => loadEnv({ NODE_ENV: 'production', ...base, MAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.example.com' })).not.toThrow();
    expect(() => loadEnv({ NODE_ENV: 'production', ...base })).toThrow(/MAIL_DRIVER must be smtp/);
  });
});
