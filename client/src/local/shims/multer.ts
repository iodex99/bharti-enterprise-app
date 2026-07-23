/**
 * `multer` shim.
 *
 * There is no HTTP wire inside the app: the page hands the worker a request object, and
 * a picked file travels as a structured-cloneable {buffer, originalname, mimetype} record
 * (see bridge.ts). So no multipart parsing is needed here — this shim only enforces the
 * same field-name and size rules the real middleware would, and shapes req.file
 * identically for the route code.
 */

export type ShimFile = {
  buffer: Uint8Array;
  originalname: string;
  mimetype: string;
  size: number;
  fieldname: string;
};

type Limits = { fileSize?: number; files?: number };
type Options = { storage?: unknown; limits?: Limits; fileFilter?: unknown };

type Req = { file?: ShimFile };
type Res = { status(code: number): { json(body: unknown): unknown } };
type Next = (err?: unknown) => void;

function multer(options: Options = {}) {
  const maxBytes = options.limits?.fileSize ?? Infinity;
  return {
    single(field: string) {
      return (req: Req, res: Res, next: Next): void => {
        const file = req.file;
        if (!file) {
          next();
          return;
        }
        if (file.fieldname && file.fieldname !== field) {
          delete req.file;
          next();
          return;
        }
        if (file.size > maxBytes) {
          res.status(400).json({ error: 'That file is too large.' });
          return;
        }
        next();
      };
    },
    array() {
      return (_req: Req, _res: Res, next: Next): void => next();
    },
    none() {
      return (_req: Req, _res: Res, next: Next): void => next();
    },
  };
}

multer.memoryStorage = () => ({ kind: 'memory' });
multer.diskStorage = (config: unknown) => ({ kind: 'disk', config });

export default multer;
