/**
 * Exact numeric helpers for untrusted OTLP/JSON values.
 *
 * OTLP/JSON encodes 64-bit integers (`intValue`, `asInt`, `*TimeUnixNano`) as decimal strings because a
 * JS number cannot hold them exactly. Nanosecond timestamps therefore stay decimal strings; they are only
 * converted to milliseconds with BigInt division. A JS number is accepted only when it is a safe integer,
 * so no value is ever silently rounded on the way in. None of these functions throw.
 */

const NANOS_RE = /^\d{1,20}$/;
const INT_RE = /^-?\d{1,20}$/;
const MAX_INT64 = (1n << 63n) - 1n;

/** Own data property only: inherited keys and accessors are never read (no getter is invoked). */
function ownValue(obj: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d !== undefined && 'value' in d ? d.value : undefined;
}

/**
 * A non-negative 64-bit nanosecond timestamp as a canonical decimal string (no leading zeros), or null.
 * Accepts a decimal string of 1–20 digits that is ≤ 2^63−1, or a non-negative safe JS integer.
 */
export function parseNanos(v: unknown): string | null {
  if (typeof v === 'string') {
    if (!NANOS_RE.test(v)) return null;
    const n = BigInt(v);
    return n <= MAX_INT64 ? n.toString() : null;
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

/** Milliseconds from a canonical nanosecond string (from `parseNanos`), truncated. Always a safe integer. */
export function nanosToMs(ns: string): number {
  return Number(BigInt(ns) / 1_000_000n);
}

function parseInt64AsSafe(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v !== 'string' || !INT_RE.test(v)) return null;
  const n = BigInt(v);
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

/**
 * The value of an OTLP NumberDataPoint: a finite `asDouble` number, or `asInt` as a decimal string or safe
 * integer. NaN, ±Infinity, unsafe integers, both fields set (ambiguous oneof) or neither → null.
 */
export function parseValue(point: unknown): number | null {
  if (typeof point !== 'object' || point === null || Array.isArray(point)) return null;
  const d = ownValue(point, 'asDouble');
  const i = ownValue(point, 'asInt');
  if (d !== undefined && i !== undefined) return null;
  if (d !== undefined) return typeof d === 'number' && Number.isFinite(d) ? d : null;
  if (i !== undefined) return parseInt64AsSafe(i);
  return null;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * `v × 10^places`, rounded half-up on the decimal value of `v` (its shortest round-trip representation),
 * not on the binary product: `Math.round(0.0001245 * 1e6)` is 124 because the product is 124.49999…, while
 * this returns 125. For non-negative finite `v` only; returns null otherwise or if the result is unsafe.
 */
export function scaleHalfUp(v: number, places: number): number | null {
  if (!Number.isFinite(v) || v < 0 || !Number.isInteger(places) || places < 0) return null;
  const m = DECIMAL_RE.exec(String(v));
  if (m === null) return null;
  const [, int = '', frac = '', exp = '0'] = m;
  const digits = BigInt(int + frac);
  const shift = Number(exp) - frac.length + places;
  let result: bigint;
  if (shift >= 0) {
    result = digits * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    result = digits / div;
    if ((digits % div) * 2n >= div) result += 1n;
  }
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}
