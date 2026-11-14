const exponents: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3, JOD: 3, OMR: 3, TND: 3 };

export const currencyExponent = (currency: string) => exponents[currency.toUpperCase()] ?? 2;

export function toMinorUnits(amount: number, currency: string): number {
  const exponent = currencyExponent(currency);
  const [whole = '0', fraction = ''] = Math.abs(amount)
    .toFixed(exponent + 2)
    .split('.');
  const digits = BigInt(whole + fraction.slice(0, exponent).padEnd(exponent, '0'));
  const rest = fraction.slice(exponent);
  const rounded = Number(rest) >= 5 * 10 ** (rest.length - 1) ? digits + 1n : digits;
  const result = Number(rounded);
  return amount < 0 && result !== 0 ? -result : result;
}

export function formatMinor(
  minor: number,
  currency: string,
  opts: { signDisplay?: 'auto' | 'never' | 'always' } = {},
) {
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    signDisplay: opts.signDisplay ?? 'auto',
  }).format(minor / 10 ** exponent);
}

export type Direction = 'outflow' | 'inflow';

export const directionOf = (providerAmountMinor: number): Direction =>
  providerAmountMinor > 0 ? 'outflow' : 'inflow';
