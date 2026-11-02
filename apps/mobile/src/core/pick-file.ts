import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

/** A file chosen on the phone, ready to upload. */
export interface PickedFile { uri: string; name: string; type: string; size?: number }

/** The photo is squeezed a little: a phone photo is often bigger than the upload limit. */
const PHOTO_QUALITY = 0.5;

const fromImage = (a: ImagePicker.ImagePickerAsset): PickedFile => ({
  uri: a.uri,
  name: a.fileName ?? `photo-${Date.now()}.jpg`,
  type: a.mimeType ?? 'image/jpeg',
  size: a.fileSize,
});

/** Opens the camera. Resolves to nothing if the person backs out; throws a plain message if the camera is not allowed. */
export async function takePhoto(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Allow camera access in the phone settings to take a photo.');
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: PHOTO_QUALITY });
  return res.canceled ? null : fromImage(res.assets[0]!);
}

/** Opens the photo gallery. */
export async function chooseImage(): Promise<PickedFile | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: PHOTO_QUALITY });
  return res.canceled ? null : fromImage(res.assets[0]!);
}

/** Opens the phone's file picker for a PDF or an image. */
export async function chooseDocument(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/jpeg', 'image/png'], copyToCacheDirectory: true });
  if (res.canceled) return null;
  const a = res.assets[0]!;
  return { uri: a.uri, name: a.name, type: a.mimeType ?? 'application/octet-stream', size: a.size };
}
