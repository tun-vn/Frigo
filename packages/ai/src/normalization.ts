import { findCanonicalIngredient, findCanonicalIngredientById } from '@frigo/domain';
import type { CanonicalIngredient } from '@frigo/domain';

/**
 * Coerce the number formats commonly emitted by Vietnamese OCR models.
 *
 * Vietnamese receipts use a dot or comma as a thousands separator (for
 * example, `42.000`), while model confidence/quantity values may use a comma
 * as a decimal separator (`0,91`).  A three-digit final group is therefore
 * treated as thousands unless the integer part is zero; shorter groups are
 * treated as a decimal fraction.
 */
export function normalizeOcrNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const compact = value.trim().replace(/\s+/g, '');
  if (!compact) return value;

  // Keep digits and separators, while allowing currency/unit text around the
  // number (for example, "42.000đ" or "₫42,000").
  const cleaned = compact.replace(/[^0-9.,+-]/g, '');
  const sign = cleaned.startsWith('-') ? '-' : '';
  const unsigned = cleaned.replace(/^[+-]/, '').replace(/[+-]/g, '');
  if (!/\d/.test(unsigned)) return value;

  const commaIndex = unsigned.lastIndexOf(',');
  const dotIndex = unsigned.lastIndexOf('.');
  let normalized: string;

  if (commaIndex >= 0 && dotIndex >= 0) {
    // The last separator is the decimal marker when both styles are present;
    // all earlier separators are grouping markers.
    const decimalIndex = Math.max(commaIndex, dotIndex);
    const integerPart = unsigned.slice(0, decimalIndex).replace(/[.,]/g, '');
    const fractionPart = unsigned.slice(decimalIndex + 1).replace(/[.,]/g, '');
    normalized = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  } else if (commaIndex >= 0 || dotIndex >= 0) {
    const separator = commaIndex >= 0 ? ',' : '.';
    const groups = unsigned.split(separator);
    const fractionPart = groups[groups.length - 1] || '';
    const integerGroups = groups.slice(0, -1);
    const integerPart = integerGroups.join('');
    const groupedInteger = integerGroups.length > 0
      && integerGroups.every((group, index) => index === 0 || group.length === 3);

    if (groups.length > 2 && !groupedInteger) {
      // Non-standard repeated separators are safer as grouping marks than as
      // an invented fractional value.
      normalized = groups.join('');
    } else if (fractionPart.length === 3 && integerPart !== '0' && integerPart.length > 0) {
      // `42.000` / `42,000` are Vietnamese-style thousands separators.
      normalized = `${integerPart}${fractionPart}`;
    } else if (fractionPart) {
      // `0,91`, `12.5`, and grouped values such as `1.234,56` reach here.
      normalized = `${integerPart || '0'}.${fractionPart}`;
    } else {
      normalized = integerPart;
    }
  } else {
    normalized = unsigned;
  }

  const parsed = Number(`${sign}${normalized}`);
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * Prefer a deterministic name/alias match, then retain a provider-supplied
 * canonical ID only when it resolves to a catalog entry.  This prevents an
 * untrusted model ID from violating the scan_items ingredient foreign key.
 */
export function resolveProviderCanonical(
  rawName: string,
  providerCanonicalId?: unknown,
): CanonicalIngredient | null {
  const byName = findCanonicalIngredient(rawName);
  if (byName) return byName;
  return findCanonicalIngredientById(providerCanonicalId);
}
