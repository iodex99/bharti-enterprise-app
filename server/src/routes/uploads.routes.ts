import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { activeDataDir } from '../db/dataDirs';
import { requireAuth, requireRole } from '../middleware/auth';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/**
 * POST /api/uploads (multipart field "image") → { path: "/uploads/2026-07/abc.webp" }
 * Phone photos are resized to 1600px, EXIF-stripped, re-encoded webp — years of photos
 * must not fill the office disk. Serving is auth-gated in app.ts.
 */
export function uploadsRoutes(): Router {
  const router = Router();

  router.post('/', requireRole('admin', 'operator'), upload.single('image'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided (field name: image).' });
      return;
    }
    const month = new Date().toISOString().slice(0, 7);
    const dir = path.join(activeDataDir(), 'uploads', month);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomBytes(8).toString('hex')}.webp`;
    try {
      await sharp(req.file.buffer)
        .rotate() // apply EXIF orientation, then strip metadata
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(path.join(dir, name));
    } catch {
      res.status(400).json({ error: 'File is not a readable image.' });
      return;
    }
    res.status(201).json({ path: `/uploads/${month}/${name}` });
  });

  return router;
}

/** Auth-gated static serving for /uploads/*. */
export function uploadsStatic(): Router {
  const router = Router();
  router.get('/{*splat}', requireAuth, (req, res) => {
    const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    const base = path.join(activeDataDir(), 'uploads');
    const full = path.normalize(path.join(base, rel));
    if (!full.startsWith(base) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.sendFile(full, { maxAge: '30d', immutable: true });
  });
  return router;
}
