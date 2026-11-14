/**
 * @fileoverview Normalize the preferred ShakeMap product's published PGA and PGV maxima.
 * @module services/usgs/shakemap-maxima
 */

import { maybe, num } from './product-fields.js';
import type { UsgsProduct, UsgsShakeMapProperties } from './types.js';

/** First build with linear PGV for each proven tag lineage, from ShakeMap commit 8a58dbe8. */
const LINEAR_PGV_BUILD = new Map([
  ['1', 669],
  ['2', 479],
  ['3', 21],
  ['4', 15],
]);

/** Convert maxima from the known producer encodings into g and cm/s. */
export function shakeMapMaxima(product: UsgsProduct<UsgsShakeMapProperties> | undefined) {
  const properties = product?.properties;
  const version = properties?.['shakemap-code-version'];
  let pga = num(properties?.maxpga);
  let pgv = num(properties?.maxpgv);
  const build = version?.match(
    /^4\.0\.([0-4])(?:\+(0|[1-9][0-9]*)\.g[0-9a-f]{7,40}(?:\.dirty)?)?(?![\s\S])/,
  );
  if (build) {
    const [, patch, count] = build;
    const buildNumber = Number(count ?? '0');
    // Only the tagged revision of 4.0.0 is classified.
    const tagged = buildNumber === 0;
    const linearPgv = LINEAR_PGV_BUILD.get(patch ?? '');
    if (pgv !== undefined && (tagged || (linearPgv !== undefined && buildNumber < linearPgv))) {
      pgv = Math.exp(pgv);
    }
    // ShakeMap commit 564a244b made acceleration metadata linear before PGV was fixed.
    if (pga !== undefined && ((patch === '0' && tagged) || (patch === '1' && buildNumber < 102))) {
      pga = Math.exp(pga);
    }
  } else if (
    pga !== undefined &&
    version === undefined &&
    product?.contents &&
    Object.hasOwn(product.contents, 'download/grid.xyz.zip')
  ) {
    pga /= 100;
  }
  return {
    ...maybe('max_pga', Number.isFinite(pga) ? pga : undefined),
    ...maybe('max_pgv', Number.isFinite(pgv) ? pgv : undefined),
  };
}
