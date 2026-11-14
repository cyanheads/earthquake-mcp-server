/**
 * @fileoverview Project preferred tensor metadata and an attributed nodal-plane solution.
 * @module services/usgs/moment-tensor
 */

import { maybe, num } from './product-fields.js';
import type {
  EarthquakeEventDetail,
  NodalPlane,
  UsgsMomentTensorProperties,
  UsgsNodalPlaneProperties,
  UsgsProduct,
} from './types.js';

type MomentTensor = NonNullable<EarthquakeEventDetail['moment_tensor']>;
type ProductType = NonNullable<MomentTensor['nodal_planes_from']>['product'];

function readPlane(
  properties: UsgsNodalPlaneProperties | undefined,
  plane: 1 | 2,
): NodalPlane | undefined {
  const strike = num(properties?.[`nodal-plane-${plane}-strike`]);
  const dip = num(properties?.[`nodal-plane-${plane}-dip`]);
  const rake = num(properties?.[`nodal-plane-${plane}-rake`]);
  if (strike === undefined || dip === undefined || rake === undefined) return;
  return { strike, dip, rake };
}

function readSolution(product: ProductType, entry: UsgsProduct<UsgsNodalPlaneProperties>) {
  return {
    first: readPlane(entry.properties, 1),
    second: readPlane(entry.properties, 2),
    provenance: { product, ...maybe('source', entry.source), ...maybe('code', entry.code) },
  };
}

/** Select one complete pair in product order, retaining a preferred single plane if none exists. */
export function projectMomentTensor(
  products: Record<string, UsgsProduct[] | undefined>,
): MomentTensor {
  const preferred = products['moment-tensor']?.[0] as
    | UsgsProduct<UsgsMomentTensorProperties>
    | undefined;
  const preferredSolution = preferred && readSolution('moment-tensor', preferred);
  let solution = preferredSolution;

  if (!solution?.first || !solution.second) {
    search: for (const type of ['moment-tensor', 'focal-mechanism'] as const) {
      const entries = products[type];
      if (!entries) continue;
      for (let index = type === 'moment-tensor' ? 1 : 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const candidate = readSolution(type, entry);
        if (candidate.first && candidate.second) {
          solution = candidate;
          break search;
        }
      }
    }
  }

  const properties = preferred?.properties;
  return {
    ...maybe('scalar_moment_nm', num(properties?.['scalar-moment'])),
    ...maybe('derived_depth_km', num(properties?.['derived-depth'])),
    ...maybe('magnitude', num(properties?.['derived-magnitude'])),
    ...maybe('magnitude_type', properties?.['derived-magnitude-type']),
    ...maybe('percent_double_couple', num(properties?.['percent-double-couple'])),
    ...maybe('source', preferred?.source),
    ...maybe('nodal_plane_1', solution?.first),
    ...maybe('nodal_plane_2', solution?.second),
    ...maybe(
      'nodal_planes_from',
      solution?.first || solution?.second ? solution.provenance : undefined,
    ),
  };
}
