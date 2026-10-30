import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import { leadVisibility } from '../access/lead-scope.js';
import { assertFollowUpForStatus, assertFollowUpTime, classifySearch, diffFields, likePattern } from './lead-rules.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_AN_APP_ERROR';
  }
  return undefined;
};

describe('classifySearch', () => {
  it.each([
    ['1042', { kind: 'lead_no', value: '1042' }],
    ['#1042', { kind: 'lead_no', value: '1042' }],
    ['LEAD-1042', { kind: 'lead_no', value: '1042' }],
    ['lead 7', { kind: 'lead_no', value: '7' }],
    ['0007', { kind: 'lead_no', value: '7' }],
  ])('%s is a Lead ID', (input, expected) => {
    expect(classifySearch(input)).toEqual(expected);
  });

  it.each([
    ['9876543210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['98765432', '98765432'], // a fragment stays as typed
    ['(011) 2345-6789', '01123456789'],
  ])('%s is a phone number or part of one', (input, value) => {
    expect(classifySearch(input)).toEqual({ kind: 'phone', value });
  });

  it.each(['Riya', 'riya@example.com', '  Riya Sharma ', 'B.Tech 2026'])('%s is a name or email', (input) => {
    expect(classifySearch(input)).toEqual({ kind: 'text', value: input.trim() });
  });

  it('gives nothing for an empty box', () => {
    expect(classifySearch('   ')).toBeNull();
    expect(classifySearch('')).toBeNull();
  });
});

describe('likePattern', () => {
  it('stops a person from using wildcards', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(likePattern('riya')).toBe('%riya%');
  });
});

describe('diffFields', () => {
  const fields = ['name', 'email', 'intent'];
  it('lists only what changed', () => {
    expect(diffFields({ name: 'Riya', email: 'a@b.co', intent: 'cold' }, { name: 'Riya', email: 'x@y.co', intent: 'hot' }, fields)).toEqual([
      { field: 'email', oldValue: 'a@b.co', newValue: 'x@y.co' },
      { field: 'intent', oldValue: 'cold', newValue: 'hot' },
    ]);
  });

  it('treats empty, null and missing as the same', () => {
    expect(diffFields({ email: null }, { email: '' }, fields)).toEqual([]);
    expect(diffFields({}, { email: undefined }, fields)).toEqual([]);
  });

  it('records a field being filled in or cleared', () => {
    expect(diffFields({ intent: null }, { intent: 'hot' }, fields)).toEqual([{ field: 'intent', oldValue: null, newValue: 'hot' }]);
    expect(diffFields({ intent: 'hot' }, { intent: null }, fields)).toEqual([{ field: 'intent', oldValue: 'hot', newValue: null }]);
  });

  it('ignores fields that were not sent and fields it was not asked about', () => {
    expect(diffFields({ name: 'A', email: 'a@b.co' }, { name: 'B' }, fields)).toEqual([{ field: 'name', oldValue: 'A', newValue: 'B' }]);
    expect(diffFields({ secret: 1 }, { secret: 2 }, fields)).toEqual([]);
  });

  it('compares numbers and text by what they show', () => {
    expect(diffFields({ intent: 5 }, { intent: '5' }, fields)).toEqual([]);
  });
});

describe('assertFollowUpForStatus', () => {
  const needs = { name: 'Follow-up', requiresFollowup: true, isOpen: true };
  it('wants a follow-up for a status that requires one', () => {
    expect(codeOf(() => assertFollowUpForStatus(needs, false, false))).toBe('FOLLOWUP_REQUIRED');
  });
  it('is satisfied by a new follow-up or by one already coming up', () => {
    expect(codeOf(() => assertFollowUpForStatus(needs, true, false))).toBeUndefined();
    expect(codeOf(() => assertFollowUpForStatus(needs, false, true))).toBeUndefined();
  });
  it('asks for nothing from other statuses, and never from a closed one', () => {
    expect(codeOf(() => assertFollowUpForStatus({ ...needs, requiresFollowup: false }, false, false))).toBeUndefined();
    expect(codeOf(() => assertFollowUpForStatus({ ...needs, isOpen: false }, false, false))).toBeUndefined();
  });
});

describe('assertFollowUpTime', () => {
  const now = new Date('2026-10-28T10:00:00Z');
  it('accepts the future and a few seconds ago, refuses the past', () => {
    expect(codeOf(() => assertFollowUpTime(new Date('2026-10-28T10:30:00Z'), now))).toBeUndefined();
    expect(codeOf(() => assertFollowUpTime(new Date('2026-10-28T09:59:30Z'), now))).toBeUndefined();
    expect(codeOf(() => assertFollowUpTime(new Date('2026-10-28T09:00:00Z'), now))).toBe('FOLLOWUP_IN_PAST');
  });
});

describe('leadVisibility', () => {
  const base = { userId: 'u1', permissions: new Set<string>() };
  // Compiles an expression to the SQL it would send, without a database.
  const offline = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const sqlOf = (expr: Parameters<typeof sql>[0] | ReturnType<typeof leadVisibility>) =>
    expr ? sql`select 1 where ${expr}`.compile(offline).sql : 'select 1';

  it('shows a Super Admin everything, so no condition', () => {
    expect(leadVisibility({ ...base, dataScope: 'all' })).toBeUndefined();
  });

  it('shows a counsellor only their own leads, never the unassigned ones', () => {
    const text = sqlOf(leadVisibility({ ...base, dataScope: 'own' }));
    expect(text).toContain('"l"."assigned_to" = $1');
    expect(text.toLowerCase()).not.toContain('is null');
  });

  it('shows an Admin their team, and the unassigned pool only if they can assign', () => {
    const plain = sqlOf(leadVisibility({ ...base, dataScope: 'team' }));
    expect(plain).toContain('manager_id');
    expect(plain.toLowerCase()).not.toContain('is null');

    const withPool = sqlOf(leadVisibility({ ...base, dataScope: 'team', permissions: new Set(['lead.assign']) }));
    expect(withPool.toLowerCase()).toContain('"l"."assigned_to" is null');
  });
});
