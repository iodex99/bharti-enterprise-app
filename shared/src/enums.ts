/** Single source of truth for every closed vocabulary in the system. */

export const ROLES = ['admin', 'operator', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const STAGES = ['RAW', 'CUT', 'WIP', 'CHECKING', 'PACKING', 'FG', 'REJECTED'] as const;
export type Stage = (typeof STAGES)[number];

export const STAFF_ROLES = ['checker', 'packer', 'both'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const UNIT_TYPES = ['dozens', 'pieces'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const CUTTING_STATUS = ['planned', 'completed'] as const;
export type CuttingStatus = (typeof CUTTING_STATUS)[number];

export const CUTTING_VARIANCE_REASONS = [
  'wastage',
  'measurement_error',
  'production_loss',
  'better_yield',
  'other',
] as const;
export type CuttingVarianceReason = (typeof CUTTING_VARIANCE_REASONS)[number];

export const JOB_STATUS = [
  'open',
  'partially_received',
  'completed',
  'closed_with_discrepancy',
] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export const RECEIPT_RETURN_TYPES = ['stitched', 'unstitched_return'] as const;
export type ReceiptReturnType = (typeof RECEIPT_RETURN_TYPES)[number];

export const JOB_DISCREPANCY_REASONS = [
  'wastage',
  'damage',
  'short_issue',
  'missing_pieces',
  'quality_rejection',
  'other',
] as const;
export type JobDiscrepancyReason = (typeof JOB_DISCREPANCY_REASONS)[number];

export const CHECK_STATUS = ['open', 'completed'] as const;
export type CheckStatus = (typeof CHECK_STATUS)[number];

export const CHECK_REJECTION_REASONS = [
  'stitching_issue',
  'elastic_issue',
  'color_defect',
  'damage',
  'other',
] as const;
export type CheckRejectionReason = (typeof CHECK_REJECTION_REASONS)[number];

export const PACK_STATUS = ['open', 'completed'] as const;
export type PackStatus = (typeof PACK_STATUS)[number];

export const PACK_SHORT_REASONS = ['damage', 'missing', 'other'] as const;
export type PackShortReason = (typeof PACK_SHORT_REASONS)[number];

export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'other'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * Ledger movement reference types. Conservation rules:
 * - GENESIS types are the only rows allowed to create stock out of nothing.
 * - TERMINAL types are the only rows allowed to destroy stock.
 * - Every other type must appear in balanced +/- pairs within one transaction.
 */
export const GENESIS_REF_TYPES = [
  'opening',
  'purchase',
  'cutting_output',
  'receipt_excess',
  'adjustment_in',
] as const;

export const TERMINAL_REF_TYPES = [
  'cutting_consume',
  'job_shortage',
  'check_missing',
  'pack_short',
  'reject_writeoff',
  'dispatch',
  'adjustment_out',
] as const;

export const TRANSFER_REF_TYPES = [
  'job_issue',
  'job_receipt',
  'unstitched_return',
  'check_issue',
  'check_pass',
  'check_reject',
  'pack_issue',
  'pack_output',
  'void_reversal',
] as const;

export const REF_TYPES = [
  ...GENESIS_REF_TYPES,
  ...TERMINAL_REF_TYPES,
  ...TRANSFER_REF_TYPES,
] as const;
export type RefType = (typeof REF_TYPES)[number];

/** Human labels for enum values (UI + Excel). */
export const LABELS: Record<string, string> = {
  admin: 'Admin',
  operator: 'Operator',
  owner: 'Owner',
  RAW: 'Raw Material',
  CUT: 'Cut Cloth',
  WIP: 'Contractor WIP',
  CHECKING: 'Checking',
  PACKING: 'Packing',
  FG: 'Finished Goods',
  REJECTED: 'Rejected',
  checker: 'Checker',
  packer: 'Packer',
  both: 'Checker + Packer',
  dozens: 'Dozens',
  pieces: 'Pieces',
  planned: 'Planned',
  completed: 'Completed',
  open: 'Open',
  partially_received: 'Partially Received',
  closed_with_discrepancy: 'Closed with Discrepancy',
  stitched: 'Stitched',
  unstitched_return: 'Unstitched Return',
  wastage: 'Wastage',
  measurement_error: 'Measurement Error',
  production_loss: 'Production Loss',
  better_yield: 'Better Yield',
  damage: 'Damage',
  short_issue: 'Short Issue',
  missing_pieces: 'Missing Pieces',
  quality_rejection: 'Quality Rejection',
  stitching_issue: 'Stitching Issue',
  elastic_issue: 'Elastic Issue',
  color_defect: 'Color Defect',
  missing: 'Missing',
  other: 'Other',
  cash: 'Cash',
  upi: 'UPI',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
};

export function label(value: string): string {
  return LABELS[value] ?? value;
}
