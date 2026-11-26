import { z } from 'zod';
import {
  CHECK_REJECTION_REASONS,
  CHECKING_POOL_LOT_TYPES,
  JOB_DISCREPANCY_REASONS,
  PACK_KINDS,
  PACK_SHORT_REASONS,
  PACKING_POOL_LOT_TYPES,
  PAYMENT_MODES,
  RECEIPT_RETURN_TYPES,
  STAFF_ROLES,
  STAGES,
  UNIT_TYPES,
} from './enums';
import { isValidBusinessDate } from './dates';

/**
 * API payload schemas shared by server validation and client forms.
 * Convention: money in integer PAISE, cloth lengths/widths in integer HUNDREDTHS OF AN
 * INCH (entered as yards / inches — the UI converts), quantities in integer PIECES.
 * The API never sees floats.
 */

const trimmed = (max: number, min = 1) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).default('');
const mobile = z
  .string()
  .trim()
  .max(16)
  .regex(/^[0-9+\-() ]*$/, 'Digits, +, -, ( ) and spaces only')
  .default('');

// ---------------------------------------------------------------------------
// masters (models are NOT a master any more — codes are typed at cutting, ADR-030)
// ---------------------------------------------------------------------------

export const colorSchema = z.object({
  name: trimmed(50),
  colorCode: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB color code')
    .nullish()
    .or(z.literal('').transform(() => null)),
});

export const sizeSchema = z.object({
  code: trimmed(20),
  description: optionalText(200),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const vendorSchema = z.object({
  name: trimmed(100),
  contactPerson: optionalText(100),
  mobile,
  address: optionalText(300),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .regex(/^$|^[0-9A-Z]{15}$/, 'GSTIN must be 15 characters (letters/digits)')
    .default(''),
  notes: optionalText(500),
});

export const contractorSchema = z.object({
  name: trimmed(100),
  contactPerson: optionalText(100),
  mobile,
  address: optionalText(300),
  defaultRatePaisePerDozen: z.number().int().min(0).max(100_000_00).default(0),
  /** the contractor's payment QR code, shown when recording a payment */
  imagePath: z.string().max(300).nullish(),
  notes: optionalText(500),
});

export const staffSchema = z.object({
  name: trimmed(100),
  mobile,
  // Any staff member can check OR pack — no fixed role. Kept optional for legacy rows.
  role: z.enum(STAFF_ROLES).default('both'),
  /** what this checker/packer is usually paid per dozen (snapshotted at issue) */
  defaultRatePaisePerDozen: z.number().int().min(0).max(100_000_00).default(0),
  /** the staff member's payment QR code, shown when recording a payment */
  imagePath: z.string().max(300).nullish(),
  notes: optionalText(500),
});

export type ColorInput = z.infer<typeof colorSchema>;
export type SizeInput = z.infer<typeof sizeSchema>;
export type VendorInput = z.infer<typeof vendorSchema>;
export type ContractorInput = z.infer<typeof contractorSchema>;
export type StaffInput = z.infer<typeof staffSchema>;

// ---------------------------------------------------------------------------
// offices (ADR-028): each office's operations are separate; admin manages them here
// ---------------------------------------------------------------------------

export const officeSchema = z.object({
  /** short code embedded in that office's document numbers, e.g. "BR" → BR-RM-0001 */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(6)
    .regex(/^[A-Z0-9]+$/, 'Letters and digits only'),
  name: trimmed(100),
});
export type OfficeInput = z.infer<typeof officeSchema>;

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

export const businessDate = z
  .string()
  .refine(isValidBusinessDate, 'Enter a valid date (YYYY-MM-DD)');

const id = z.number().int().positive();

/** The product code typed at cutting — becomes the "size-code" identity everywhere. */
const productCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Enter the code number')
  .max(30)
  .regex(/^[A-Z0-9][A-Z0-9 ._/-]*$/, 'Letters, digits, space, . _ / - only');

export const purchaseSchema = z
  .object({
    purchaseDate: businessDate,
    receivedDate: businessDate,
    vendorId: id,
    // NO model/code here — cloth is bought as color + yards; the code is given at cutting
    colorId: id,
    /** cloth LENGTH, integer hundredths of an inch (UI converts from yards) */
    lenInchC: z.number().int().positive().max(400_000_000), // ≈ 111,000 yards
    /** cloth WIDTH, integer hundredths of an inch (UI converts from inches, e.g. 44") */
    widthInchC: z.number().int().positive().max(20_000), // up to 200"
    ratePaisePerYard: z.number().int().min(0).max(100_000_00),
    imagePath: z.string().max(300).nullish(),
    notes: optionalText(500),
  })
  .refine((p) => p.receivedDate >= p.purchaseDate, {
    message: 'Received date cannot be before the purchase date',
    path: ['receivedDate'],
  });
export type PurchaseInput = z.infer<typeof purchaseSchema>;

export const purchaseEditSchema = z.object({
  // financial/reference fields only — quantity/color are immutable (void + re-enter)
  ratePaisePerYard: z.number().int().min(0).max(100_000_00),
  imagePath: z.string().max(300).nullish(),
  notes: optionalText(500),
});
export type PurchaseEditInput = z.infer<typeof purchaseEditSchema>;

export const voidSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(300),
});

export const resolveDiscrepancySchema = z.object({
  // acknowledgement-only: what was decided/settled — never a stock movement
  note: z.string().trim().min(3, 'A resolution note is required').max(500),
});
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;

/**
 * Cutting v2 (ADR-030/031): the plan IS the cutting — no separate actuals step. Each
 * size line carries the CODE typed here (creating the "CODE-SIZE" product identity used
 * everywhere downstream) and optionally its photo. Cloth consumed is computed
 * server-side from the geometry.
 */
export const cuttingPlanSchema = z
  .object({
    cutDate: businessDate,
    rawLotType: z.enum(['purchase', 'opening']),
    rawLotId: id,
    notes: optionalText(500),
    lines: z
      .array(
        z.object({
          sizeId: id,
          /** the code number for this size — together they are the "size-code" */
          code: productCode,
          /** pieces cut, integer */
          qtyPcs: z.number().int().positive().max(10_000_000),
          /** cloth length per piece, integer hundredths of an inch (10.25" = 1025) */
          clothPerPcInchC: z.number().int().positive().max(100_000),
          /** pieces cut side-by-side across the cloth width */
          widthCount: z.number().int().positive().max(1000),
          /** photo of this product (stored as the code's photo, shown everywhere) */
          imagePath: z.string().max(300).nullish(),
        }),
      )
      .min(1, 'Add at least one size'),
  })
  .refine((p) => new Set(p.lines.map((l) => l.sizeId)).size === p.lines.length, {
    message: 'Each size may appear only once',
    path: ['lines'],
  });
export type CuttingPlanInput = z.infer<typeof cuttingPlanSchema>;

/**
 * Job issue v2 (ADR-033): one physical handover can cover several codes/colors, but the
 * job CARDS are per code+color — the server splits this input into one card per
 * (model, color) group. Rate (cost per dozen) is set here, at issue.
 */
export const jobIssueSchema = z
  .object({
    issueDate: businessDate,
    contractorId: id,
    notes: optionalText(500),
    lines: z
      .array(
        z.object({
          modelId: id,
          colorId: id,
          sizeId: id,
          qtyIssuedPcs: z.number().int().positive().max(10_000_000),
          unitEntered: z.enum(UNIT_TYPES).default('dozens'),
          ratePaisePerDozen: z.number().int().min(0).max(100_000_00),
        }),
      )
      .min(1, 'Add at least one line'),
  })
  .refine(
    (p) =>
      new Set(p.lines.map((l) => `${l.modelId}|${l.colorId}|${l.sizeId}`)).size === p.lines.length,
    { message: 'Each code + color + size may appear only once', path: ['lines'] },
  );
export type JobIssueInput = z.infer<typeof jobIssueSchema>;

/** Edit an UNSTARTED job card (no receipts yet): date, notes and its size lines. */
export const jobEditSchema = z
  .object({
    issueDate: businessDate,
    notes: optionalText(500),
    lines: z
      .array(
        z.object({
          sizeId: id,
          qtyIssuedPcs: z.number().int().positive().max(10_000_000),
          unitEntered: z.enum(UNIT_TYPES).default('dozens'),
          ratePaisePerDozen: z.number().int().min(0).max(100_000_00),
        }),
      )
      .min(1, 'Add at least one size'),
  })
  .refine((p) => new Set(p.lines.map((l) => l.sizeId)).size === p.lines.length, {
    message: 'Each size may appear only once',
    path: ['lines'],
  });
export type JobEditInput = z.infer<typeof jobEditSchema>;

export const jobReceiptSchema = z.object({
  receiptDate: businessDate,
  /** photo of the returned goods — REQUIRED: every model's return is photographed */
  imagePath: z.string().trim().min(1, 'Take a photo of the returned goods').max(300),
  notes: optionalText(500),
  lines: z
    .array(
      z.object({
        jobCardLineId: id,
        qtyPcs: z.number().int().positive().max(10_000_000),
        returnType: z.enum(RECEIPT_RETURN_TYPES).default('stitched'),
        /** required by the service when this line creates a discrepancy (excess) */
        discrepancyReason: z.enum(JOB_DISCREPANCY_REASONS).nullish(),
        discrepancyNote: optionalText(300),
      }),
    )
    .min(1, 'Enter at least one received quantity'),
});
export type JobReceiptInput = z.infer<typeof jobReceiptSchema>;

export const jobCloseSchema = z.object({
  reason: z.enum(JOB_DISCREPANCY_REASONS),
  note: z.string().trim().min(3, 'Describe what happened').max(500),
});
export type JobCloseInput = z.infer<typeof jobCloseSchema>;

export const paymentSchema = z.object({
  contractorId: id,
  paymentDate: businessDate,
  amountPaise: z.number().int().positive().max(100_000_000_00),
  mode: z.enum(PAYMENT_MODES),
  reference: optionalText(100),
  notes: optionalText(300),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

/** A payment to a checker/packer — partial amounts with their date, like contractors. */
export const staffPaymentSchema = paymentSchema.omit({ contractorId: true }).extend({
  staffId: id,
});
export type StaffPaymentInput = z.infer<typeof staffPaymentSchema>;

export const checkIssueSchema = z.object({
  issueDate: businessDate,
  staffId: id,
  /** the SPECIFIC received batch being checked — contractor↔checker mapping is explicit */
  lotType: z.enum(CHECKING_POOL_LOT_TYPES),
  lotId: id,
  qtyPcs: z.number().int().positive().max(10_000_000),
  /** the checker's pay per dozen for this batch; omitted → the staff member's default */
  ratePaisePerDozen: z.number().int().min(0).max(100_000_00).nullish(),
  notes: optionalText(300),
});
export type CheckIssueInput = z.infer<typeof checkIssueSchema>;

/**
 * Check result v2 (ADR-034): passed + ONE rejected box broken down by reason, where
 * 'missing' is a reason like any other for the user. (Internally missing pieces are a
 * terminal write-off — they do not physically exist to sit in REJECTED stock.)
 */
export const checkResultSchema = z
  .object({
    resultDate: businessDate,
    qtyPassed: z.number().int().min(0).max(10_000_000).default(0),
    rejections: z
      .array(
        z.object({
          reason: z.enum(CHECK_REJECTION_REASONS),
          qtyPcs: z.number().int().positive().max(10_000_000),
        }),
      )
      .default([]),
    notes: optionalText(300),
  })
  .refine((r) => r.qtyPassed + r.rejections.reduce((s, x) => s + x.qtyPcs, 0) > 0, {
    message: 'Enter at least one quantity',
    path: ['qtyPassed'],
  });
export type CheckResultInput = z.infer<typeof checkResultSchema>;

/**
 * Packing v2 (ADR-035): packing is allotted FROM the checking page, directed at a
 * specific source lot — a checker's passed goods, an opening lot, or a bundle.
 * kind 'bundle' = keep these checked pieces aside, labeled, to pack later.
 */
export const packIssueSchema = z.object({
  issueDate: businessDate,
  staffId: id,
  lotType: z.enum(PACKING_POOL_LOT_TYPES),
  lotId: id,
  qtyPcs: z.number().int().positive().max(10_000_000),
  kind: z.enum(PACK_KINDS).default('pack'),
  /** bundle label, e.g. "Diwali order reserve" — how the owner refers to it later */
  label: optionalText(100),
  /** the packer's pay per dozen for this work; omitted → the staff member's default */
  ratePaisePerDozen: z.number().int().min(0).max(100_000_00).nullish(),
  notes: optionalText(300),
});
export type PackIssueInput = z.infer<typeof packIssueSchema>;

export const packResultSchema = z
  .object({
    resultDate: businessDate,
    qtyPacked: z.number().int().min(0).max(10_000_000).default(0),
    qtyShort: z.number().int().min(0).max(10_000_000).default(0),
    shortReason: z.enum(PACK_SHORT_REASONS).nullish(),
    notes: optionalText(300),
  })
  .refine((r) => r.qtyPacked + r.qtyShort > 0, {
    message: 'Enter at least one quantity',
    path: ['qtyPacked'],
  })
  .refine((r) => r.qtyShort === 0 || r.shortReason != null, {
    message: 'Pick a reason for the shortage',
    path: ['shortReason'],
  });
export type PackResultInput = z.infer<typeof packResultSchema>;

export const dispatchSchema = z.object({
  dispatchDate: businessDate,
  modelId: id,
  colorId: id,
  sizeId: id,
  qtyPcs: z.number().int().positive().max(10_000_000),
  notes: optionalText(300),
});
export type DispatchInput = z.infer<typeof dispatchSchema>;

export const openingBalanceSchema = z
  .object({
    balanceDate: businessDate,
    stage: z.enum(STAGES),
    /**
     * The code for stitched stages, typed like at cutting (product identities are
     * created from codes, not a master). Not applicable to RAW — cloth has no code
     * until it is cut.
     */
    modelCode: productCode.nullish(),
    colorId: id,
    sizeId: id.nullish(),
    contractorId: id.nullish(),
    /** length in hundredths of an inch for RAW (entered as yards), pieces otherwise */
    qty: z.number().int().positive().max(400_000_000),
    /** cloth width for RAW lots, hundredths of an inch */
    widthInchC: z.number().int().positive().max(20_000).nullish(),
    note: optionalText(300),
  })
  .refine((b) => (b.stage === 'RAW' ? true : b.modelCode != null && b.modelCode !== ''), {
    message: 'The code number is required for this stage',
    path: ['modelCode'],
  })
  .refine((b) => (b.stage === 'RAW' ? true : b.sizeId != null), {
    message: 'Size is required for this stage',
    path: ['sizeId'],
  })
  .refine((b) => (b.stage === 'WIP' ? b.contractorId != null : true), {
    message: 'Contractor is required for WIP stock',
    path: ['contractorId'],
  });
export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;
