/**
 * OTLP projection: untrusted Claude Code OTLP/HTTP JSON → integer usage samples.
 *
 * The body is expected to be JSON.parse output from a loopback receiver that any local process can reach.
 * Only own data properties are read (no inherited keys, no getters); nothing is copied or spread from the
 * input. Projection never throws: every malformed node is counted in `rejected`.
 *
 * Stream identity (P1-02): before any attribute is dropped, every sample gets
 * `streamKey = hash('stream', canonicalJSON({ resource, scope, instrument, unit, temporality, monotonic,
 * pointAttributes }))` over ALL resource and point attributes. Identity attributes (user email, account ids,
 * organization) thus still separate streams, but the canonical string is only ever passed to `hash`; it is
 * never stored or returned. After that, only `session.id`, `model` and (per instrument) `type` are kept.
 *
 * Phase 1 accepts no OTLP logs: cost comes from the metric only (D10), the timeline from hooks.
 */
import { nanosToMs, parseNanos, parseValue, scaleHalfUp } from './otlp-numbers.js';
import { isRecord, items, own, ownArray } from './own.js';
import type { DetailLevel, HashFn, Named } from './types.js';
import * as validate from './validate.js';

/**
 * Transport limit for the receiver (Plan 3): the maximum OTLP request body in bytes, enforced BEFORE JSON
 * parsing and AFTER decompression (a compressed body is measured by its decompressed size). Projection
 * itself does not measure size; it assumes this bound was applied.
 */
export const MAX_OTLP_BODY_BYTES = 8 * 1024 * 1024;

export type Instrument =
  | 'claude_code.cost.usage' | 'claude_code.token.usage' | 'claude_code.active_time.total' | 'claude_code.session.count';

export interface UsageSample {
  source: 'claude-code-otlp';
  /** Keyed hash of the full stream identity; distinguishes streams without storing identity attributes. */
  streamKey: string;
  /** Validated `session.id` attribute; null when absent or not a UUID. Never inferred from timing. */
  sessionId: string | null;
  instrument: Instrument;
  unit: 'micro_usd' | 'tokens' | 'ms' | 'count';
  attributes: { model?: Named; type?: string };
  /** null = unknown interval start (absent or 0); such samples cannot be attributed to a segment. */
  startNs: string | null;
  endNs: string;
  startMs: number | null;
  endMs: number;
  /** Always a non-negative safe integer in `unit`. */
  value: number;
  temporality: 'delta' | 'cumulative';
  monotonic: boolean;
}

export interface OtlpProjectionContext { level: DetailLevel; hash: HashFn }

export interface OtlpMetricsResult {
  samples: UsageSample[];
  /** Malformed or unsupported nodes; a node failing above the data-point level counts once per data point when they can be counted. */
  rejected: number;
  /** Data points flagged "no recorded value" (flags bit 0): not samples, never zero. */
  noValue: number;
}

interface InstrumentSpec {
  units: readonly string[];
  unit: UsageSample['unit'];
  /** Converts a parsed value to an integer in `unit`, or null when negative / out of bounds / non-integer. */
  convert: (v: number) => number | null;
  types: ReadonlySet<string> | null;
}

const inRange = (v: number, max: number) => v >= 0 && v <= max;

const INSTRUMENTS: ReadonlyMap<string, InstrumentSpec> = new Map<Instrument, InstrumentSpec>([
  ['claude_code.cost.usage', {
    units: ['USD'], unit: 'micro_usd', types: null,
    // Half-up on the decimal value: see scaleHalfUp (more exact than Math.round(usd * 1e6)).
    convert: (usd) => (inRange(usd, 1_000_000) ? scaleHalfUp(usd, 6) : null),
  }],
  ['claude_code.token.usage', {
    units: ['tokens'], unit: 'tokens', types: new Set(['input', 'output', 'cacheRead', 'cacheCreation']),
    convert: (n) => (Number.isInteger(n) && inRange(n, 1_000_000_000) ? n : null),
  }],
  ['claude_code.active_time.total', {
    units: ['s'], unit: 'ms', types: new Set(['user', 'cli']),
    convert: (s) => (inRange(s, 86_400) ? scaleHalfUp(s, 3) : null),
  }],
  ['claude_code.session.count', {
    units: ['', 'count'], unit: 'count', types: null,
    convert: (n) => (Number.isInteger(n) && inRange(n, 1_000_000) ? n : null),
  }],
]);

const CLAUDE_MODEL = /^claude-[a-z0-9.-]{1,48}$/;
const READABLE_MODEL = /^[A-Za-z0-9._:-]{1,64}$/;

/** Bounds on attribute structures, which feed the stream key (loopback input is untrusted). */
const MAX_ATTRIBUTES = 128;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_NODES = 1_000;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

class Malformed extends Error {}

/** A fresh JSON copy of an untrusted value (own data properties only), bounded in depth and size. */
function toJson(v: unknown, depth: number, budget: { nodes: number }): Json {
  if (--budget.nodes < 0 || depth > MAX_VALUE_DEPTH) throw new Malformed();
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Malformed();
    return v;
  }
  if (Array.isArray(v)) {
    const out: Json[] = [];
    for (let i = 0; i < v.length; i++) out.push(toJson(own(v, String(i)), depth + 1, budget));
    return out;
  }
  if (isRecord(v)) {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v)) {
      const x = own(v, k);
      if (x !== undefined) Object.defineProperty(out, k, { value: toJson(x, depth + 1, budget), enumerable: true });
    }
    return out;
  }
  throw new Malformed();
}

/** Deterministic JSON: object keys sorted by UTF-16 code units, no whitespace. */
function canonicalJSON(v: Json): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k] as Json)}`).join(',')}}`;
}

/** An OTLP KeyValue list as a key → AnyValue map. Duplicate keys, non-string keys or oversize → Malformed. */
function attributeMap(raw: unknown): Map<string, Json> {
  const map = new Map<string, Json>();
  if (raw === undefined) return map;
  if (!Array.isArray(raw) || raw.length > MAX_ATTRIBUTES) throw new Malformed();
  const budget = { nodes: MAX_VALUE_NODES };
  for (let i = 0; i < raw.length; i++) {
    const kv = own(raw, String(i));
    if (!isRecord(kv)) throw new Malformed();
    const key = own(kv, 'key');
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || map.has(key)) throw new Malformed();
    const value = own(kv, 'value');
    if (value !== undefined && !isRecord(value)) throw new Malformed();
    map.set(key, value === undefined ? null : toJson(value, 0, budget));
  }
  return map;
}

/** Object.fromEntries defines own properties, so a '__proto__' key stays plain data. */
const mapToJson = (m: Map<string, Json>): Json => Object.fromEntries(m);

function stringAttr(m: Map<string, Json>, key: string): string | undefined {
  const v = m.get(key);
  if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const s = Object.hasOwn(v, 'stringValue') ? v['stringValue'] : undefined;
  return typeof s === 'string' ? s : undefined;
}

function classifyModel(v: string, ctx: OtlpProjectionContext): Named {
  if (CLAUDE_MODEL.test(v)) return { name: v };
  if (ctx.level !== 'metadata' && READABLE_MODEL.test(v)) return { name: v };
  return { name: 'other', pseudonym: ctx.hash('model', v) };
}

function countPoints(metric: unknown): number {
  if (!isRecord(metric)) return 1;
  const sum = own(metric, 'sum');
  if (!isRecord(sum)) return 1;
  const points = ownArray(sum, 'dataPoints');
  return Array.isArray(points) ? Math.max(points.length, 1) : 1;
}

interface MetricHeader {
  instrument: Instrument;
  spec: InstrumentSpec;
  unit: string;
  temporality: 'delta' | 'cumulative';
  monotonic: boolean;
  /** `sum.dataPoints`: undefined when absent, null when not an array. */
  points: readonly unknown[] | undefined | null;
}

function metricHeader(metric: object): MetricHeader | null {
  const name = own(metric, 'name');
  const unit = own(metric, 'unit');
  const sum = own(metric, 'sum');
  if (typeof name !== 'string' || typeof unit !== 'string' || !isRecord(sum)) return null;
  const spec = INSTRUMENTS.get(name);
  if (spec === undefined || !spec.units.includes(unit)) return null;
  const t = own(sum, 'aggregationTemporality');
  if (t !== 1 && t !== 2) return null;
  const mono = own(sum, 'isMonotonic');
  if (mono !== undefined && typeof mono !== 'boolean') return null;
  return {
    instrument: name as Instrument, spec, unit,
    temporality: t === 1 ? 'delta' : 'cumulative', monotonic: mono ?? false, points: ownArray(sum, 'dataPoints'),
  };
}

type PointOutcome = UsageSample | 'rejected' | 'no-value';

function projectPoint(
  point: unknown, header: MetricHeader, resource: Json, scope: Json, ctx: OtlpProjectionContext,
): PointOutcome {
  if (!isRecord(point)) return 'rejected';
  const flags = own(point, 'flags');
  if (flags !== undefined && !(typeof flags === 'number' && Number.isSafeInteger(flags) && flags >= 0)) return 'rejected';
  if (flags !== undefined && flags % 2 === 1) return 'no-value';

  const endNs = parseNanos(own(point, 'timeUnixNano'));
  if (endNs === null || endNs === '0') return 'rejected';
  const startRaw = own(point, 'startTimeUnixNano');
  let startNs: string | null = null;
  if (startRaw !== undefined) {
    startNs = parseNanos(startRaw);
    if (startNs === null) return 'rejected';
    if (startNs === '0') startNs = null; // OTLP: 0 means unset
  }
  if (startNs !== null && BigInt(endNs) < BigInt(startNs)) return 'rejected';

  const raw = parseValue(point);
  if (raw === null) return 'rejected';
  const value = header.spec.convert(raw);
  if (value === null) return 'rejected';

  const attrs = attributeMap(own(point, 'attributes'));
  // Stream key over everything, BEFORE any attribute is dropped. The canonical string is never kept.
  const streamKey = ctx.hash('stream', canonicalJSON({
    resource, scope, instrument: header.instrument, unit: header.unit,
    temporality: header.temporality === 'delta' ? 1 : 2, monotonic: header.monotonic, pointAttributes: mapToJson(attrs),
  }));

  const attributes: UsageSample['attributes'] = {};
  const model = stringAttr(attrs, 'model');
  if (model !== undefined) attributes.model = classifyModel(model, ctx);
  if (header.spec.types !== null) {
    const type = stringAttr(attrs, 'type');
    if (type !== undefined) attributes.type = header.spec.types.has(type) ? type : 'other';
  }

  return {
    source: 'claude-code-otlp',
    streamKey,
    sessionId: validate.sessionId(stringAttr(attrs, 'session.id')) ?? null,
    instrument: header.instrument,
    unit: header.spec.unit,
    attributes,
    startNs,
    endNs,
    startMs: startNs === null ? null : nanosToMs(startNs),
    endMs: nanosToMs(endNs),
    value,
    temporality: header.temporality,
    monotonic: header.monotonic,
  };
}

function scopeIdentity(raw: unknown): Json {
  if (raw === undefined) return { name: null, version: null };
  if (!isRecord(raw)) throw new Malformed();
  const name = own(raw, 'name');
  const version = own(raw, 'version');
  if ((name !== undefined && typeof name !== 'string') || (version !== undefined && typeof version !== 'string')) {
    throw new Malformed();
  }
  return { name: name ?? null, version: version ?? null };
}

function resourceIdentity(raw: unknown): Json {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Malformed();
  return mapToJson(attributeMap(own(raw, 'attributes')));
}

export function projectOtlpMetrics(body: unknown, ctx: OtlpProjectionContext): OtlpMetricsResult {
  const result: OtlpMetricsResult = { samples: [], rejected: 0, noValue: 0 };
  try {
    if (!isRecord(body)) { result.rejected++; return result; }
    const rms = ownArray(body, 'resourceMetrics');
    if (rms === null) { result.rejected++; return result; }
    for (const rm of items(rms)) projectResourceMetrics(rm, ctx, result);
  } catch {
    // Defensive: no path above is expected to throw; never propagate on untrusted input.
    result.rejected++;
  }
  return result;
}

function projectResourceMetrics(rm: unknown, ctx: OtlpProjectionContext, result: OtlpMetricsResult): void {
  if (!isRecord(rm)) { result.rejected++; return; }
  const sms = ownArray(rm, 'scopeMetrics');
  if (sms === null) { result.rejected++; return; }
  let resource: Json;
  try {
    resource = resourceIdentity(own(rm, 'resource'));
  } catch {
    // A malformed resource rejects everything under it, counted per data point where countable.
    for (const sm of items(sms)) {
      const ms = isRecord(sm) ? ownArray(sm, 'metrics') : null;
      if (Array.isArray(ms)) rejectMetrics(ms, result);
      else result.rejected++;
    }
    if (sms === undefined) result.rejected++;
    return;
  }
  for (const sm of items(sms)) {
    if (!isRecord(sm)) { result.rejected++; continue; }
    const ms = ownArray(sm, 'metrics');
    if (ms === null) { result.rejected++; continue; }
    let scope: Json;
    try {
      scope = scopeIdentity(own(sm, 'scope'));
    } catch {
      if (ms === undefined) result.rejected++;
      else rejectMetrics(ms, result);
      continue;
    }
    for (const metric of items(ms)) projectMetric(metric, resource, scope, ctx, result);
  }
}

/** Rejects every metric of a list, counted per data point where countable. */
function rejectMetrics(ms: readonly unknown[], result: OtlpMetricsResult): void {
  for (const m of items(ms)) result.rejected += countPoints(m);
}

function projectMetric(metric: unknown, resource: Json, scope: Json, ctx: OtlpProjectionContext, result: OtlpMetricsResult): void {
  if (!isRecord(metric)) { result.rejected++; return; }
  const header = metricHeader(metric);
  if (header === null) { result.rejected += countPoints(metric); return; }
  if (header.points === null) { result.rejected++; return; }
  for (const point of items(header.points)) {
    let outcome: PointOutcome;
    try {
      outcome = projectPoint(point, header, resource, scope, ctx);
    } catch {
      outcome = 'rejected'; // Malformed attributes, or a failing caller-supplied hash.
    }
    if (outcome === 'rejected') result.rejected++;
    else if (outcome === 'no-value') result.noValue++;
    else result.samples.push(outcome);
  }
}

/**
 * Phase 1 accepts no OTLP logs (D10: cost only from the metric; timeline from hooks). Every log record is
 * counted as rejected, as is every malformed node; nothing is read beyond structure.
 */
export function projectOtlpLogs(body: unknown): { accepted: 0; rejected: number } {
  let rejected = 0;
  try {
    if (!isRecord(body)) return { accepted: 0, rejected: 1 };
    const rls = ownArray(body, 'resourceLogs');
    if (rls === null) return { accepted: 0, rejected: 1 };
    for (const rl of items(rls)) {
      const sls = isRecord(rl) ? ownArray(rl, 'scopeLogs') : null;
      if (sls === null) { rejected++; continue; }
      for (const sl of items(sls)) {
        const recs = isRecord(sl) ? ownArray(sl, 'logRecords') : null;
        if (recs === null) { rejected++; continue; }
        rejected += recs?.length ?? 0;
      }
    }
  } catch {
    rejected++;
  }
  return { accepted: 0, rejected };
}
