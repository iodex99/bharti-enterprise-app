-- Additive migration: cutting geometry (cloth per piece in inches + width count),
-- receipt photos, and the sentinel "raw cloth" model.
--
-- Business change: the MODEL is decided at CUTTING, not at purchase. Purchases and RAW
-- ledger rows keep their NOT NULL model_id via an inactive bookkeeping model that never
-- appears in dropdowns (is_active = 0) and is hidden on RAW displays.

-- pinned at a high id so it never collides with user/master rows created by fixtures
INSERT OR IGNORE INTO models (id, code, name, description, is_active, created_by)
VALUES (1000000, 'RAW-CLOTH', 'Raw cloth (model decided at cutting)',
        'System row: placeholder model for purchased cloth before cutting.', 0, NULL);

-- cloth length used per piece, integer HUNDREDTHS of an inch (10.25" = 1025);
-- widthCount = pieces cut side-by-side across the cloth width.
-- Nullable: legacy lines and unplanned actuals-only sizes have no geometry.
ALTER TABLE cutting_lines ADD COLUMN cloth_per_pc_inch_c INTEGER;
ALTER TABLE cutting_lines ADD COLUMN width_count INTEGER;

-- photo of the goods a contractor returned (reference while checking)
ALTER TABLE job_receipts ADD COLUMN image_path TEXT;
