/** Shapes the API returns, as the screens use them (same as the web CRM). */

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface Me {
  user: { id: string; name: string; email: string; role: { key: string | null; dataScope: 'all' | 'team' | 'own' }; mustChangePassword: boolean };
  permissions: string[];
  company: { name: string; productName: string; contactEmail: string | null; brandColor: string | null; accentColor: string | null; hasLogo: boolean };
}

export interface StatusRef { id: string; name: string; queue: string; isOpen: boolean }

export interface LeadListItem {
  id: string; leadNo: string; name: string; phone: string; email: string | null;
  intent: 'hot' | 'warm' | 'cold' | null; studyMode: 'online' | 'regular' | null;
  status: StatusRef; queue: string; source: { id: string; name: string };
  assignedTo: { id: string; name: string } | null; nextFollowupAt: string | null;
  expectedClosureOn: string | null; interestNote: string | null; createdAt: string; updatedAt: string;
}

export interface LeadDetail {
  id: string; leadNo: string; name: string; phone: string; email: string | null;
  intent: 'hot' | 'warm' | 'cold' | null; studyMode: 'online' | 'regular' | null;
  expectedClosureOn: string | null; interestNote: string | null;
  status: { id: string; name: string; queue: string; isOpen: boolean; requiresFollowup: boolean };
  substatus: { id: string; name: string } | null; source: { id: string; name: string };
  assignedTo: { id: string; name: string } | null; assignedAt: string | null;
  nextFollowupAt: string | null; firstCalledAt: string | null; openFollowUps: number;
  createdBy: string | null; createdAt: string; updatedAt: string;
  extraPhones: { phone: string; label: string }[];
}

export interface Queues { queues: Record<string, number>; unassigned: number; dueToday: number; total: number }

export interface StatusOption {
  id: string; name: string; queue: string; isOpen: boolean; requiresFollowup?: boolean; isActive?: boolean;
  substatuses?: { id: string; name: string }[];
}

export interface LeadFollowUp { id: string; dueAt: string; note: string | null; doneAt: string | null; owner: { id: string; name: string } }

export interface FollowUp {
  id: string; dueAt: string; remindBeforeMin: number; note: string | null; doneAt: string | null;
  owner: { id: string; name: string };
  lead: { id: string; leadNo: string; name: string; phone: string; status: string; isOpen: boolean };
}

export interface Activity {
  id: string; type: string; field: string | null; oldValue: string | null; newValue: string | null;
  remark: string | null; user: { id: string; name: string } | null; createdAt: string;
}

export interface Dashboard {
  queues: Record<string, number>; unassigned: number; dueToday: number; total: number;
  byStatus: { status: string; leads: number }[];
  today: { calls: { total: number; connected: number; missed: number; talkSec: number }; overdueFollowUps: number };
}

export interface Today {
  tracked: boolean; checkedIn?: boolean;
  record?: { checkInAt: string; checkOutAt: string | null; lateMinutes: number } | null;
  onBreak?: { startedAt: string; type: { name: string; allowedMinutes: number } } | null;
  breakMinutesToday?: number;
  shift?: { start: string; end: string; idleTimeoutMin: number } | null;
}
export interface BreakType { id: string; name: string; allowedMinutes: number }

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export interface LeaveType { id: string; name: string; isPaid: boolean; yearlyQuota: number; isActive: boolean }
export interface LeaveRequest {
  id: string; user: { id: string; name: string }; leaveType: { id: string; name: string; isPaid: boolean };
  fromDate: string; toDate: string; days: number; reason: string | null; status: LeaveStatus;
}
export interface Balances {
  year: number;
  balances: { leaveType: { id: string; name: string; isPaid: boolean }; yearlyQuota: number; remaining: number; pending: number; available: number | null }[];
}

export interface Salary {
  id: string; month: string; basePay: number; allowances: number; deductions: number; netPay: number; notes: string | null; enteredBy: string;
}

export interface AppNotification { id: string; type: string; payload: Record<string, unknown>; readAt: string | null; createdAt: string }

export type CallOutcome = 'connected' | 'missed' | 'not_picked' | 'busy' | 'failed' | 'ringing' | 'requested';
export interface Call {
  id: string; direction: 'incoming' | 'outgoing'; number: string; startedAt: string; durationSec: number | null; outcome: CallOutcome | string;
  user: { id: string; name: string } | null; wrappedUp: boolean; remark: string | null; recording: 'none' | 'pending' | 'stored' | 'failed';
  lead: { id: string; leadNo: string; name: string } | null;
}

export interface DialerLead { leadId: string; leadNo: string; name: string; phone: string; state: 'pending' | 'called' | 'skipped' }
export interface DialerSession {
  id: string; status: 'running' | 'paused' | 'stopped' | 'finished'; user: { id: string; name: string }; startedAt: string; endedAt: string | null;
  counts: { total: number; pending: number; called: number; skipped: number };
  current: DialerLead | null; leads?: DialerLead[];
}

export interface CourseItem { id: string; name: string; level: string; isActive: boolean }
export interface CollegeItem {
  id: string; name: string; location: { id: string; name: string; state: string | null } | null;
  courseCount: number; offersOnline: boolean; offersRegular: boolean;
}
export interface CollegeCourse {
  id: string; course: { id: string; name: string; level: string; stream: string | null }; deliveryMode: string;
  cafFee: number | null; annualFee: number | null; durationYears: number | null; isActive: boolean;
}
export interface Recommendation { college: { id: string; name: string; location: string | null }; recommendedBy: string | null; at: string; shortlisted: boolean }

export type FormStatus = 'not_started' | 'filled' | 'submitted';
export type ReconciliationStatus = 'not_sent' | 'mail_sent' | 'reconciled';
export interface Shortlist {
  id: string; college: { id: string; name: string; location: string | null };
  formStatus: FormStatus; reconciliationStatus: ReconciliationStatus;
  payment: { status: string; amount: number | null; paidAt: string | null };
  niDnp: { kind: 'ni' | 'dnp'; reason: string | null } | null;
  courses: { collegeCourseId: string; course: { id: string; name: string; level: string }; deliveryMode: string; cafFee: number | null; annualFee: number | null; durationYears: number | null }[];
  shortlistedBy: string | null; createdAt: string;
}
export type ShortlistView = 'active' | 'ni_dnp' | 'reconciled';

export interface Place { id: string; name: string; type?: string; state?: string | null }
export interface Profile {
  personal: {
    alternateEmail: string | null; dateOfBirth: string | null; gender: string | null; category: string | null;
    currentLocation: Place | null; extraPhones: { phone: string; label: string }[];
  };
  preferences: {
    studyMode: string | null; preferredYear: number | null; preferredLevel: string | null; preferredStream: { id: string; name: string } | null;
    budgetMin: number | null; budgetMax: number | null; loanRequired: boolean | null; preferredLocations: Place[];
  };
  guardians: { relation: string; name: string | null; phone: string | null; occupation: string | null }[];
  education: { level: string; marksType: string | null; marks: number | null; institution: string | null; board: string | null; passingYear: number | null }[];
  exams: { examName: string; marksType: string | null; score: number | null; examYear: number | null }[];
  updatedAt: string | null; updatedBy: string | null;
}

export interface LeadDocument {
  id: string; docType: string; shortlist: { id: string; college: string } | null; name: string; mimeType: string;
  sizeBytes: number; uploadedBy: string | null; createdAt: string;
}
export interface DocumentLimits { maxBytes: number; accepts: string[]; imageOnly: string[] }
