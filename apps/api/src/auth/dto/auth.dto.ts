import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { newPasswordSchema } from '../password.service.js';

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Radius of uncertainty reported by the device, in metres. */
  accuracy: z.number().min(0).max(100_000),
  /** Set by the mobile app when the operating system flags the position as mocked. */
  mocked: z.boolean().optional(),
});

const deviceSchema = z.object({
  fingerprint: z.string().min(8).max(128),
  platform: z.enum(['android', 'ios']),
  label: z.string().trim().max(80).optional(),
});

export const loginSchema = z.object({
  /** The company's sign-in name, for example admissions-house. */
  tenant: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Enter your company name'),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  /** "mobile" gets the refresh token in the response; "web" gets it in a protected cookie. */
  clientType: z.enum(['web', 'mobile']).default('web'),
  device: deviceSchema.optional(),
  location: locationSchema.optional(),
  /** A WiFi identifier the mobile app can read where the operating system allows it. */
  wifiId: z.string().trim().min(1).max(64).optional(),
});
export class LoginDto extends createZodDto(loginSchema) {}

export const refreshSchema = z.object({
  /** Mobile clients send it here; web clients send it as a cookie. */
  refreshToken: z.string().max(300).optional(),
});
export class RefreshDto extends createZodDto(refreshSchema) {}

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: newPasswordSchema,
});
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

export const forgotPasswordSchema = z.object({
  tenant: loginSchema.shape.tenant,
  email: z.string().trim().toLowerCase().email().max(254),
});
export class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}

export const resetPasswordSchema = z.object({ token: z.string().max(200), newPassword: newPasswordSchema });
export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}

export type LoginInput = z.infer<typeof loginSchema>;
