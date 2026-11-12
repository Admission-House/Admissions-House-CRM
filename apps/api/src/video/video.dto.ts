import { z } from 'zod';

const kind = z.enum(['video', 'voice']);
const minutes = z.number().int().min(5).max(240);
const when = z.iso.datetime({ offset: true });

/** A video or voice call with the lead, started from the lead's page. */
export const leadSessionSchema = z.object({
  kind: kind.default('video'),
  maxMinutes: minutes.default(45),
  /** Without it the session can be joined straight away. */
  scheduledFor: when.optional(),
});

/** A call to a colleague: it rings on their screen until they answer, turn it down or miss it. */
export const callSchema = z.object({
  toUserId: z.uuid(),
  kind: kind.default('voice'),
  leadId: z.uuid().optional(),
  maxMinutes: minutes.default(60),
});

/** A planned (or immediate) group meeting. Staff are invited by id; outside guests get a link of their own. */
export const meetingSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  kind: kind.default('video'),
  scheduledFor: when.optional(),
  durationMinutes: minutes.default(60),
  leadId: z.uuid().optional(),
  staffIds: z.array(z.uuid()).max(100).default([]),
  guests: z.array(z.object({ name: z.string().trim().min(1).max(80) })).max(100).default([]),
});

/** One more person in a meeting: a colleague, or an outside guest. */
export const inviteSchema = z
  .object({ userId: z.uuid().optional(), guestName: z.string().trim().min(1).max(80).optional() })
  .refine((v) => (v.userId === undefined) !== (v.guestName === undefined), { message: 'Give either a colleague (userId) or a guest name, not both' });

export const respondSchema = z.object({ action: z.enum(['accept', 'decline']) });

/** What a screen tells the server: it is connected, it is still here, it has left. */
export const presenceSchema = z.object({ event: z.enum(['joined', 'ping', 'left']) });

/** The guest's side. The device id is a random value the browser made for this invitation and keeps. */
export const guestJoinSchema = z.object({
  token: z.string().trim().min(40).max(200),
  deviceId: z.string().trim().regex(/^[A-Za-z0-9_-]{24,64}$/, 'not a valid device id'),
  /** The guest may correct how their name is shown. */
  name: z.string().trim().min(1).max(80).optional(),
});
export const guestPresenceSchema = z.object({
  token: z.string().trim().min(40).max(200),
  deviceId: z.string().trim().regex(/^[A-Za-z0-9_-]{24,64}$/),
  event: presenceSchema.shape.event,
});

export const historyQuerySchema = z.object({
  type: z.enum(['call', 'meeting']).optional(),
  kind: kind.optional(),
  /** What became of it. `open` is everything planned, ringing or running. */
  outcome: z.enum(['completed', 'missed', 'declined', 'busy', 'cancelled', 'failed', 'open']).optional(),
  leadId: z.uuid().optional(),
  /** Sessions this person was invited to. */
  userId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});

export type LeadSessionInput = z.infer<typeof leadSessionSchema>;
export type CallInput = z.infer<typeof callSchema>;
export type MeetingInput = z.infer<typeof meetingSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
