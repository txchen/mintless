import { formatMinor } from '../../shared/money.ts';

export { formatMinor };

const dayFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDateYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const stamp = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

export const formatDay = (iso: string) => dayFormat.format(asDate(iso));
export const formatShortDate = (iso: string) =>
  (asDate(iso).getUTCFullYear() === new Date().getFullYear() ? shortDate : shortDateYear).format(asDate(iso));
export const formatStamp = (ms: number | null) => (ms === null ? 'never' : stamp.format(new Date(ms)));

export function formatRelative(ms: number | null) {
  if (ms === null) return 'never';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatStamp(ms);
}

export function displayAmount(providerMinor: number, currency: string) {
  const inflow = providerMinor < 0;
  return { text: `${inflow ? '+' : '−'}${formatMinor(Math.abs(providerMinor), currency)}`, inflow };
}
