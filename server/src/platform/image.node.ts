import sharp from 'sharp';
import type { ImageProcessor } from './image';

/** Node/Express implementation of the image port (sharp). */
export const nodeImageProcessor: ImageProcessor = {
  async toWebp(input: Uint8Array, maxDim: number): Promise<Uint8Array> {
    const out = await sharp(input)
      .rotate() // apply EXIF orientation, then strip metadata
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
};
