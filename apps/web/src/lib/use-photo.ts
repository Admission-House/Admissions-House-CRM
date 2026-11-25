'use client';

import { useEffect, useState } from 'react';
import { apiRaw } from './api';

// One picture per person and version, kept for the life of the page, so a face drawn in ten places is fetched once.
const cache = new Map<string, Promise<string | null>>();

function load(userId: string, version: number): Promise<string | null> {
  const key = `${userId}:${version}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = apiRaw(`/users/${userId}/avatar`)
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null);
    cache.set(key, hit);
  }
  return hit;
}

/** The address of a person's photo, or null while loading, when they have none, or when it cannot be fetched. */
export function usePhoto(
  userId: string | undefined,
  version: number | null | undefined,
): string | null {
  const [shown, setShown] = useState<{ key: string; src: string | null } | null>(null);
  const key = userId && version ? `${userId}:${version}` : null;
  useEffect(() => {
    if (!userId || !version) return;
    let live = true;
    void load(userId, version).then(
      (src) => live && setShown({ key: `${userId}:${version}`, src }),
    );
    return () => {
      live = false;
    };
  }, [userId, version]);
  return key && shown?.key === key ? shown.src : null;
}

/** The biggest picture a person may choose from their device. It is shrunk before it is sent, so only a few KB travel. */
export const MAX_CHOSEN_BYTES = 5 * 1024 * 1024;
const SIDE = 192;
const LIMIT = 60 * 1024;

/**
 * Shrinks a chosen picture to a small square JPEG (cropped from the middle), small enough to store. Doing it here
 * means a large phone photo is never uploaded, and the server only has to accept a few kilobytes.
 */
export async function shrinkPicture(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type))
    throw new Error('Choose a JPEG, PNG or WebP picture.');
  if (file.size > MAX_CHOSEN_BYTES)
    throw new Error('This picture is larger than 5 MB. Choose a smaller one.');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This picture cannot be opened. Try another one.');
  });
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot prepare the picture.');
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIDE, SIDE);
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIDE,
    SIDE,
  );
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if ((url.length * 3) / 4 <= LIMIT) return url;
  }
  throw new Error('The picture is too detailed. Choose a simpler one.');
}
