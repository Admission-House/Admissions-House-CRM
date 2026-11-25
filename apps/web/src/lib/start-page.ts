/** The pages a person can choose to open after signing in, and where each one lives. The API checks they may open it. */
export const START_PAGE_PATHS = {
  dashboard: '/dashboard',
  leads: '/leads',
  communications: '/communications',
  reports: '/reports',
  attendance: '/attendance',
} as const;

export type StartPageKey = keyof typeof START_PAGE_PATHS;

export const START_PAGE_LABELS: Record<StartPageKey, string> = {
  dashboard: 'Dashboard',
  leads: 'All leads',
  communications: 'Calls and meetings',
  reports: 'Reports',
  attendance: 'Attendance',
};

/** Where to go after signing in. Anything unknown (an old or edited value) falls back to the dashboard. */
export function homePath(startPage: string | null | undefined): string {
  return startPage && Object.prototype.hasOwnProperty.call(START_PAGE_PATHS, startPage)
    ? START_PAGE_PATHS[startPage as StartPageKey]
    : '/dashboard';
}
