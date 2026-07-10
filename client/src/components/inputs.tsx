import { useRef, useState } from 'react';
import { TextInput } from './ui';

/**
 * Money entry in rupees, value held in integer PAISE (or null while empty/invalid).
 * Text state stays local so partial entries like "12." don't fight the parser.
 * Initializes from the prop ONCE — parents must remount (key=) to load a new record.
 */
export function MoneyInput({
  paise,
  onChange,
  placeholder,
  disabled,
}: {
  paise: number | null;
  onChange: (paise: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => (paise == null ? '' : (paise / 100).toString()));

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-gray-400">
        ₹
      </span>
      <TextInput
        inputMode="decimal"
        className="pl-7"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const t = e.target.value;
          if (!/^\d*(\.\d{0,2})?$/.test(t)) return;
          setText(t);
          if (t === '' || t === '.') {
            onChange(null);
            return;
          }
          const rupees = Number.parseFloat(t);
          onChange(Number.isFinite(rupees) ? Math.round(rupees * 100) : null);
        }}
      />
    </div>
  );
}

/**
 * Image upload: posts to /api/uploads, holds the returned path, shows a preview.
 */
export function ImageInput({
  path,
  onChange,
  disabled,
}: {
  path: string | null;
  onChange: (path: string | null) => void;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch('/api/uploads', { method: 'POST', body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Upload failed (${res.status})`);
      }
      const body = (await res.json()) as { path: string };
      onChange(body.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {path ? (
        <div className="flex items-center gap-3">
          <img
            src={path}
            alt="Reference"
            className="h-20 w-20 rounded-lg border border-gray-200 object-cover"
          />
          {!disabled && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                className="text-sm font-medium text-violet-600 hover:underline"
                onClick={() => fileRef.current?.click()}
              >
                Replace photo
              </button>
              <button
                type="button"
                className="text-sm text-red-600 hover:underline"
                onClick={() => onChange(null)}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ) : (
        !disabled && (
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="flex h-20 w-full items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-500 hover:border-violet-400 hover:text-violet-600 disabled:opacity-50"
          >
            {busy ? 'Uploading…' : '📷 Add photo'}
          </button>
        )
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.target.value = '';
        }}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
