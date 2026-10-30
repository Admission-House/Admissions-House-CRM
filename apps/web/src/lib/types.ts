/** Shapes the API returns, as the screens use them. */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface StatusRef {
  id: string;
  name: string;
  queue: string;
  isOpen: boolean;
}

export interface LeadListItem {
  id: string;
  leadNo: string;
  name: string;
  phone: string;
  email: string | null;
  intent: 'hot' | 'warm' | 'cold' | null;
  studyMode: 'online' | 'regular' | null;
  status: StatusRef;
  queue: string;
  source: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
  nextFollowupAt: string | null;
  expectedClosureOn: string | null;
  interestNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Queues {
  queues: Record<string, number>;
  unassigned: number;
  dueToday: number;
  total: number;
}

export interface StatusOption {
  id: string;
  name: string;
  queue: string;
  isOpen: boolean;
  requiresFollowup?: boolean;
  isActive?: boolean;
  substatuses?: { id: string; name: string }[];
}

export interface SourceOption {
  id: string;
  name: string;
  isActive?: boolean;
}

export interface UserOption {
  id: string;
  name: string;
}
