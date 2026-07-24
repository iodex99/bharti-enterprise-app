import { optionLabel, useMasterOptions } from '../api/masters';
import { Select } from './ui';

/** Dropdown over ACTIVE master rows (deactivated masters cannot enter new documents). */
export function MasterSelect({
  master,
  value,
  onChange,
  allowEmpty,
  emptyLabel = '— select —',
  disabled,
}: {
  master: 'colors' | 'sizes' | 'vendors' | 'contractors' | 'staff';
  value: number | null;
  onChange: (id: number | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const { data: options, isLoading } = useMasterOptions(master);
  return (
    <Select
      value={value ?? ''}
      disabled={disabled || isLoading}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="" disabled={!allowEmpty}>
        {isLoading ? 'Loading…' : emptyLabel}
      </option>
      {options?.map((o) => (
        <option key={o.id} value={o.id}>
          {optionLabel(master, o)}
        </option>
      ))}
    </Select>
  );
}
