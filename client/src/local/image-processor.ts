import type { ImageProcessor } from '../../../server/src/platform/image';

/**
 * WebView implementation of the image port — the counterpart of sharp on the Node host.
 *
 * createImageBitmap applies the EXIF orientation and hands back pixels only, so the
 * re-encoded webp carries no metadata (phone photos otherwise embed GPS coordinates).
 */
export const webviewImageProcessor: ImageProcessor = {
  async toWebp(input: Uint8Array, maxDim: number): Promise<Uint8Array> {
    const blob = new Blob([input.slice().buffer as ArrayBuffer]);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (err) {
      throw new Error('unreadable image', { cause: err });
    }
    try {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.drawImage(bitmap, 0, 0, width, height);
      let encoded: Blob;
      try {
        encoded = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
      } catch (err) {
        console.warn('[image] webp encoding unavailable, falling back to jpeg:', err);
        encoded = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      }
      return new Uint8Array(await encoded.arrayBuffer());
    } finally {
      bitmap.close();
    }
  },
};
