import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { apiFile } from './api';

/** A file name that is safe on any phone: letters, digits, dot, dash and underscore only. */
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'document';

/**
 * Downloads a file from the API (with the person's sign-in) into the app's private cache and opens the
 * phone's share sheet, from where it can be viewed, saved or sent. The file is replaced on the next download.
 */
export async function shareFile(path: string, fallbackName: string, mimeType: string, dialogTitle: string): Promise<void> {
  const { bytes, fileName } = await apiFile(path);
  const file = new File(Paths.cache, safeName(fileName ?? fallbackName));
  file.create({ overwrite: true });
  await file.write(new Uint8Array(bytes));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone cannot open or share files.');
  await Sharing.shareAsync(file.uri, { mimeType, ...(mimeType === 'application/pdf' && { UTI: 'com.adobe.pdf' }), dialogTitle });
}

export const sharePdf = (path: string, fallbackName: string, dialogTitle: string) => shareFile(path, fallbackName, 'application/pdf', dialogTitle);
