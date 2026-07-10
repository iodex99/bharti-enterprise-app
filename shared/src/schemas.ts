import { z } from 'zod';
import { CUTTING_VARIANCE_REASONS, STAFF_ROLES, STAGES } from './enums';
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
  role: z.enum(STAFF_ROLES),
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
    modelId: id,
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

export const cuttingPlanSchema = z
  .object({
    cutDate: businessDate,
    rawLotType: z.enum(['purchase', 'opening']),
    rawLotId: id,
    /** cloth consumed by this cutting batch, integer cm */
    metersUsedCm: z.number().int().positive().max(100_000_000),
    notes: optionalText(500),
    lines: z
      .array(
        z.object({
          sizeId: id,
          /** expected output in integer pieces */
          expectedPcs: z.number().int().positive().max(10_000_000),
        }),
      )
      .min(1, 'Add at least one size'),
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

export const openingBalanceSchema = z
  .object({
    balanceDate: businessDate,
    stage: z.enum(STAGES),
    modelId: id,
    colorId: id,
    sizeId: id.nullish(),
    contractorId: id.nullish(),
    /** cm for RAW, pieces for all other stages */
    qty: z.number().int().positive().max(100_000_000),
    note: optionalText(300),
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
