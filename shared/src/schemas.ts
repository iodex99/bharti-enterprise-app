import { z } from 'zod';
import {
  CHECK_REJECTION_REASONS,
  CHECKING_POOL_LOT_TYPES,
  CUTTING_VARIANCE_REASONS,
  JOB_DISCREPANCY_REASONS,
  PACK_SHORT_REASONS,
  PAYMENT_MODES,
  RECEIPT_RETURN_TYPES,
  STAFF_ROLES,
  STAGES,
  UNIT_TYPES,
} from './enums';
import { isValidBusinessDate } from './dates';

/**
 * API payload schemas shared by server validation and client forms.
 * Convention: money in integer PAISE, lengths in integer CM, quantities in integer
 * PIECES — the UI converts at the boundary (MoneyInput etc.), the API never sees floats.
 */

const trimmed = (max: number, min = 1) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).default('');
const mobile = z
  .string()
  .trim()
  .max(16)
  .regex(/^[0-9+\-() ]*$/, 'Digits, +, -, ( ) and spaces only')
  .default('');

export const modelSchema = z.object({
  code: trimmed(30),
  name: trimmed(100),
  description: optionalText(500),
  imagePath: z.string().max(300).nullish(),
});

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
  notes: optionalText(500),
});

export const staffSchema = z.object({
  name: trimmed(100),
  mobile,
  // Any staff member can check OR pack — no fixed role. Kept optional for legacy rows.
  role: z.enum(STAFF_ROLES).default('both'),
  notes: optionalText(500),
});

export type ModelInput = z.infer<typeof modelSchema>;
export type ColorInput = z.infer<typeof colorSchema>;
export type SizeInput = z.infer<typeof sizeSchema>;
export type VendorInput = z.infer<typeof vendorSchema>;
export type ContractorInput = z.infer<typeof contractorSchema>;
export type StaffInput = z.infer<typeof staffSchema>;

export const businessDate = z
  .string()
  .refine(isValidBusinessDate, 'Enter a valid date (YYYY-MM-DD)');

const id = z.number().int().positive();

export const purchaseSchema = z
  .object({
    purchaseDate: businessDate,
    receivedDate: businessDate,
    vendorId: id,
    // NO model here — cloth is bought as color + meters; the model is decided at cutting
    colorId: id,
    /** integer centimeters (UI converts from meters) */
    qtyCm: z.number().int().positive().max(100_000_000),
    ratePaisePerMeter: z.number().int().min(0).max(100_000_00),
    imagePath: z.string().max(300).nullish(),
    notes: optionalText(500),
  })
  .refine((p) => p.receivedDate >= p.purchaseDate, {
    message: 'Received date cannot be before the purchase date',
    path: ['receivedDate'],
  });
export type PurchaseInput = z.infer<typeof purchaseSchema>;

export const purchaseEditSchema = z.object({
  // financial/reference fields only — quantity/model/color are immutable (void + re-enter)
  ratePaisePerMeter: z.number().int().min(0).max(100_000_00),
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

export const cuttingPlanSchema = z
  .object({
    cutDate: businessDate,
    rawLotType: z.enum(['purchase', 'opening']),
    rawLotId: id,
    /** the model this cloth is being cut into — decided HERE, not at purchase */
    modelId: id,
    notes: optionalText(500),
    lines: z
      .array(
        z.object({
          sizeId: id,
          /** expected output in integer pieces */
          expectedPcs: z.number().int().positive().max(10_000_000),
          /** cloth length per piece, integer hundredths of an inch (10.25" = 1025) */
          clothPerPcInchC: z.number().int().positive().max(100_000),
          /** pieces cut side-by-side across the cloth width */
          widthCount: z.number().int().positive().max(1000),
        }),
      )
      .min(1, 'Add at least one size'),
    // cloth consumed is COMPUTED server-side from the lines (clothRequiredCm)
  })
  .refine((p) => new Set(p.lines.map((l) => l.sizeId)).size === p.lines.length, {
    message: 'Each size may appear only once',
    path: ['lines'],
  });
export type CuttingPlanInput = z.infer<typeof cuttingPlanSchema>;

export const cuttingActualsSchema = z
  .object({
    lines: z
      .array(
        z.object({
          sizeId: id,
          actualPcs: z.number().int().min(0).max(10_000_000),
          varianceReason: z.enum(CUTTING_VARIANCE_REASONS).nullish(),
          reasonNote: optionalText(300),
        }),
      )
      .min(1),
  })
  .refine((p) => new Set(p.lines.map((l) => l.sizeId)).size === p.lines.length, {
    message: 'Each size may appear only once',
    path: ['lines'],
  });
export type CuttingActualsInput = z.infer<typeof cuttingActualsSchema>;

export const jobCardSchema = z
  .object({
    issueDate: businessDate,
    contractorId: id,
    modelId: id,
    colorId: id,
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
export type JobCardInput = z.infer<typeof jobCardSchema>;

export const jobReceiptSchema = z.object({
  receiptDate: businessDate,
  /** photo of the returned goods — easy reference at checking time */
  imagePath: z.string().max(300).nullish(),
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

export const checkIssueSchema = z.object({
  issueDate: businessDate,
  staffId: id,
  /** the SPECIFIC received batch being checked — contractor↔checker mapping is explicit */
  lotType: z.enum(CHECKING_POOL_LOT_TYPES),
  lotId: id,
  qtyPcs: z.number().int().positive().max(10_000_000),
  notes: optionalText(300),
});
export type CheckIssueInput = z.infer<typeof checkIssueSchema>;

export const checkResultSchema = z
  .object({
    resultDate: businessDate,
    qtyPassed: z.number().int().min(0).max(10_000_000).default(0),
    qtyRejected: z.number().int().min(0).max(10_000_000).default(0),
    qtyMissing: z.number().int().min(0).max(10_000_000).default(0),
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
  .refine((r) => r.qtyPassed + r.qtyRejected + r.qtyMissing > 0, {
    message: 'Enter at least one quantity',
    path: ['qtyPassed'],
  })
  .refine((r) => r.rejections.reduce((s, x) => s + x.qtyPcs, 0) === r.qtyRejected, {
    message: 'Rejection reasons must add up to the rejected quantity',
    path: ['rejections'],
  });
export type CheckResultInput = z.infer<typeof checkResultSchema>;

export const packIssueSchema = z.object({
  issueDate: businessDate,
  staffId: id,
  modelId: id,
  colorId: id,
  sizeId: id,
  qtyPcs: z.number().int().positive().max(10_000_000),
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
    /** not applicable to RAW — raw cloth has no model until it is cut */
    modelId: id.nullish(),
    colorId: id,
    sizeId: id.nullish(),
    contractorId: id.nullish(),
    /** cm for RAW, pieces for all other stages */
    qty: z.number().int().positive().max(100_000_000),
    note: optionalText(300),
  })
  .refine((b) => (b.stage === 'RAW' ? true : b.modelId != null), {
    message: 'Model is required for this stage',
    path: ['modelId'],
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
