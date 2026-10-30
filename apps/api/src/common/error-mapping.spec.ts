import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createZodDto, ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { AppError } from './app-error.js';
import { mapError } from './error-mapping.js';

const pgError = (code: string, constraint = 'some_constraint') =>
  Object.assign(new Error('internal detail: table leads, constraint some_constraint'), { code, constraint });

describe('mapError', () => {
  it('passes an AppError through unchanged', () => {
    const mapped = mapError(AppError.conflict('LEAD_EXISTS', 'This phone number already has a lead'));
    expect(mapped).toMatchObject({ status: 409, code: 'LEAD_EXISTS', unexpected: false });
  });

  it('turns a failed validation into field errors', () => {
    class Dto extends createZodDto(z.object({ name: z.string().min(2), phone: z.string().regex(/^\d{10}$/) })) {}
    const result = Dto.schema.safeParse({ name: 'A', phone: 'abc' });
    expect(result.success).toBe(false);
    const mapped = mapError(new ZodValidationException(result.error!));
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('VALIDATION_FAILED');
    expect(mapped.fieldErrors?.map((f) => f.field).sort()).toEqual(['name', 'phone']);
  });

  it('keeps the status of Nest HTTP exceptions', () => {
    expect(mapError(new NotFoundException('gone'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(mapError(new BadRequestException(['a is wrong', 'b is wrong']))).toMatchObject({
      status: 400,
      message: 'a is wrong; b is wrong',
    });
  });

  describe('database errors', () => {
    it('duplicate key is a 409 and does not leak table or constraint names', () => {
      const mapped = mapError(pgError('23505'));
      expect(mapped).toMatchObject({ status: 409, code: 'DUPLICATE', unexpected: false });
      expect(JSON.stringify(mapped)).not.toMatch(/leads|some_constraint/);
    });

    it('foreign key and check violations are client errors', () => {
      expect(mapError(pgError('23503')).status).toBe(409);
      expect(mapError(pgError('23514')).status).toBe(422);
    });

    it('a row-level-security or privilege failure is a 403', () => {
      expect(mapError(pgError('42501'))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });

    it('deadlocks and timeouts ask the client to retry', () => {
      expect(mapError(pgError('40P01'))).toMatchObject({ status: 503, code: 'RETRY', headers: { 'retry-after': '1' } });
      expect(mapError(pgError('57014'))).toMatchObject({ status: 503, code: 'TIMEOUT' });
    });

    it('a lost connection is reported as unavailable', () => {
      expect(mapError(pgError('08006')).status).toBe(503);
      expect(mapError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })).status).toBe(503);
    });
  });

  it('hides the details of an unexpected error', () => {
    const mapped = mapError(new TypeError("Cannot read properties of undefined (reading 'password_hash')"));
    expect(mapped).toMatchObject({ status: 500, code: 'INTERNAL', unexpected: true });
    expect(mapped.message).not.toMatch(/password_hash|undefined/);
  });
});
