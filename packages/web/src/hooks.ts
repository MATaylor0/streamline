import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, call } from './api';

export function useOp<T = any>(op: string, input: Record<string, unknown> = {}, options: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [op, input], queryFn: () => call<T>(op, input), ...options });
}

/** Run a write operation; on success every cached query is refreshed. */
export function useAction<T = any>(op: string, opts: { onSuccess?: (data: T) => void; toast?: string | false } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<T, ApiError, Record<string, unknown>>({
    mutationFn: (input) => call<T>(op, input),
    onSuccess: async (data) => {
      await qc.invalidateQueries();
      if (opts.toast !== false) toast.show(opts.toast ?? 'Saved', 'success');
      opts.onSuccess?.(data);
    },
    onError: (err) => toast.show(err instanceof ApiError ? err.friendly : String(err), 'error'),
  });
}

// ------------------------------------------------------------------ toasts

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}
let toasts: ToastItem[] = [];
const listeners = new Set<(t: ToastItem[]) => void>();
let seq = 0;

function emit() {
  for (const l of listeners) l(toasts);
}

export const toastApi = {
  show(text: string, kind: ToastKind = 'info') {
    const id = ++seq;
    toasts = [...toasts, { id, text, kind }].slice(-4);
    emit();
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }, kind === 'error' ? 7000 : 3000);
  },
};

export function useToast() {
  return toastApi;
}

export function useToasts() {
  const [items, setItems] = useState<ToastItem[]>(toasts);
  useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);
  return items;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}
