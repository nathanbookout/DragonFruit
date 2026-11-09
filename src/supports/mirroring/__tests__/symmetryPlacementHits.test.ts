import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

import { symmetryPlacementHits } from '../supportMirroring';
import { getSupportSymmetrySettings, updateSupportSymmetrySettings } from '@/supports/Settings/state';

function boxMesh(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  // The app builds a BVH for every model; surface-reachability checks use it.
  (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = new MeshBVH(geometry);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.set(0, 0, 20);
  mesh.userData.modelId = 'box';
  mesh.updateMatrixWorld(true);
  return mesh;
}

test('mirror X yields a real surface hit on the opposite face', () => {
  const previous = { ...getSupportSymmetrySettings() };
  try {
    updateSupportSymmetrySettings({ mode: 'mirror', scope: 'global', x: true, y: false, z: false, toleranceMm: 0.5 });
    const hits = symmetryPlacementHits(boxMesh(), { x: 5, y: 1, z: 18 }, { x: 1, y: 0, z: 0 });
    assert.equal(hits.length, 1);
    assert.ok(Math.abs(hits[0].point.x + 5) < 1e-4);
    assert.ok(Math.abs(hits[0].point.y - 1) < 1e-4);
    assert.ok(Math.abs(hits[0].point.z - 18) < 1e-4);
    assert.ok(hits[0].face, 'carries a face for normal smoothing');
  } finally {
    updateSupportSymmetrySettings(previous);
  }
});

test('symmetry off yields no hits', () => {
  const previous = { ...getSupportSymmetrySettings() };
  try {
    updateSupportSymmetrySettings({ mode: 'off' });
    assert.equal(symmetryPlacementHits(boxMesh(), { x: 5, y: 1, z: 18 }, { x: 1, y: 0, z: 0 }).length, 0);
  } finally {
    updateSupportSymmetrySettings(previous);
  }
});
