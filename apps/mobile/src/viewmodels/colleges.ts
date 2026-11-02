import { useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { Place, CollegeCourse, CollegeItem, CourseItem, Page, Recommendation, Shortlist } from '@/models/types';

export type StudyMode = '' | 'online' | 'regular' | 'any';
export const MODES: { key: StudyMode; label: string }[] = [
  { key: '', label: 'Student preference' },
  { key: 'online', label: 'Online' },
  { key: 'regular', label: 'Regular' },
  { key: 'any', label: 'Any' },
];

export const rupees = (n: number | null) => (n === null ? '—' : `₹ ${n.toLocaleString('en-IN')}`);

/** The Colleges tab of one lead: find colleges, recommend them, and the list already recommended. */
export function useCollegesViewModel(leadId: string, onChanged: () => void) {
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<StudyMode>('');
  const [courseId, setCourseId] = useState('');
  const [place, setPlace] = useState<Place[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);

  const recommended = useApi<Recommendation[]>(`/leads/${leadId}/recommendations`);
  const courses = useApi<Page<CourseItem>>('/courses', useMemo(() => ({ limit: 100 }), []));
  const query = useMemo(() => ({ leadId, q: q || undefined, courseId: courseId || undefined, mode: mode || undefined, locationId: place[0]?.id, limit: 24 }), [leadId, q, courseId, mode, place]);
  const colleges = useApi<Page<CollegeItem>>('/colleges', query);
  const recommendedIds = new Set(recommended.data?.map((r) => r.college.id));

  async function recommend(collegeId: string) {
    setError(null);
    try {
      await api(`/leads/${leadId}/recommendations`, { method: 'POST', body: { collegeId } });
      recommended.reload();
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function unrecommend(collegeId: string) {
    setError(null);
    try {
      await api(`/leads/${leadId}/recommendations/${collegeId}`, { method: 'DELETE' });
      recommended.reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return { place, setPlace, typed, setTyped, mode, setMode, courseId, setCourseId, courses, colleges, recommended, recommendedIds, error, recommend, unrecommend, reloadRecommended: recommended.reload };
}

/** Choosing the courses a student wants at one college. Fees are read from the college, never typed. */
export function useCoursePickerViewModel(leadId: string, collegeId: string, existing: Shortlist | undefined, onDone: () => void) {
  const detail = useApi<{ courses: CollegeCourse[] }>(`/colleges/${collegeId}`);
  const [chosen, setChosen] = useState<Set<string>>(new Set(existing?.courses.map((c) => c.collegeCourseId) ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const courses = detail.data?.courses.filter((c) => c.isActive) ?? [];

  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const collegeCourseIds = [...chosen];
      if (existing) await api(`/leads/${leadId}/shortlists/${existing.id}`, { method: 'PATCH', body: { collegeCourseIds } });
      else await api(`/leads/${leadId}/shortlists`, { method: 'POST', body: { collegeId, collegeCourseIds } });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return { detail, courses, chosen, toggle, busy, error, save };
}
