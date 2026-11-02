import { useCallback, useEffect, useState } from 'react';
import { errorText } from '@/core/use-api';
import { enablePush, sendTestAlert, type PushStatus } from '@/core/push';

type Notice = { tone: 'ok' | 'bad'; text: string };

/** The Phone alerts screen: whether this phone takes alerts, turning them on, and a test alert. */
export function usePushViewModel() {
  const [status, setStatus] = useState<PushStatus | 'checking'>('checking');
  const [busy, setBusy] = useState<'enable' | 'test' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const check = useCallback(async (ask: boolean) => {
    try {
      setStatus(await enablePush(ask));
    } catch (e) {
      setStatus('denied');
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }, []);

  // Look without asking: opening the screen should not pop up the phone's permission question.
  useEffect(() => { void check(false); }, [check]);

  async function enable() {
    setBusy('enable');
    setNotice(null);
    await check(true);
    setBusy(null);
  }

  async function test() {
    setBusy('test');
    setNotice(null);
    try {
      const phones = await sendTestAlert();
      setNotice({ tone: 'ok', text: phones === 1 ? 'A test alert was sent. It should appear in a moment.' : `A test alert was sent to ${phones} phones.` });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  return { status, busy, notice, enable, test };
}
