import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconX } from './icons';
import { useToasts } from '../hooks';

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Loading() {
  return (
    <div className="center">
      <Spinner />
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? ((error as { friendly?: string }).friendly ?? error.message) : String(error);
  return <div className="alert error">{msg}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

const STATUS: Record<string, [string, string]> = {
  draft: ['Draft', ''],
  in_review: ['In review', 'amber'],
  published: ['Published', 'green'],
  archived: ['Archived', 'purple'],
};
export function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS[status] ?? [status, ''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

const RATING: Record<string, string> = { low: 'green', medium: 'amber', high: 'red', critical: 'red' };
export function RatingBadge({ rating }: { rating: string }) {
  return <span className={`badge ${RATING[rating] ?? ''}`}>{rating}</span>;
}

const EFF: Record<string, [string, string]> = {
  effective: ['Effective', 'green'],
  partially_effective: ['Partially effective', 'amber'],
  ineffective: ['Ineffective', 'red'],
  not_tested: ['Not tested', ''],
};
export function EffectivenessBadge({ value }: { value: string }) {
  const [label, cls] = EFF[value] ?? [value, ''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function TeamChip({ team }: { team: { name: string; color?: string } | null | undefined }) {
  if (!team) return <span className="muted">—</span>;
  return (
    <span className="row nowrap" style={{ gap: 6 }}>
      <span className="dot" style={{ background: team.color ?? 'var(--text-3)' }} />
      {team.name}
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Confirm({ label, message, onConfirm, className = 'btn danger sm', disabled }: { label: ReactNode; message: string; onConfirm: () => void; className?: string; disabled?: boolean }) {
  return (
    <button
      className={className}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (window.confirm(message)) onConfirm();
      }}
    >
      {label}
    </button>
  );
}

export function Toasts() {
  const items = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
  color?: string;
}

/** Searchable multi-select with chips. */
export function MultiSelect({ options, value, onChange, placeholder, disabled }: { options: Option[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const filtered = options.filter((o) => !value.includes(o.value) && `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 50);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const add = (v: string) => {
    onChange([...value, v]);
    setQ('');
    setHl(0);
  };

  return (
    <div className="ms" ref={ref}>
      <div className="ms-box" onClick={() => !disabled && setOpen(true)}>
        {value.map((v) => (
          <span className="ms-chip" key={v}>
            {byValue.get(v)?.color && <span className="dot" style={{ background: byValue.get(v)!.color }} />}
            <span className="truncate">{byValue.get(v)?.label ?? v}</span>
            {!disabled && (
              <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== v))}>
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            value={q}
            placeholder={value.length ? '' : placeholder}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setHl(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, filtered.length - 1));
              else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0));
              else if (e.key === 'Enter' && filtered[hl]) {
                e.preventDefault();
                add(filtered[hl].value);
              } else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
            }}
          />
        )}
      </div>
      {open && !disabled && filtered.length > 0 && (
        <div className="ms-menu">
          {filtered.map((o, i) => (
            <button type="button" key={o.value} className={i === hl ? 'hl' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => add(o.value)}>
              {o.color && <span className="dot" style={{ background: o.color }} />}
              <span>{o.label}</span>
              {o.hint && <span className="muted small">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Free-text chips (e.g. tags) with suggestions. */
export function TagInput({ value, onChange, suggestions = [] }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[] }) {
  const [q, setQ] = useState('');
  const add = (v: string) => {
    const t = v.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setQ('');
  };
  const list = `tags-${useMemo(() => Math.random().toString(36).slice(2), [])}`;
  return (
    <div className="ms-box">
      {value.map((v) => (
        <span className="ms-chip" key={v}>
          {v}
          <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        list={list}
        value={q}
        placeholder={value.length ? '' : 'Add tag…'}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(q);
          } else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => q && add(q)}
      />
      <datalist id={list}>
        {suggestions.filter((s) => !value.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
