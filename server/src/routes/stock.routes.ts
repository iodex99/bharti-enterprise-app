import { Router } from 'express';
import { STAGES, type Stage } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { stockByDimensions } from '../services/ledger.service';

export function stockRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  /** Summary counts per stage for the inventory landing page / dashboard. */
  router.get('/summary', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT stage, SUM(qty) AS qty, COUNT(DISTINCT model_id || '-' || color_id || '-' || COALESCE(size_id, 0)) AS combos
         FROM stock_ledger GROUP BY stage`,
      )
      .all() as Array<{ stage: Stage; qty: number; combos: number }>;
    const byStage = Object.fromEntries(rows.map((r) => [r.stage, { qty: r.qty, combos: r.combos }]));
    res.json({ stages: STAGES.map((s) => ({ stage: s, qty: byStage[s]?.qty ?? 0, combos: byStage[s]?.combos ?? 0 })) });
  });

  /** RAW stock with per-purchase lot detail — raw cloth carries NO model (view by color/vendor). */
  router.get('/raw', (req, res) => {
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    const vendorId = num(req.query.vendorId);
    const where: string[] = ["l.stage = 'RAW'"];
    const params: unknown[] = [];
    if (num(req.query.colorId)) {
      where.push('l.color_id = ?');
      params.push(num(req.query.colorId));
    }
    if (vendorId) {
      where.push("(l.lot_type != 'purchase' OR p.vendor_id = ?)");
      params.push(vendorId);
      // vendor filter only makes sense for purchase lots; opening lots drop out
      where.push("l.lot_type = 'purchase'");
    }
    const lots = getDb()
      .prepare(
        `SELECT l.lot_type AS lotType, l.lot_id AS lotId,
                l.color_id AS colorId, c.name AS colorName,
                p.doc_no AS purchaseDocNo, p.purchase_date AS purchaseDate,
                v.id AS vendorId, v.name AS vendorName,
                o.doc_no AS openingDocNo,
                SUM(l.qty) AS qtyCm
         FROM stock_ledger l
         JOIN colors c ON c.id = l.color_id
         LEFT JOIN purchases p ON l.lot_type = 'purchase' AND p.id = l.lot_id
         LEFT JOIN vendors v ON v.id = p.vendor_id
         LEFT JOIN opening_balances o ON l.lot_type = 'opening' AND o.id = l.lot_id
         WHERE ${where.join(' AND ')}
         GROUP BY l.lot_type, l.lot_id
         HAVING SUM(l.qty) > 0
         ORDER BY c.name, l.lot_id`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    res.json({ lots });
  });

  /** Generic per-stage stock grouped by dimensions. */
  router.get('/:stage', (req, res) => {
    const stage = String(req.params.stage).toUpperCase() as Stage;
    if (!STAGES.includes(stage)) {
      res.status(404).json({ error: 'Unknown stage.' });
      return;
    }
    const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
    res.json({
      items: stockByDimensions(getDb(), stage, {
        modelId: num(req.query.modelId),
        colorId: num(req.query.colorId),
        sizeId: num(req.query.sizeId),
        contractorId: num(req.query.contractorId),
      }),
    });
  });

  return router;
}
