import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

import { symmetricSiblingTrunkIds, symmetryPlacementHits } from '../supportMirroring';
import { addRoot, addSupportEntity, resetStore } from '@/supports/state';
import type { Roots, Trunk } from '@/supports/types';
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

function placeTrunk(id: string, contact: { x: number; y: number; z: number }, modelId = 'box') {
  addRoot({ id: `root-${id}`, modelId, transform: { pos: { x: contact.x, y: contact.y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } }, diameter: 2, diskHeight: 0.5, coneHeight: 1 } as Roots);
  addSupportEntity('trunk', {
    id, typeId: 'trunk', modelId, rootId: `root-${id}`, baseDiameterMm: 1,
    segments: [{ id: `seg-${id}`, diameter: 1, topJoint: { id: `j-${id}`, pos: { x: contact.x, y: contact.y, z: contact.z - 2 }, diameter: 1.1 } }],
    contactCone: { id: `cone-${id}`, pos: contact, normal: { x: 0, y: 0, z: -1 }, socketJointId: `j-${id}` },
  } as unknown as Trunk);
}

test('a trunk finds its mirrored sibling by contact point, not by route', () => {
  const previous = { ...getSupportSymmetrySettings() };
  try {
    resetStore();
    updateSupportSymmetrySettings({ mode: 'mirror', scope: 'global', x: true, y: false, z: false, toleranceMm: 0.5 });
    placeTrunk('original', { x: 5, y: 1, z: 18 });
    placeTrunk('mirrored', { x: -5, y: 1, z: 18 });
    placeTrunk('unrelated', { x: -5, y: -3, z: 18 });
    placeTrunk('other-model', { x: -5, y: 1, z: 18 }, 'elsewhere');

    assert.deepEqual(symmetricSiblingTrunkIds('original', boxMesh()), ['mirrored']);

    updateSupportSymmetrySettings({ mode: 'off' });
    assert.deepEqual(symmetricSiblingTrunkIds('original', boxMesh()), []);
  } finally {
    updateSupportSymmetrySettings(previous);
    resetStore();
  }
});
