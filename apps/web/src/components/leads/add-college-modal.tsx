'use client';

import { useState } from 'react';
import { Button, Field, Input, Notice, Select } from '@/components/ui';
import { LocationPicker, type Place } from '@/components/ui/location-picker';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

/**
 * Adds an institute that is not in the list, with one course. Someone who manages the lists adds it for
 * good; a counsellor's institute is usable at once but waits for an Admin to review it (the server decides).
 */
export function AddCollegeModal({ initialName = '', onClose, onDone }: { initialName?: string; onClose: () => void; onDone: (waitsForReview: boolean) => void }) {
  const { can } = useAuth();
  const courses = useApi<Page<{ id: string; name: string; level: string }>>('/courses', { limit: 100 });
  const [name, setName] = useState(initialName);
  const [place, setPlace] = useState<Place[]>([]);
  const [courseId, setCourseId] = useState('');
  const [mode, setMode] = useState('online');
  const [fee, setFee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const permanent = can('master.manage');

  async function save() {
    setError(null);
    const annual = fee.trim() === '' ? null : Number(fee);
    if (annual !== null && (!Number.isFinite(annual) || annual < 0)) return setError('Enter the yearly fee as a number, or leave it empty.');
    setBusy(true);
    try {
      await api('/colleges', {
        method: 'POST',
        body: {
          name: name.trim(),
          locationId: place[0]?.id ?? null,
          courses: courseId ? [{ courseId, deliveryMode: mode, annualFee: annual }] : [],
        },
      });
      onDone(!permanent);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
      setBusy(false);
    }
  }

  return (
    <Modal title="Add an institute" onClose={onClose}>
      <div className="space-y-4">
        {!permanent && <Notice tone="info">You can use it right away. An Admin will review it before it is kept in the list.</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Name of the institute"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} /></Field>
        <Field label="City or state"><LocationPicker value={place} onChange={setPlace} /></Field>
        <Field label="Course it offers" hint="You can add more courses later.">
          <Select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">No course yet</option>
            {courses.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.level})</option>)}
          </Select>
        </Field>
        {courseId && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="How it is delivered">
              <Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="online">Online</option><option value="regular">Regular</option><option value="both">Both</option></Select>
            </Field>
            <Field label="Yearly fee in rupees (optional)"><Input inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void save()} loading={busy} disabled={name.trim().length < 2}>Add institute</Button>
      </div>
    </Modal>
  );
}
