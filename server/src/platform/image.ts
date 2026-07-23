/**
 * Image processing port.
 *
 * The same route code runs in two places: the Node server (sharp) and the Android
 * WebView worker (OffscreenCanvas). Neither implementation is importable from the
 * other's bundle, so the runtime installs its own at start-up.
 */

export type ImageProcessor = {
  /**
   * Re-encode a phone photo: apply EXIF orientation, strip metadata, fit inside
   * maxDim x maxDim (never enlarging), output webp.
   * Throws if the input is not a readable image.
   */
  toWebp(input: Uint8Array, maxDim: number): Promise<Uint8Array>;
};

let processor: ImageProcessor | null = null;

export function setImageProcessor(next: ImageProcessor): void {
  processor = next;
}

export function getImageProcessor(): ImageProcessor {
  if (!processor) {
    throw new Error('No image processor installed for this runtime (call setImageProcessor at boot).');
  }
  return processor;
}
