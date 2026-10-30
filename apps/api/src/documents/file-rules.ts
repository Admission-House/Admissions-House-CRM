import { AppError } from '../common/app-error.js';

export interface FileKind {
  type: 'jpeg' | 'png' | 'pdf';
  mime: 'image/jpeg' | 'image/png' | 'application/pdf';
  ext: 'jpg' | 'png' | 'pdf';
  isImage: boolean;
}

const JPEG: FileKind = { type: 'jpeg', mime: 'image/jpeg', ext: 'jpg', isImage: true };
const PNG: FileKind = { type: 'png', mime: 'image/png', ext: 'png', isImage: true };
const PDF: FileKind = { type: 'pdf', mime: 'application/pdf', ext: 'pdf', isImage: false };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What a file really is, from its first bytes. The name a person gave it, and the type their
 * browser claimed, are ignored: both are chosen by whoever uploads, so neither proves anything.
 * Returns null for anything that is not a JPEG, PNG or PDF.
 */
export function sniffFile(data: Buffer): FileKind | null {
  if (data.length < 16) return null;

  // JPEG: FF D8 FF, then a marker byte (E0-EF application data, DB tables, C0-CF frame, FE comment).
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff && (data[3]! >= 0xc0 || data[3] === 0xdb)) return JPEG;

  // PNG: the 8-byte signature, then an IHDR chunk 13 bytes long.
  if (data.subarray(0, 8).equals(PNG_SIGNATURE) && data.readUInt32BE(8) === 13 && data.subarray(12, 16).toString('latin1') === 'IHDR') return PNG;

  // PDF: the header at the very start, and an end marker near the end (a cut-off upload has none).
  if (/^%PDF-[12]\.\d/.test(data.subarray(0, 8).toString('latin1')) && data.subarray(Math.max(0, data.length - 1024)).includes('%%EOF')) return PDF;

  return null;
}

/** Parts of a PDF that run code, open things on their own, or carry other files. */
const ACTIVE_PDF_NAMES = ['JavaScript', 'JS', 'Launch', 'OpenAction', 'AA', 'EmbeddedFile', 'RichMedia', 'XFA', 'SubmitForm', 'ImportData'];

/**
 * A reason to refuse a PDF, or null. A document a student uploads has no need to run anything, so a
 * PDF that names active content is refused. This reads names that sit in the file as plain text
 * (undoing the #XX hiding trick); content packed inside compressed streams cannot be seen here, so
 * this reduces risk and does not replace an antivirus scan on the server.
 */
export function pdfProblem(data: Buffer): string | null {
  const text = data.toString('latin1').replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  for (const name of ACTIVE_PDF_NAMES) {
    if (new RegExp(`/${name}(?![A-Za-z])`).test(text)) return `The PDF contains active content (/${name})`;
  }
  return null;
}

/**
 * The name shown to people for a file: no folders, no odd characters, never more than 80
 * characters, and always ending in the extension of what the file really is.
 */
export function displayName(original: string, ext: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  const withoutExt = base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const cleaned = withoutExt
    .normalize('NFKC')
    // Letters, the marks that go with them (vowel signs in Hindi and other scripts), and digits.
    .replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s-]+|[\s.]+$/g, '')
    .slice(0, 80)
    .trim();
  return `${cleaned || 'document'}.${ext}`;
}

// -------------------------------------------------------------------- document kinds

export const BASIC_DOCUMENTS = ['aadhaar', 'tenth', 'twelfth', 'graduation', 'photo', 'signature'] as const;
export const DOC_TYPES = [...BASIC_DOCUMENTS, 'admission', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/**
 * What goes with what. An admission document belongs to an institute the student shortlisted; a
 * basic document belongs to the student; a photo or signature must be a picture.
 */
export function assertDocumentRules(d: { docType: DocType; hasShortlist: boolean; kind: FileKind }): void {
  const bad = (code: string, field: string, message: string) => AppError.badRequest(code, message, [{ field, message }]);

  if (d.docType === 'admission' && !d.hasShortlist) {
    throw bad('SHORTLIST_REQUIRED', 'shortlistId', 'An admission document belongs to a shortlisted institute');
  }
  if ((BASIC_DOCUMENTS as readonly string[]).includes(d.docType) && d.hasShortlist) {
    throw bad('SHORTLIST_NOT_ALLOWED', 'shortlistId', 'This kind of document belongs to the student, not to an institute');
  }
  if ((d.docType === 'photo' || d.docType === 'signature') && !d.kind.isImage) {
    throw bad('IMAGE_REQUIRED', 'file', `A ${d.docType} must be a JPEG or PNG picture`);
  }
}
