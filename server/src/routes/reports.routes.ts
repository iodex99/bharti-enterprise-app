import { Router } from 'express';
import { formatBusinessDate } from '@shared';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { officeOf } from '../middleware/office';
import { idParamGuard } from '../middleware/params';
import { getReport, REPORTS, type ReportFilters } from '../services/reports.service';
import { sendXlsx } from '../utils/excel';
import { listFgLots, traceFgLot, tracePurchaseForward } from '../services/trace.service';

function parseFilters(officeId: number, query: Record<string, unknown>): ReportFilters {
  const num = (v: unknown) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    officeId,
    from: str(query.from),
    to: str(query.to),
    modelId: num(query.modelId),
    colorId: num(query.colorId),
    sizeId: num(query.sizeId),
    contractorId: num(query.contractorId),
    staffId: num(query.staffId),
    vendorId: num(query.vendorId),
  };
}

export function reportsRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (_req, res) => {
    res.json({
      reports: REPORTS.map((r) => ({
        key: r.key,
        title: r.title,
        group: r.group,
        description: r.description,
        filters: r.filters,
        columns: r.columns,
      })),
    });
  });

  // Complete Business Report — must be registered BEFORE the /:key route.
  router.get('/full', async (req, res) => {
    const { buildFullReportHtml, buildFullWorkbook } = await import('../utils/fullreport');
    const filters = parseFilters(officeOf(req).id, req.query as Record<string, unknown>);
    const stamp = new Date().toISOString().slice(0, 10);
    if (req.query.format === 'xlsx') {
      const { streamWorkbook } = await import('../utils/excel');
      await streamWorkbook(res, buildFullWorkbook(getDb(), filters), `business-report-${stamp}.xlsx`);
      return;
    }
    const html = buildFullReportHtml(getDb(), filters);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="business-report-${stamp}.html"`);
    res.send(html);
  });

  router.get('/:key', async (req, res) => {
    const report = getReport(String(req.params.key));
    if (!report) {
      res.status(404).json({ error: 'Unknown report.' });
      return;
    }
    const filters = parseFilters(officeOf(req).id, req.query as Record<string, unknown>);
    const rows = report.query(getDb(), filters);

    if (req.query.format === 'xlsx') {
      const parts: string[] = [];
      if (filters.from || filters.to) {
        parts.push(
          `${filters.from ? formatBusinessDate(filters.from) : '…'} to ${filters.to ? formatBusinessDate(filters.to) : '…'}`,
        );
      }
      await sendXlsx(res, {
        title: report.title,
        subtitle: `Bharti Enterprises · generated ${formatBusinessDate(new Date().toISOString().slice(0, 10))}${parts.length ? ' · ' + parts.join(' ') : ''}`,
        columns: report.columns,
        rows,
        filename: `${report.key}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      });
      return;
    }
    res.json({ columns: report.columns, rows });
  });

  return router;
}

export function traceRoutes(): Router {
  const router = Router();
  router.param('packIssueId', idParamGuard);
  router.param('purchaseId', idParamGuard);
  router.use(requireAuth);

  // office-scoped like every other read (ADR-028): a trace never crosses offices
  router.get('/fg-lots', (req, res) => {
    res.json({ items: listFgLots(getDb(), officeOf(req).id) });
  });

  router.get('/fg/:packIssueId', (req, res) => {
    const tree = traceFgLot(getDb(), Number(req.params.packIssueId), officeOf(req).id);
    if (!tree) {
      res.status(404).json({ error: 'Finished-goods batch not found.' });
      return;
    }
    res.json({ tree });
  });

  router.get('/purchase/:purchaseId', (req, res) => {
    const tree = tracePurchaseForward(getDb(), Number(req.params.purchaseId), officeOf(req).id);
    if (!tree) {
      res.status(404).json({ error: 'Purchase not found.' });
      return;
    }
    res.json({ tree });
  });

  return router;
}
