-- 006: rejected pieces go back to the contractor; missing pieces are deducted (ADR-046).
--
-- When a checker rejects pieces from a contractor's returned batch, those pieces are
-- sent straight back to that contractor as REWORK: the stock moves CHECKING → WIP on
-- the very job line it came from (ref check_reject), the card reopens, and the
-- contractor's payable quantity drops until the fixed pieces come back and are received
-- again. Pieces the checker reports MISSING are written off as before, and also deducted
-- from the contractor (they claimed pieces they never handed over).
--
-- One row per (check result, reason). Money is never stored here: a job line's payable
-- amount is always (stitched received − rework − missing) × the line's rate ÷ 12,
-- rounded once per line, so editing a rate re-prices everything consistently.

CREATE TABLE IF NOT EXISTS contractor_adjustments (
  id INTEGER PRIMARY KEY,
  office_id INTEGER NOT NULL,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id),
  job_card_line_id INTEGER NOT NULL REFERENCES job_card_lines(id),
  check_issue_id INTEGER NOT NULL REFERENCES check_issues(id),
  check_result_id INTEGER NOT NULL REFERENCES check_results(id),
  kind TEXT NOT NULL CHECK (kind IN ('rework','missing')),
  reason TEXT NOT NULL,
  qty_pcs INTEGER NOT NULL CHECK (qty_pcs > 0),
  adj_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_contractor_adj_line ON contractor_adjustments(job_card_line_id);
CREATE INDEX IF NOT EXISTS idx_contractor_adj_contractor ON contractor_adjustments(contractor_id, office_id);
