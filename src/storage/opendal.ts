import { Operator } from 'opendal';

/** OpenDAL reports missing paths as a generic error whose message starts with "NotFound". */
export function isNotFound(err: unknown): boolean {
  return /NotFound/.test((err as Error)?.message ?? '');
}

/** Local `fs` roots are created on demand; temp-then-rename writes make overwrites atomic for readers. */
export function createOperator(scheme: string, options: Record<string, string>): Operator {
  const opts = { ...options };
  if (scheme === 'fs' && opts.root && !opts.atomic_write_dir) opts.atomic_write_dir = `${opts.root.replace(/\/+$/, '')}/.tmp`;
  return new Operator(scheme, opts);
}
