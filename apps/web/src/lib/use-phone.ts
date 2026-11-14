'use client';

import { useAuth } from './auth';
import { useApi } from './use-api';

/**
 * Whether the company has connected a calling provider. Until it has, the phone call buttons are hidden:
 * pressing them could only end in "calling is not set up", which looks broken in front of a client.
 */
export function usePhoneReady(): boolean {
  const { can } = useAuth();
  return useApi<{ ready: boolean }>(can('call.place') ? '/calls/ready' : null).data?.ready === true;
}
