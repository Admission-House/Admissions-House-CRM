import { AppError } from '../common/app-error.js';
import { assertDocumentRules, displayName, FileKind, pdfProblem, sniffFile } from './file-rules.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_AN_APP_ERROR';
  }
  return undefined;
};

const filler = (n: number) => Buffer.alloc(n, 0x20);
export const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), filler(60), Buffer.from([0xff, 0xd9])]);
export const png = () => {
  const header = Buffer.alloc(8 + 4 + 4 + 13);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  return Buffer.concat([header, filler(40)]);
};
export const pdf = (body = '1 0 obj << /Type /Catalog >> endobj') => Buffer.from(`%PDF-1.4\n${body}\ntrailer << >>\n%%EOF\n`);

describe('sniffFile', () => {
  it('recognises a JPEG, a PNG and a PDF by their first bytes', () => {
    expect(sniffFile(jpeg())).toMatchObject({ type: 'jpeg', mime: 'image/jpeg', ext: 'jpg', isImage: true });
    expect(sniffFile(png())).toMatchObject({ type: 'png', mime: 'image/png', ext: 'png', isImage: true });
    expect(sniffFile(pdf())).toMatchObject({ type: 'pdf', mime: 'application/pdf', ext: 'pdf', isImage: false });
  });

  it.each([
    ['plain text', Buffer.from('hello, this is just a text file pretending')],
    ['a Windows program', Buffer.concat([Buffer.from('MZ'), filler(64)])],
    ['a script', Buffer.from('#!/bin/sh\nrm -rf /\n' + ' '.repeat(40))],
    ['an HTML page', Buffer.from('<html><script>alert(1)</script></html>' + ' '.repeat(20))],
    ['a GIF', Buffer.concat([Buffer.from('GIF89a'), filler(40)])],
    ['a zip archive', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), filler(40)])],
    ['an SVG picture', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')],
    ['something too short', Buffer.from([0xff, 0xd8, 0xff])],
    ['nothing', Buffer.alloc(0)],
  ])('refuses %s', (_n, data) => {
    expect(sniffFile(data)).toBeNull();
  });

  it('refuses a PDF that was cut off, or that does not start with the header', () => {
    expect(sniffFile(Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n' + ' '.repeat(40)))).toBeNull();
    expect(sniffFile(Buffer.concat([Buffer.from('junk\n'), pdf()]))).toBeNull();
  });

  it('refuses a PNG with a damaged first chunk and a JPEG with no marker', () => {
    const broken = png();
    broken.write('XXXX', 12, 'latin1');
    expect(sniffFile(broken)).toBeNull();
    expect(sniffFile(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x01]), filler(40)]))).toBeNull();
  });
});

describe('pdfProblem', () => {
  it('accepts an ordinary PDF', () => {
    expect(pdfProblem(pdf())).toBeNull();
    expect(pdfProblem(pdf('/Title (A JavaScript tutorial) /Pages 1'))).toBeNull(); // the word in text is not a name
  });

  it.each([
    ['/JavaScript (app.alert(1))', '/JavaScript'],
    ['/S /JavaScript /JS (x)', '/JavaScript'],
    ['/OpenAction << /S /GoTo >>', '/OpenAction'],
    ['/Launch << /F (cmd.exe) >>', '/Launch'],
    ['/AA << /O 5 0 R >>', '/AA'],
    ['/EmbeddedFile', '/EmbeddedFile'],
    ['/RichMedia', '/RichMedia'],
    ['/J#61vaScript', '/JavaScript'], // a name hidden with a #XX escape
  ])('refuses active content: %s', (body, expected) => {
    expect(pdfProblem(pdf(body))).toContain(expected);
  });
});

describe('displayName', () => {
  it.each([
    ['aadhaar.jpg', 'jpg', 'aadhaar.jpg'],
    ['Riya Sharma 10th marksheet.PDF', 'pdf', 'Riya Sharma 10th marksheet.pdf'],
    ['../../etc/passwd', 'jpg', 'passwd.jpg'],
    ['C:\\Users\\x\\secret photo.png', 'png', 'secret photo.png'],
    ['.hidden', 'png', 'hidden.png'],
    ['evil.php.jpg', 'jpg', 'evil.php.jpg'],
    ['<script>alert(1)</script>.pdf', 'pdf', 'script.pdf'], // everything up to the last slash is taken for a folder
    ['<b>bold</b>.pdf', 'pdf', 'b.pdf'],
    ['report<1>.jpg', 'jpg', 'report1.jpg'],
    ['', 'jpg', 'document.jpg'],
    ['....', 'png', 'document.png'],
    ['सिया का आधार.jpg', 'jpg', 'सिया का आधार.jpg'],
  ])('%j becomes %j', (original, ext, expected) => {
    expect(displayName(original, ext as FileKind['ext'])).toBe(expected);
  });

  it('replaces a wrong extension with the real one', () => {
    expect(displayName('photo.exe', 'png')).toBe('photo.png');
  });

  it('keeps names short', () => {
    expect(displayName('x'.repeat(500) + '.jpg', 'jpg')).toHaveLength(84);
  });

  it('never contains a path separator or control character', () => {
    for (const nasty of ['a/b\\c', 'tab\there', 'line\nbreak', 'nul\0byte']) {
      expect(displayName(nasty, 'pdf')).toMatch(/^[^/\\\u0000-\u001f]+$/);
    }
  });
});

describe('assertDocumentRules', () => {
  const image: FileKind = { type: 'jpeg', mime: 'image/jpeg', ext: 'jpg', isImage: true };
  const doc: FileKind = { type: 'pdf', mime: 'application/pdf', ext: 'pdf', isImage: false };

  it('wants an admission document to belong to a shortlisted institute, and nothing else to', () => {
    expect(codeOf(() => assertDocumentRules({ docType: 'admission', hasShortlist: false, kind: doc }))).toBe('SHORTLIST_REQUIRED');
    expect(codeOf(() => assertDocumentRules({ docType: 'admission', hasShortlist: true, kind: doc }))).toBeUndefined();
    for (const docType of ['aadhaar', 'tenth', 'twelfth', 'graduation', 'photo', 'signature'] as const) {
      expect(codeOf(() => assertDocumentRules({ docType, hasShortlist: true, kind: image }))).toBe('SHORTLIST_NOT_ALLOWED');
    }
  });

  it('lets "other" go either way', () => {
    expect(codeOf(() => assertDocumentRules({ docType: 'other', hasShortlist: true, kind: doc }))).toBeUndefined();
    expect(codeOf(() => assertDocumentRules({ docType: 'other', hasShortlist: false, kind: doc }))).toBeUndefined();
  });

  it('wants a photo and a signature to be pictures, and lets certificates be either', () => {
    expect(codeOf(() => assertDocumentRules({ docType: 'photo', hasShortlist: false, kind: doc }))).toBe('IMAGE_REQUIRED');
    expect(codeOf(() => assertDocumentRules({ docType: 'signature', hasShortlist: false, kind: doc }))).toBe('IMAGE_REQUIRED');
    expect(codeOf(() => assertDocumentRules({ docType: 'photo', hasShortlist: false, kind: image }))).toBeUndefined();
    expect(codeOf(() => assertDocumentRules({ docType: 'tenth', hasShortlist: false, kind: doc }))).toBeUndefined();
    expect(codeOf(() => assertDocumentRules({ docType: 'tenth', hasShortlist: false, kind: image }))).toBeUndefined();
  });
});
