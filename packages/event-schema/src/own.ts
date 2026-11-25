/**
 * Safe readers for untrusted JSON.parse output (internal; not exported from the package).
 * Only own data properties are read: inherited keys and accessors are never touched (no getter runs).
 */

export function isRecord(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An own data property of an object or array; undefined for anything else. */
export function own(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d !== undefined && 'value' in d ? d.value : undefined;
}

/** An own array property: undefined when absent, null when present but not an array. */
export function ownArray(obj: object, key: string): readonly unknown[] | undefined | null {
  const v = own(obj, key);
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : null;
}

/** Items of an array, read by index as own data properties (no iterator, no getter). */
export function items(arr: readonly unknown[] | null | undefined): unknown[] {
  const out: unknown[] = [];
  if (arr === undefined || arr === null) return out;
  for (let i = 0; i < arr.length; i++) out.push(own(arr, String(i)));
  return out;
}
