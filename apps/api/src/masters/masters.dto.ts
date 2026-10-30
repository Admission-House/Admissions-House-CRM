import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { pageQuerySchema } from '../common/pagination.js';

const fee = z.number().min(0).max(100_000_000).nullable();
export const deliveryMode = z.enum(['online', 'regular', 'both']);

// ---------------------------------------------------------------------- lists

export const listLocationsSchema = z.object({
  type: z.enum(['state', 'city']).optional(),
  /** The cities of one state. */
  parentId: z.uuid().optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export class ListLocationsDto extends createZodDto(listLocationsSchema) {}

export const listCoursesSchema = pageQuerySchema.extend({
  q: z.string().trim().max(80).optional(),
  level: z.enum(['UG', 'PG', 'Diploma']).optional(),
  streamId: z.uuid().optional(),
});
export class ListCoursesDto extends createZodDto(listCoursesSchema) {}

export const listCollegesSchema = pageQuerySchema.extend({
  q: z.string().trim().max(80).optional(),
  /** A city, or a state to include all its cities. */
  locationId: z.uuid().optional(),
  courseId: z.uuid().optional(),
  /**
   * online or regular: only institutes with a course delivered that way. any: no filter.
   * Left out, it follows the study mode of `leadId` if one is given.
   */
  mode: z.enum(['online', 'regular', 'any']).optional(),
  leadId: z.uuid().optional(),
  /** Added by hand and waiting for an Admin to review them. */
  pendingReview: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export class ListCollegesDto extends createZodDto(listCollegesSchema) {}

// ------------------------------------------------------------------- writing

export const createStreamSchema = z.object({ name: z.string().trim().min(2).max(60) });
export class CreateStreamDto extends createZodDto(createStreamSchema) {}

export const createCourseSchema = z.object({
  name: z.string().trim().min(2).max(100),
  level: z.enum(['UG', 'PG', 'Diploma']),
  streamId: z.uuid().nullable().optional(),
});
export class CreateCourseDto extends createZodDto(createCourseSchema) {}

export const updateCourseSchema = createCourseSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateCourseDto extends createZodDto(updateCourseSchema) {}

/** A course an institute offers, with how it is delivered and what it costs. */
export const offeredCourseSchema = z.object({
  deliveryMode,
  cafFee: fee.default(null),
  annualFee: fee.default(null),
  durationYears: z.number().min(0.5).max(10).nullable().default(null),
});

export const collegeCourseInputSchema = z
  .object({
    /** An existing course… */
    courseId: z.uuid().optional(),
    /** …or a new one, if the course is not in the list yet. */
    newCourse: createCourseSchema.optional(),
  })
  .extend(offeredCourseSchema.shape)
  .refine((v) => (v.courseId ? !v.newCourse : !!v.newCourse), 'Give either courseId or newCourse');

export const createCollegeSchema = z.object({
  name: z.string().trim().min(2).max(150),
  locationId: z.uuid().nullable().optional(),
  courses: z.array(collegeCourseInputSchema).max(60).default([]),
});
export class CreateCollegeDto extends createZodDto(createCollegeSchema) {}

export const updateCollegeSchema = z
  .object({ name: z.string().trim().min(2).max(150), locationId: z.uuid().nullable(), isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateCollegeDto extends createZodDto(updateCollegeSchema) {}

export const setOfferedCourseSchema = offeredCourseSchema.extend({ isActive: z.boolean().default(true) });
export class SetOfferedCourseDto extends createZodDto(setOfferedCourseSchema) {}

export const reviewSchema = z.object({ decision: z.enum(['approved', 'rejected']) });
export class ReviewDto extends createZodDto(reviewSchema) {}
