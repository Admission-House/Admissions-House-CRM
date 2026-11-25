import { describe, expect, it } from 'vitest';
import { greetingFor, joinMessage, whatsappLink, type GuestInfo } from './communications';

const info = (over: Partial<GuestInfo> = {}): GuestInfo => ({
  companyName: 'Admissions House',
  hostName: 'Khushi Khuswah',
  guestName: 'Rahul Sharma',
  kind: 'video',
  title: null,
  ended: false,
  ...over,
});

describe("the WhatsApp message that carries a student's link", () => {
  it('says who is writing and from where, and puts the link on its own line', () => {
    const text = joinMessage({
      guest: 'Rahul Sharma',
      host: 'Khushi Khuswah',
      company: 'Admissions House',
      kind: 'video',
      link: 'https://crm.example/meet/abc',
    });
    expect(text).toBe(
      'Hello Rahul, this is Khushi from Admissions House. Please open this link to join your counselling video call:\nhttps://crm.example/meet/abc',
    );
  });
  it('names the person who sends it, and says voice for a voice call', () => {
    expect(
      joinMessage({
        guest: 'Aman',
        host: 'Meenakshi Bhardwaj',
        company: 'Admissions House',
        kind: 'voice',
        link: 'L',
      }),
    ).toContain('this is Meenakshi from');
    expect(
      joinMessage({
        guest: 'Aman',
        host: 'Meenakshi',
        company: 'Admissions House',
        kind: 'voice',
        link: 'L',
      }),
    ).toContain('counselling voice call');
  });
  it('still reads well when a name or the company is missing', () => {
    const text = joinMessage({ guest: '', host: '', company: '', kind: 'video', link: 'L' });
    expect(text).toBe(
      'Hello there, this is your counsellor from Admissions House. Please open this link to join your counselling video call:\nL',
    );
  });
  it('copes with extra spaces in a name', () => {
    expect(
      joinMessage({
        guest: '  Rahul   Sharma ',
        host: ' Khushi  K',
        company: 'AH',
        kind: 'video',
        link: 'L',
      }),
    ).toContain('Hello Rahul, this is Khushi from AH.');
  });
});

describe("the words on the student's page before joining", () => {
  it('greets the student by first name and names the counsellor and the company', () => {
    const g = greetingFor(info());
    expect(g.title).toBe('Hello Rahul, your counselling session is ready');
    expect(g.text).toContain(
      'Khushi Khuswah from Admissions House is waiting for you on a video call',
    );
    expect(g.text).toContain('microphone and camera');
    expect(g).toMatchObject({ company: 'Admissions House', closed: false });
  });
  it('asks only for the microphone on a voice call', () => {
    const g = greetingFor(info({ kind: 'voice' }));
    expect(g.text).toContain('voice call');
    expect(g.text).not.toContain('camera');
  });
  it('does not offer to join when the call is over, and says whom to ask', () => {
    const g = greetingFor(info({ ended: true }));
    expect(g).toMatchObject({ title: 'This session has ended', closed: true });
    expect(g.text).toContain('Khushi Khuswah');
  });
  it('says the link is not valid, without saying why, for a wrong or cancelled link', () => {
    const g = greetingFor('invalid');
    expect(g).toMatchObject({ title: 'This link is not valid', closed: true });
    expect(g.text).toMatch(/ask for a new one/);
  });
  it('shows a plain welcome while the answer is still coming, or if it could not be fetched', () => {
    expect(greetingFor(null)).toMatchObject({
      title: 'You are invited to a session',
      closed: false,
      company: 'Admissions House',
    });
  });
  it('falls back to "there" and the default company when names are empty', () => {
    const g = greetingFor(info({ guestName: '', companyName: '' }));
    expect(g.title).toBe('Hello there, your counselling session is ready');
    expect(g.company).toBe('Admissions House');
  });
});

describe('a WhatsApp link', () => {
  it('goes to the number with the text filled in, and keeps only the digits of the number', () => {
    expect(whatsappLink('+91 98765-43210', 'Hello & welcome')).toBe(
      'https://wa.me/919876543210?text=Hello%20%26%20welcome',
    );
  });
  it('goes to the number alone when there is no text', () => {
    expect(whatsappLink('919876543210')).toBe('https://wa.me/919876543210');
  });
  it('lets the person pick the chat when there is no number', () => {
    expect(whatsappLink(null, 'Hi')).toBe('https://wa.me/?text=Hi');
    expect(whatsappLink(undefined)).toBe('https://wa.me/');
  });
});
