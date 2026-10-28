/**
 * @fileoverview Field helpers shared by the USGS product projections — upstream
 * product properties and QuakeML values all arrive as strings.
 * @module services/usgs/product-fields
 */

/** Parse an upstream numeric string into a finite number; absent, blank, or unparseable yields undefined. */
export function num(value: string | undefined): number | undefined {
  if (value == null || value.trim().length === 0) return;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Contribute `{ key: value }` when the value survived projection, nothing when it did not. */
export function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
