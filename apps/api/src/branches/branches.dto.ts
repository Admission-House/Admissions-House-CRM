import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const radius = z.number().int().min(20).max(5000);

export const createBranchSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    address: z.string().trim().max(300).optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    radiusM: radius.optional(),
  })
  .refine(
    (v) => (v.latitude === undefined) === (v.longitude === undefined),
    'Give both latitude and longitude, or neither',
  );
export class CreateBranchDto extends createZodDto(createBranchSchema) {}

export const updateBranchSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    address: z.string().trim().max(300).nullable(),
    radiusM: radius,
    /** How the office sign-in is checked: by address and position, or by position alone. */
    officeCheck: z.enum(['address_and_location', 'location_only']),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateBranchDto extends createZodDto(updateBranchSchema) {}

export const addNetworkSchema = z
  .object({
    kind: z.enum(['ip_range', 'wifi', 'ddns']),
    /** A single address (203.0.113.5) or a range (203.0.113.0/28). */
    ipRange: z.string().trim().max(60).optional(),
    wifiId: z.string().trim().min(1).max(64).optional(),
    /** A dynamic DNS name the office router keeps pointed at its current address, for example office.ddns.net. */
    hostname: z.string().trim().min(3).max(253).optional(),
  })
  .refine(
    (v) =>
      v.kind === 'ip_range'
        ? !!v.ipRange && !v.wifiId && !v.hostname
        : v.kind === 'wifi'
          ? !!v.wifiId && !v.ipRange && !v.hostname
          : !!v.hostname && !v.ipRange && !v.wifiId,
    'Give an ipRange for an IP network, a wifiId for a WiFi network, or a hostname for a dynamic DNS name',
  );
export class AddNetworkDto extends createZodDto(addNetworkSchema) {}

/** A position reading from the browser or phone, taken while standing in the office. */
export const positionSchema = z.object({
  lat: latitude,
  lng: longitude,
  accuracy: z.number().min(0).max(100_000),
});
export class DetectDto extends createZodDto(positionSchema) {}

export const confirmSchema = positionSchema.extend({
  /** Also allow the address this request came from. Normally yes: that is the office network. */
  addCurrentIp: z.boolean().default(true),
  /**
   * Needed when that address is a private one, which means the API is not seeing the office's
   * public address (a misconfigured proxy), unless the API really does run inside the office.
   */
  allowInternalAddress: z.boolean().default(false),
});
export class ConfirmDetectionDto extends createZodDto(confirmSchema) {}
