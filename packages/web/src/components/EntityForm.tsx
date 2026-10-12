import { useState } from 'react';
import { Field, Modal, MultiSelect, type Option } from './ui';
import { useAction } from '../hooks';

export type FieldDef =
  | { key: string; label: string; type: 'text' | 'textarea' | 'url' | 'color' | 'date'; hint?: string; required?: boolean }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; hint?: string }
  | { key: string; label: string; type: 'select'; options: Option[]; hint?: string; allowEmpty?: boolean; numeric?: boolean }
  | { key: string; label: string; type: 'multi'; options: Option[]; hint?: string };

/**
 * Generic create / edit dialog. `op` is the operation to call (e.g. system.create
 * or system.update); empty strings become null so optional fields can be cleared.
 */
export function EntityForm({
  title,
  op,
  fields,
  initial,
  extra,
  onClose,
  onDone,
}: {
  title: string;
  op: string;
  fields: FieldDef[];
  initial: Record<string, unknown>;
  extra?: Record<string, unknown>;
  onClose: () => void;
  onDone?: (result: any) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const action = useAction(op, {
    onSuccess: (r) => {
      onDone?.(r);
      onClose();
    },
  });
  const set = (k: string, v: unknown) => setValues({ ...values, [k]: v });
  const missing = fields.some((f) => 'required' in f && f.required && !String(values[f.key] ?? '').trim());

  const submit = () => {
    const payload: Record<string, unknown> = { ...extra };
    for (const f of fields) {
      const v = values[f.key];
      if (f.type === 'number') payload[f.key] = v === '' || v === undefined || v === null ? null : Number(v);
      else if (f.type === 'multi') payload[f.key] = v ?? [];
      else if (f.type === 'textarea') payload[f.key] = v ?? '';
      else if (f.type === 'select' && f.numeric) payload[f.key] = v === '' || v === undefined || v === null ? null : Number(v);
      else payload[f.key] = v === '' || v === undefined ? null : v;
    }
    action.mutate(payload);
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={missing || action.isPending} onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing) submit();
        }}
      >
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {f.type === 'textarea' ? (
              <textarea rows={4} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === 'select' ? (
              <select value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                {f.allowEmpty !== false && <option value="">— None —</option>}
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === 'multi' ? (
              <MultiSelect options={f.options} value={(values[f.key] as string[]) ?? []} onChange={(v) => set(f.key, v)} placeholder="Search…" />
            ) : f.type === 'number' ? (
              <input type="number" min={f.min} max={f.max} value={values[f.key] === null || values[f.key] === undefined ? '' : String(values[f.key])} onChange={(e) => set(f.key, e.target.value)} />
            ) : f.type === 'color' ? (
              <input type="color" value={String(values[f.key] ?? '#2563eb')} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <input type={f.type === 'url' ? 'url' : f.type === 'date' ? 'date' : 'text'} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} autoFocus={f === fields[0]} />
            )}
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
