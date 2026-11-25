import { parseNanos, nanosToMs, parseValue, scaleHalfUp } from '../src/index.js';

describe('parseNanos', () => {
  test('19-digit nanosecond strings parse exactly', () => {
    expect(parseNanos('1795600800123456789')).toBe('1795600800123456789');
    expect(nanosToMs('1795600800123456789')).toBe(1795600800123);
    expect(parseNanos(2 ** 60)).toBeNull();
  });
  test.each([
    ['0', '0'], ['000123', '123'], ['9223372036854775807', '9223372036854775807'],
    [0, '0'], [1_795_595_877, '1795595877'], [Number.MAX_SAFE_INTEGER, '9007199254740991'],
  ])('accepts %j → %s', (input, out) => { expect(parseNanos(input)).toBe(out); });
  test.each([
    ['2^63', '9223372036854775808'], ['21 digits', '123456789012345678901'], ['empty', ''],
    ['negative string', '-1'], ['sign', '+1'], ['decimal', '1.5'], ['exponent', '1e9'], ['whitespace', ' 1'],
    ['hex', '0x10'], ['newline', '1\n'], ['negative number', -1], ['fraction', 1.5], ['NaN', NaN],
    ['Infinity', Infinity], ['unsafe', 2 ** 53], ['bigint', 1n], ['null', null], ['undefined', undefined],
    ['object', { valueOf: () => 1 }], ['array', ['1']], ['boolean', true],
  ])('rejects %s', (_, input) => { expect(parseNanos(input)).toBeNull(); });
});

describe('nanosToMs', () => {
  test('truncates toward zero', () => {
    expect(nanosToMs('0')).toBe(0);
    expect(nanosToMs('999999')).toBe(0);
    expect(nanosToMs('1000000')).toBe(1);
    expect(nanosToMs('9223372036854775807')).toBe(9223372036854);
  });
});

describe('parseValue', () => {
  test.each([
    [{ asDouble: 0.00228769 }, 0.00228769], [{ asDouble: 0 }, 0], [{ asDouble: -2 }, -2],
    [{ asInt: '42' }, 42], [{ asInt: '-7' }, -7], [{ asInt: 42 }, 42], [{ asInt: '9007199254740991' }, 9007199254740991],
  ])('accepts %j', (point, out) => { expect(parseValue(point)).toBe(out); });
  test.each([
    ['NaN', { asDouble: NaN }], ['Infinity', { asDouble: Infinity }], ['-Infinity', { asDouble: -Infinity }],
    ['string double', { asDouble: '1.5' }], ['unsafe asInt string', { asInt: '9007199254740992' }],
    ['unsafe asInt number', { asInt: 2 ** 60 }], ['fractional asInt', { asInt: 1.5 }], ['asInt decimal', { asInt: '1.5' }],
    ['asInt exponent', { asInt: '1e3' }], ['no value', {}], ['null', null], ['array', [1]],
    ['both set', { asDouble: 1, asInt: '1' }],
    ['inherited asDouble', Object.create({ asDouble: 1 })],
  ])('rejects %s', (_, point) => { expect(parseValue(point)).toBeNull(); });
  test('never invokes a getter', () => {
    const p = {};
    Object.defineProperty(p, 'asDouble', { get() { throw new Error('getter'); }, enumerable: true });
    expect(parseValue(p)).toBeNull();
  });
});

describe('scaleHalfUp', () => {
  test.each([
    [0.00228769, 6, 2288], [0.0001245, 6, 125], [5e-7, 6, 1], [4.9e-7, 6, 0], [0, 6, 0], [1_000_000, 6, 1e12],
    [1.5, 3, 1500], [0.0005, 3, 1], [0.0004999, 3, 0], [1e-300, 6, 0], [86_400, 3, 86_400_000], [7, 0, 7],
  ])('%d × 10^%d → %d', (v, places, out) => { expect(scaleHalfUp(v, places)).toBe(out); });
  test.each([[-1, 6], [NaN, 6], [Infinity, 6], [1, -1], [1, 1.5], [1e300, 6]])('rejects %d × 10^%d', (v, places) => {
    expect(scaleHalfUp(v, places)).toBeNull();
  });
});
