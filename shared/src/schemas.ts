import { z } from 'zod';
import { STAFF_ROLES } from './enums';

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
