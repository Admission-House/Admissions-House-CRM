import { describe, expect, it } from 'vitest';
import { mergeOrder, moved } from './column-order';

const defaults = ['lead', 'email', 'course', 'status'];

describe('mergeOrder', () => {
  it('is the default order when nothing is saved', () => {
    expect(mergeOrder(null, defaults)).toEqual(defaults);
  });
  it('uses the saved order', () => {
    expect(mergeOrder(['status', 'lead', 'course', 'email'], defaults)).toEqual(['status', 'lead', 'course', 'email']);
  });
  it('puts a column that is newer than the saved order at the end', () => {
    expect(mergeOrder(['status', 'lead'], defaults)).toEqual(['status', 'lead', 'email', 'course']);
  });
  it('drops a saved column that no longer exists, and repeats', () => {
    expect(mergeOrder(['gone', 'lead', 'lead', 'status'], defaults)).toEqual(['lead', 'status', 'email', 'course']);
  });
});

describe('moved', () => {
  it('puts a column where another one was', () => {
    expect(moved(defaults, 'status', 'lead')).toEqual(['status', 'lead', 'email', 'course']);
    expect(moved(defaults, 'lead', 'status')).toEqual(['email', 'course', 'status', 'lead']);
  });
  it('changes nothing for the same column or an unknown one', () => {
    expect(moved(defaults, 'lead', 'lead')).toEqual(defaults);
    expect(moved(defaults, 'lead', 'nope')).toEqual(defaults);
  });
});
