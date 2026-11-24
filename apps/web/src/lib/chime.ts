/**
 * A short two-note chime for a new notification, made by the browser itself (no sound file to load). Browsers allow
 * sound only after the person has clicked or typed on the page once, so the audio is unlocked on the first such input.
 * Muting is a setting of this browser for this person (kept in localStorage); it is read every time, so all open tabs agree.
 */
const MUTE_KEY = 'ah-notify-muted';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Call once when the app starts: the first click or key press makes sound possible. */
export function unlockChimeOnFirstInput(): () => void {
  const unlock = () => {
    void audio()?.resume().catch(() => undefined);
    remove();
  };
  const remove = () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
  return remove;
}

export function isChimeMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setChimeMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, '1');
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    /* private window: the choice lasts only for this page */
  }
}

/** Plays the chime unless muted. Quietly does nothing where the browser does not allow sound yet. */
export function playChime(): void {
  if (isChimeMuted()) return;
  const a = audio();
  if (!a || a.state !== 'running') return;
  const now = a.currentTime;
  const notes: [number, number][] = [[880, 0], [1320, 0.14]];
  for (const [freq, at] of notes) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
    osc.connect(gain).connect(a.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.4);
  }
}
