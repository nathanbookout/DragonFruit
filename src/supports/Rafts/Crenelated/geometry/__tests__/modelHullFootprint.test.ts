import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import type { PlateFootprintSource } from '../modelPlateFootprint';
import { computeRaftFootprintPolygons } from '../computeRaftFootprint';
import { modelHullFootprintCircles } from '../modelHullFootprint';
import { polygonSetAreaMm2, type PolygonWithHoles } from '../polygonSet2d';
import { DEFAULT_RAFT_SETTINGS } from '../../RaftDefaults';

// A 20 x 10 x 5 mm box lifted 5 mm off the plate (so no plate clearance applies),
// centred at (30, 40).
const liftedBox = (): PlateFootprintSource => ({
  id: 'box',
  geometry: { geometry: new THREE.BoxGeometry(20, 10, 5), center: new THREE.Vector3(0, 0, 0) },
  transform: {
    position: new THREE.Vector3(30, 40, 7.5),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(1, 1, 1),
  },
});

function xBounds(polys: readonly PolygonWithHoles[]) {
  let min = Infinity;
  let max = -Infinity;
  for (const poly of polys) for (const p of poly.outer) { min = Math.min(min, p.x); max = Math.max(max, p.x); }
  return { min, max };
}

test('model hull circles trace the projected box, grown about its centre', () => {
  const circles = modelHullFootprintCircles(liftedBox(), 10);
  const xs = circles.map((c) => c.x);
  const ys = circles.map((c) => c.y);
  // 20 mm wide grown 10% -> 22 mm, centred on x = 30.
  assert.ok(Math.abs(Math.min(...xs) - 19) < 1e-6);
  assert.ok(Math.abs(Math.max(...xs) - 41) < 1e-6);
  assert.ok(Math.abs(Math.min(...ys) - 34.5) < 1e-6);
  assert.ok(Math.abs(Math.max(...ys) - 45.5) < 1e-6);
  assert.ok(circles.every((c) => c.r === 0));
});

test('supports-only footprint ignores the model; supports + model covers it', () => {
  const model = liftedBox();
  // One support root at the box's left end.
  const circles = [{ x: 22, y: 40, r: 1 }];

  const supportsOnly = computeRaftFootprintPolygons({ circles, raft: DEFAULT_RAFT_SETTINGS, model });
  const withModel = computeRaftFootprintPolygons({
    circles,
    raft: { ...DEFAULT_RAFT_SETTINGS, footprintMode: 'supportsAndModel', modelFootprintMarginPct: 10 },
    model,
  });

  assert.ok(xBounds(supportsOnly).max < 25, 'supports-only stays around the root');
  assert.ok(xBounds(withModel).max >= 41, 'supports + model reaches the grown model edge');
  assert.ok(polygonSetAreaMm2(withModel) > 22 * 11, 'covers at least the grown model hull');
});

test('hull follows the model when it moves in X/Y', () => {
  const model = liftedBox();
  const before = modelHullFootprintCircles(model, 0);
  model.transform.position.x += 15;
  const after = modelHullFootprintCircles(model, 0);
  assert.ok(Math.abs(Math.min(...after.map((c) => c.x)) - (Math.min(...before.map((c) => c.x)) + 15)) < 1e-6);
});
