import { describe, expect, it } from 'vitest';
import { statusBeforeAnyRecording } from './recording-rules.js';

describe('what a session shows before it has any recording', () => {
  it('says "pending" when a recording is wanted and has not started yet', () => {
    expect(statusBeforeAnyRecording({ recording_enabled: true })).toBe('pending');
    expect(statusBeforeAnyRecording({ recording_enabled: true, recording_unavailable: false })).toBe('pending');
  });
  it('says "unavailable" when it was wanted but the server cannot record', () => {
    expect(statusBeforeAnyRecording({ recording_enabled: false, recording_unavailable: true })).toBe('unavailable');
  });
  it('says "off" when it was never wanted', () => {
    expect(statusBeforeAnyRecording({ recording_enabled: false })).toBe('off');
    expect(statusBeforeAnyRecording({ recording_enabled: false, recording_unavailable: false })).toBe('off');
  });
});
