import * as THREE from 'three';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import type { RaftSettings, SupportBaseCircle } from '../RaftTypes';
import type { PlateFootprintSource } from './modelPlateFootprint';

/**
 * The model's convex hull projected straight down onto the plate, grown by a
 * percentage about its centroid. Used by the `supportsAndModel` raft footprint
 * mode so the raft also covers the area under the model, not just its supports.
 *
 * The hull depends on rotation and scale but not on X/Y position, so it is
 * cached without them and translated on read: dragging a model across the plate
 * does not re-walk its vertices.
 */

const CACHE_MAX_ENTRIES = 32;
const hullCache = new Map<string, Float64Array>();

const matrixScratch = new THREE.Matrix4();
const quaternionScratch = new THREE.Quaternion();
const zeroScratch = new THREE.Vector3();

function q(value: number): string {
  return (Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : 0).toString();
}

/** Monotone-chain convex hull over flat [x0, y0, x1, y1, ...] points; CCW, no repeat. */
function convexHullFlat(xs: Float64Array, ys: Float64Array): Float64Array {
  const n = xs.length;
  if (n < 3) return new Float64Array(0);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  order.sort((a, b) => (xs[a] - xs[b]) || (ys[a] - ys[b]));

  const hull = new Uint32Array(2 * n);
  let k = 0;
  const cross = (o: number, a: number, b: number) =>
    (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);

  for (let i = 0; i < n; i += 1) {
    const p = order[i];
    while (k >= 2 && cross(hull[k - 2], hull[k - 1], p) <= 0) k -= 1;
    hull[k++] = p;
  }
  for (let i = n - 2, lower = k + 1; i >= 0; i -= 1) {
    const p = order[i];
    while (k >= lower && cross(hull[k - 2], hull[k - 1], p) <= 0) k -= 1;
    hull[k++] = p;
  }

  const count = k - 1;
  const out = new Float64Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    out[i * 2] = xs[hull[i]];
    out[i * 2 + 1] = ys[hull[i]];
  }
  return out;
}

/** Hull of the model's world-space XY projection, relative to its X/Y position. */
function originRelativeHull(source: PlateFootprintSource): Float64Array {
  const { geometry, center } = source.geometry;
  const { transform } = source;
  const key = [
    geometry.uuid,
    q(center.x), q(center.y), q(center.z),
    q(transform.rotation.x), q(transform.rotation.y), q(transform.rotation.z),
    q(transform.scale.x), q(transform.scale.y), q(transform.scale.z),
  ].join('|');

  const cached = hullCache.get(key);
  if (cached) {
    hullCache.delete(key);
    hullCache.set(key, cached);
    return cached;
  }

  const position = geometry.getAttribute('position');
  if (!position || position.count < 3) return new Float64Array(0);

  matrixScratch.compose(
    zeroScratch.set(0, 0, 0),
    quaternionScratch.copy(quaternionFromGlobalEuler(transform.rotation)),
    transform.scale,
  );
  const e = matrixScratch.elements;
  const count = position.count;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const x = position.getX(i) - center.x;
    const y = position.getY(i) - center.y;
    const z = position.getZ(i) - center.z;
    xs[i] = e[0] * x + e[4] * y + e[8] * z;
    ys[i] = e[1] * x + e[5] * y + e[9] * z;
  }

  const hull = convexHullFlat(xs, ys);
  hullCache.set(key, hull);
  while (hullCache.size > CACHE_MAX_ENTRIES) {
    const oldest = hullCache.keys().next().value;
    if (oldest === undefined) break;
    hullCache.delete(oldest);
  }
  return hull;
}

/**
 * Zero-radius "circles" on the grown model hull, ready to join the support-root
 * circles that the raft footprint hull is computed from.
 */
export function modelHullFootprintCircles(
  source: PlateFootprintSource,
  marginPct: number,
): SupportBaseCircle[] {
  const hull = originRelativeHull(source);
  const count = hull.length / 2;
  if (count < 3) return [];

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i += 1) {
    cx += hull[i * 2];
    cy += hull[i * 2 + 1];
  }
  cx /= count;
  cy /= count;

  const scale = 1 + Math.max(0, Number(marginPct) || 0) / 100;
  const px = source.transform.position.x;
  const py = source.transform.position.y;
  const circles: SupportBaseCircle[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    circles[i] = {
      x: px + cx + (hull[i * 2] - cx) * scale,
      y: py + cy + (hull[i * 2 + 1] - cy) * scale,
      r: 0,
    };
  }
  return circles;
}

/** The circles a raft footprint should include for `model` under `raft`'s mode. */
export function raftModelFootprintCircles(
  raft: Pick<RaftSettings, 'footprintMode' | 'modelFootprintMarginPct'>,
  model: PlateFootprintSource | null | undefined,
): SupportBaseCircle[] {
  if (raft.footprintMode !== 'supportsAndModel' || !model || model.visible === false) return [];
  return modelHullFootprintCircles(model, raft.modelFootprintMarginPct);
}

/** The source for `modelId` among `sources`, matched on the optional `id`. */
export function findPlateFootprintSource(
  sources: readonly PlateFootprintSource[] | null | undefined,
  modelId: string | null | undefined,
): PlateFootprintSource | null {
  if (!sources || !modelId) return null;
  return sources.find((source) => source.id === modelId) ?? null;
}
