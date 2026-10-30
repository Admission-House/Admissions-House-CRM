import { checkRecordingUrl, isPrivateAddress, sniffAudio } from './recording-rules.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '172.15.0.1', '172.32.0.1', '203.0.113.5', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('treats %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('checkRecordingUrl', () => {
  const hosts = ['recordings.example.com'];

  it('accepts an https address on an allowed host', () => {
    const v = checkRecordingUrl('https://Recordings.Example.com/a/b.mp3?token=1', hosts);
    expect(v.ok).toBe(true);
  });

  it.each([
    ['plain http', 'http://recordings.example.com/a.mp3'],
    ['another host', 'https://evil.example.com/a.mp3'],
    ['a sub-domain of an allowed host', 'https://x.recordings.example.com/a.mp3'],
    ['a look-alike host', 'https://recordings.example.com.evil.com/a.mp3'],
    ['a login in the address', 'https://user:pass@recordings.example.com/a.mp3'],
    ['another port', 'https://recordings.example.com:8443/a.mp3'],
    ['an IP address', 'https://127.0.0.1/a.mp3'],
    ['a file address', 'file:///etc/passwd'],
    ['nonsense', 'not a url'],
  ])('refuses %s', (_name, url) => {
    expect(checkRecordingUrl(url, hosts).ok).toBe(false);
  });

  it('allows plain http and other ports only when told this is a test', () => {
    expect(checkRecordingUrl('http://127.0.0.1:8123/a.mp3', ['127.0.0.1'], true).ok).toBe(true);
    expect(checkRecordingUrl('http://127.0.0.1:8123/a.mp3', ['127.0.0.1'], false).ok).toBe(false);
  });
});

describe('sniffAudio', () => {
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(32)]);

  it('knows the common audio formats by their first bytes', () => {
    expect(sniffAudio(pad(Buffer.from('ID3\u0004')))).toMatchObject({ ext: 'mp3', mime: 'audio/mpeg' });
    expect(sniffAudio(pad(Buffer.from([0xff, 0xfb, 0x90])))).toMatchObject({ ext: 'mp3' });
    expect(sniffAudio(pad(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')))).toMatchObject({ ext: 'wav', mime: 'audio/wav' });
    expect(sniffAudio(pad(Buffer.from('OggS')))).toMatchObject({ ext: 'ogg' });
    expect(sniffAudio(pad(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')])))).toMatchObject({ ext: 'm4a', mime: 'audio/mp4' });
  });

  it('refuses everything else, whatever it is called', () => {
    expect(sniffAudio(pad(Buffer.from('<html><script>')))).toBeNull();
    expect(sniffAudio(pad(Buffer.from('%PDF-1.7')))).toBeNull();
    expect(sniffAudio(pad(Buffer.from('MZ')))).toBeNull();
    expect(sniffAudio(Buffer.from('ID3'))).toBeNull(); // too short to tell
    expect(sniffAudio(Buffer.alloc(0))).toBeNull();
  });
});
