import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/connection';
import { getImageProcessor } from '../platform/image';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_MAX_DIM,
  readUpload,
  storeUpload,
} from '../services/uploads.service';
import { requireAuth, requireRole } from '../middleware/auth';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/**
 * POST /api/uploads (multipart field "image") → { path: "/uploads/2026-07/abc.webp" }
 * Phone photos are resized to 1600px, EXIF-stripped and re-encoded webp before storage —
 * years of full-resolution photos would otherwise bloat the database.
 */
export function uploadsRoutes(): Router {
  const router = Router();

  router.post('/', requireRole('admin', 'operator'), upload.single('image'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided (field name: image).' });
      return;
    }
    // Resolved outside the try: a missing processor is a runtime wiring fault, not a
    // bad photo, and must not be reported to the user as one.
    const processor = getImageProcessor();
    let webp: Uint8Array;
    try {
      // async work happens BEFORE the write — never inside a db transaction
      webp = await processor.toWebp(req.file.buffer, UPLOAD_MAX_DIM);
    } catch {
      res.status(400).json({ error: 'File is not a readable image.' });
      return;
    }
    const stored = storeUpload(getDb(), webp, req.user?.id ?? null);
    res.status(201).json({ path: stored });
  });

  return router;
}

/** Auth-gated serving for /uploads/*. Bytes come from the database (migration 003). */
export function uploadsStatic(): Router {
  const router = Router();
  router.get('/{*splat}', requireAuth, (req, res) => {
    const found = readUpload(getDb(), `/uploads${decodeURIComponent(req.path)}`);
    if (!found) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Content-Type', found.mime);
    // content is immutable — the filename carries 8 random bytes
    res.setHeader('Cache-Control', 'private, max-age=2592000, immutable');
    res.send(Buffer.from(found.bytes));
  });
  return router;
}
