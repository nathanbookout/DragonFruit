import * as THREE from 'three';
import {
  addRoot,
  asOneSupportEdit,
  getSnapshot,
  setTrunkEditObserver,
} from '@/supports/state';
import { updateSupportEntity } from '@/supports/supportTypeRegistry';
import { getSupportSymmetrySettings } from '@/supports/Settings/state';
import { v4 as generateUuid } from 'uuid';
import type {
  BezierSegment,
  Joint,
  Roots,
  Segment,
  Trunk,
  Vec3,
} from '@/supports/types';
import type { SupportData } from '@/supports/rendering/SupportBuilder';

type SymmetrySettings = ReturnType<typeof getSupportSymmetrySettings>;

interface SymmetryOp {
  matrix: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
}

export interface ModelSurface {
  readonly localFrame: THREE.Matrix4;
  distanceToSurface(worldPoint: Vec3): number;
}

function createSymmetryOp(matrix: THREE.Matrix4): SymmetryOp {
  return { matrix, normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix) };
}

function transformPoint(point: Vec3, matrix: THREE.Matrix4): Vec3 {
  const transformed = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix);
  return { x: transformed.x, y: transformed.y, z: transformed.z };
}

function transformDirection(direction: Vec3, normalMatrix: THREE.Matrix3): Vec3 {
  const transformed = new THREE.Vector3(direction.x, direction.y, direction.z).applyMatrix3(normalMatrix);
  if (transformed.lengthSq() <= 1e-12) return direction;
  transformed.normalize();
  return { x: transformed.x, y: transformed.y, z: transformed.z };
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function centroidOf(points: Vec3[]): Vec3 {
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y, z: acc.z + point.z }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length };
}

function linearReflection(flippedAxes: [boolean, boolean, boolean]): THREE.Matrix4 {
  return new THREE.Matrix4().makeScale(flippedAxes[0] ? -1 : 1, flippedAxes[1] ? -1 : 1, flippedAxes[2] ? -1 : 1);
}

function linearRotation(axis: SymmetrySettings['radialAxis'], angle: number): THREE.Matrix4 {
  if (axis === 'x') return new THREE.Matrix4().makeRotationX(angle);
  if (axis === 'y') return new THREE.Matrix4().makeRotationY(angle);
  return new THREE.Matrix4().makeRotationZ(angle);
}

function conjugateByFrame(linearTransform: THREE.Matrix4, frame: THREE.Matrix4): THREE.Matrix4 {
  const frameInverse = new THREE.Matrix4().copy(frame).invert();
  return new THREE.Matrix4().multiplyMatrices(frame, linearTransform).multiply(frameInverse);
}

function translationFrame(origin: Vec3): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z);
}

function enabledMirrorAxes(settings: SymmetrySettings): number[] {
  const axes: number[] = [];
  if (settings.x) axes.push(0);
  if (settings.y) axes.push(1);
  if (settings.z) axes.push(2);
  return axes;
}

function nonEmptyAxisSubsets(axes: number[]): number[][] {
  const subsets: number[][] = [];
  for (let mask = 1; mask < (1 << axes.length); mask += 1) {
    subsets.push(axes.filter((_, index) => mask & (1 << index)));
  }
  return subsets;
}

function flipMaskForAxes(axes: number[]): [boolean, boolean, boolean] {
  const flip: [boolean, boolean, boolean] = [false, false, false];
  axes.forEach((axis) => { flip[axis] = true; });
  return flip;
}

function radialRotationAngles(settings: SymmetrySettings): number[] {
  const count = Math.max(2, Math.round(settings.radialCount));
  const angles: number[] = [];
  for (let step = 1; step < count; step += 1) angles.push((step * 2 * Math.PI) / count);
  return angles;
}

function symmetryOpsInFrame(settings: SymmetrySettings, frame: THREE.Matrix4): SymmetryOp[] {
  if (settings.mode === 'mirror') {
    return nonEmptyAxisSubsets(enabledMirrorAxes(settings))
      .map((subset) => createSymmetryOp(conjugateByFrame(linearReflection(flipMaskForAxes(subset)), frame)));
  }
  if (settings.mode === 'radial') {
    return radialRotationAngles(settings)
      .map((angle) => createSymmetryOp(conjugateByFrame(linearRotation(settings.radialAxis, angle), frame)));
  }
  return [];
}

function symmetryFrame(surface: ModelSurface, settings: SymmetrySettings): THREE.Matrix4 {
  return settings.scope === 'global' ? new THREE.Matrix4() : surface.localFrame;
}

function modelLocalFrame(mesh: THREE.Mesh): THREE.Matrix4 {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const localCenter = mesh.geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
  const worldCenter = localCenter.applyMatrix4(mesh.matrixWorld);
  const worldOrientation = new THREE.Quaternion();
  mesh.matrixWorld.decompose(new THREE.Vector3(), worldOrientation, new THREE.Vector3());
  return new THREE.Matrix4().compose(worldCenter, worldOrientation, new THREE.Vector3(1, 1, 1));
}

function meshSurfaceDistance(mesh: THREE.Mesh, worldPoint: Vec3): number {
  const boundsTree = (mesh.geometry as { boundsTree?: {
    closestPointToPoint: (
      point: THREE.Vector3,
      target: { point: THREE.Vector3; distance: number },
    ) => { point: THREE.Vector3 } | null;
  } }).boundsTree;
  if (!boundsTree?.closestPointToPoint) return Number.POSITIVE_INFINITY;

  const inverseWorld = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const localPoint = new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z).applyMatrix4(inverseWorld);
  const nearest = boundsTree.closestPointToPoint(localPoint, { point: new THREE.Vector3(), distance: 0 });
  if (!nearest) return Number.POSITIVE_INFINITY;

  const worldNearest = nearest.point.clone().applyMatrix4(mesh.matrixWorld);
  return worldNearest.distanceTo(new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z));
}

export function meshModelSurface(mesh: THREE.Mesh): ModelSurface {
  let cachedFrame: THREE.Matrix4 | null = null;
  return {
    get localFrame(): THREE.Matrix4 {
      if (!cachedFrame) cachedFrame = modelLocalFrame(mesh);
      return cachedFrame;
    },
    distanceToSurface(worldPoint: Vec3): number {
      return meshSurfaceDistance(mesh, worldPoint);
    },
  };
}

function createJointIdRemapper(): (id: string) => string {
  const remapped = new Map<string, string>();
  return (id: string) => {
    const existing = remapped.get(id);
    if (existing) return existing;
    const created = generateUuid();
    remapped.set(id, created);
    return created;
  };
}

function modelSupportContactPoints(modelId: string): Vec3[] {
  const snapshot = getSnapshot();
  const points: Vec3[] = [];
  for (const trunk of Object.values(snapshot.trunks)) {
    if (trunk.modelId === modelId && trunk.contactCone) points.push(trunk.contactCone.pos);
  }
  for (const stick of Object.values(snapshot.sticks)) {
    if (stick.modelId === modelId) points.push(stick.contactConeA.pos, stick.contactConeB.pos);
  }
  for (const twig of Object.values(snapshot.twigs)) {
    if (twig.modelId === modelId) points.push(twig.contactDiskA.pos, twig.contactDiskB.pos);
  }
  for (const anchor of Object.values(snapshot.stumps)) {
    if (anchor.modelId === modelId) points.push(anchor.contactCone.pos);
  }
  return points;
}

function opLeavesContactsInPlace(contactPoints: Vec3[], op: SymmetryOp, tolerance: number): boolean {
  return contactPoints.every((point) => {
    const transformed = transformPoint(point, op.matrix);
    return contactPoints.some((source) => distanceBetween(transformed, source) <= tolerance);
  });
}

function symmetryOpsReachingSurface(
  surface: ModelSurface,
  contactPoints: Vec3[],
  tolerance: number,
  settings: SymmetrySettings,
): SymmetryOp[] {
  if (contactPoints.length === 0) return [];
  return symmetryOpsInFrame(settings, symmetryFrame(surface, settings)).filter((op) => {
    if (opLeavesContactsInPlace(contactPoints, op, tolerance)) return false;
    return contactPoints.every((point) => surface.distanceToSurface(transformPoint(point, op.matrix)) <= tolerance);
  });
}

const symmetryPreviewListeners = new Set<() => void>();
let symmetryPreviews: SupportData[] = [];

export function setSymmetryPreviews(previews: SupportData[]): void {
  if (symmetryPreviews.length === 0 && previews.length === 0) return;
  symmetryPreviews = previews;
  symmetryPreviewListeners.forEach((listener) => listener());
}

export function getSymmetryPreviews(): SupportData[] {
  return symmetryPreviews;
}

export function subscribeToSymmetryPreviews(listener: () => void): () => void {
  symmetryPreviewListeners.add(listener);
  return () => { symmetryPreviewListeners.delete(listener); };
}

function trunkMatchesUnderOp(
  source: Trunk,
  sourceRoot: Roots | undefined,
  target: Trunk,
  targetRoot: Roots | undefined,
  op: SymmetryOp,
  tolerance: number,
): boolean {
  if (source.segments.length !== target.segments.length) return false;
  if (Boolean(source.contactCone) !== Boolean(target.contactCone)) return false;

  if (source.contactCone && target.contactCone) {
    if (distanceBetween(transformPoint(source.contactCone.pos, op.matrix), target.contactCone.pos) > tolerance) return false;
  }
  if (sourceRoot && targetRoot) {
    if (distanceBetween(transformPoint(sourceRoot.transform.pos, op.matrix), targetRoot.transform.pos) > tolerance) return false;
  }

  for (let index = 0; index < source.segments.length; index += 1) {
    const sourceSegment = source.segments[index];
    const targetSegment = target.segments[index];
    if (Math.abs(sourceSegment.diameter - targetSegment.diameter) > 1e-4) return false;
    if ((sourceSegment.type === 'bezier') !== (targetSegment.type === 'bezier')) return false;
    if (sourceSegment.topJoint && targetSegment.topJoint
      && distanceBetween(transformPoint(sourceSegment.topJoint.pos, op.matrix), targetSegment.topJoint.pos) > tolerance) return false;
    if (sourceSegment.bottomJoint && targetSegment.bottomJoint
      && distanceBetween(transformPoint(sourceSegment.bottomJoint.pos, op.matrix), targetSegment.bottomJoint.pos) > tolerance) return false;
  }

  return true;
}

function reflectionMappingPoints(from: Vec3, to: Vec3): SymmetryOp | null {
  const nx = to.x - from.x;
  const ny = to.y - from.y;
  const nz = to.z - from.z;
  const lengthSq = nx * nx + ny * ny + nz * nz;
  if (lengthSq < 1e-12) return null;

  const scale = 1 / Math.sqrt(lengthSq);
  const ux = nx * scale;
  const uy = ny * scale;
  const uz = nz * scale;
  const reflection = new THREE.Matrix4().set(
    1 - 2 * ux * ux, -2 * ux * uy, -2 * ux * uz, 0,
    -2 * uy * ux, 1 - 2 * uy * uy, -2 * uy * uz, 0,
    -2 * uz * ux, -2 * uz * uy, 1 - 2 * uz * uz, 0,
    0, 0, 0, 1,
  );
  const midpoint: Vec3 = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 };
  return createSymmetryOp(conjugateByFrame(reflection, translationFrame(midpoint)));
}

function candidateEditOps(
  settings: SymmetrySettings,
  source: Trunk,
  target: Trunk,
  radialCenter: Vec3 | null,
): SymmetryOp[] {
  if (!source.contactCone || !target.contactCone) return [];

  if (settings.mode === 'mirror') {
    const reflection = reflectionMappingPoints(source.contactCone.pos, target.contactCone.pos);
    return reflection ? [reflection] : [];
  }

  if (settings.mode === 'radial' && radialCenter) {
    return radialRotationAngles(settings)
      .map((angle) => createSymmetryOp(conjugateByFrame(linearRotation(settings.radialAxis, angle), translationFrame(radialCenter))));
  }

  return [];
}

function transformTrunkOntoTarget(
  source: Trunk,
  sourceRoot: Roots | undefined,
  target: Trunk,
  targetRoot: Roots | undefined,
  op: SymmetryOp,
): { trunk: Trunk; root: Roots | null } {
  const mapJointId = createJointIdRemapper();

  const segments = source.segments.map((segment, index) => {
    const targetSegment = target.segments[index] as Segment | undefined;
    const transformJoint = (joint: Joint | undefined, matched: Joint | undefined): Joint | undefined => (
      joint ? { ...joint, id: matched?.id ?? mapJointId(joint.id), pos: transformPoint(joint.pos, op.matrix) } : joint
    );

    const transformed: Segment = {
      ...segment,
      id: targetSegment?.id ?? generateUuid(),
      topJoint: transformJoint(segment.topJoint, targetSegment?.topJoint),
      bottomJoint: transformJoint(segment.bottomJoint, targetSegment?.bottomJoint),
    };

    if (segment.type === 'bezier') {
      const bezier = transformed as BezierSegment;
      bezier.controlPoint1 = transformPoint(segment.controlPoint1, op.matrix);
      bezier.controlPoint2 = transformPoint(segment.controlPoint2, op.matrix);
      bezier.startTangent = transformDirection(segment.startTangent, op.normalMatrix);
      bezier.endTangent = transformDirection(segment.endTangent, op.normalMatrix);
    }

    return transformed;
  });

  const contactCone = source.contactCone && target.contactCone
    ? {
      ...source.contactCone,
      id: target.contactCone.id,
      pos: transformPoint(source.contactCone.pos, op.matrix),
      normal: transformDirection(source.contactCone.normal, op.normalMatrix),
      surfaceNormal: source.contactCone.surfaceNormal ? transformDirection(source.contactCone.surfaceNormal, op.normalMatrix) : source.contactCone.surfaceNormal,
      socketJointId: target.contactCone.socketJointId,
    }
    : target.contactCone;

  return {
    trunk: { ...source, id: target.id, modelId: target.modelId, rootId: target.rootId, segments, contactCone },
    root: sourceRoot && targetRoot
      ? { ...targetRoot, transform: { ...targetRoot.transform, pos: transformPoint(sourceRoot.transform.pos, op.matrix) } }
      : null,
  };
}

function radialEditCenter(settings: SymmetrySettings, previous: Trunk, siblings: Trunk[]): Vec3 | null {
  if (settings.mode !== 'radial' || !previous.contactCone) return null;
  if (settings.scope === 'global') return { x: 0, y: 0, z: 0 };
  const contacts = [previous.contactCone.pos, ...siblings.map((sibling) => sibling.contactCone?.pos).filter((pos): pos is Vec3 => Boolean(pos))];
  return centroidOf(contacts);
}

let propagatingTrunkEdit = false;

/** Whether two trunks have the same shape, comparing numbers within `epsilon`. */
function sameTrunkGeometry(a: Trunk, b: Trunk, epsilon = 0): boolean {
  const fields = (trunk: Trunk) => ({ segments: trunk.segments, contactCone: trunk.contactCone ?? null, rootId: trunk.rootId });
  const equal = (x: unknown, y: unknown): boolean => {
    if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= epsilon;
    if (x === y) return true;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    const xr = x as Record<string, unknown>;
    const yr = y as Record<string, unknown>;
    // Ids differ between siblings by design; geometry is everything else.
    const keys = new Set([...Object.keys(xr), ...Object.keys(yr)].filter((key) => key !== 'id' && key !== 'rootId'));
    for (const key of keys) if (!equal(xr[key], yr[key])) return false;
    return true;
  };
  return equal(fields(a), fields(b)) && (epsilon > 0 || a.rootId === b.rootId);
}

export function propagateTrunkEditToSymmetricTrunks(previous: Trunk, next: Trunk): void {
  if (propagatingTrunkEdit || previous.id !== next.id) return;
  // A write that changed nothing (selection, settings normalisation) must not
  // re-derive the siblings: float noise from the transform would turn a no-op
  // into a recorded edit, i.e. an undo step that seems to do nothing.
  if (sameTrunkGeometry(previous, next)) return;

  const settings = getSupportSymmetrySettings();
  if (settings.mode === 'off') return;

  const snapshot = getSnapshot();
  const previousRoot = snapshot.roots[previous.rootId];
  const nextRoot = snapshot.roots[next.rootId];
  const tolerance = Math.max(1e-4, settings.toleranceMm);
  const siblings = Object.values(snapshot.trunks).filter((trunk) => trunk.id !== previous.id && trunk.modelId === previous.modelId);
  if (siblings.length === 0) return;

  const radialCenter = radialEditCenter(settings, previous, siblings);

  propagatingTrunkEdit = true;
  try {
    for (const sibling of siblings) {
      const siblingRoot = snapshot.roots[sibling.rootId];
      const matchingOp = candidateEditOps(settings, previous, sibling, radialCenter)
        .find((candidate) => trunkMatchesUnderOp(previous, previousRoot, sibling, siblingRoot, candidate, tolerance));
      if (!matchingOp) continue;

      const edited = transformTrunkOntoTarget(next, nextRoot, sibling, siblingRoot, matchingOp);
      if (sameTrunkGeometry(sibling, edited.trunk, 1e-6)) continue;
      asOneSupportEdit(() => {
        if (edited.root) addRoot(edited.root);
        updateSupportEntity('trunk', edited.trunk);
      });
    }
  } finally {
    propagatingTrunkEdit = false;
  }
}

setTrunkEditObserver(propagateTrunkEditToSymmetricTrunks);

const placementRaycaster = new THREE.Raycaster();

/**
 * The surface hits a click at `tipPos` would be mirrored to under the current
 * symmetry settings. Each is a real raycast hit on `mesh` (with its face), so a
 * caller can run its normal hover/click pipeline on it: the copy then routes
 * around the model like any other support, instead of being a rigid copy of the
 * original's path.
 *
 * `skipOccupied` drops targets that already carry a support contact (used after
 * the original has been placed, so it and earlier copies are not doubled).
 */
export function symmetryPlacementHits(
  mesh: THREE.Mesh,
  tipPos: Vec3,
  tipNormal: Vec3,
  options: { skipOccupied?: boolean } = {},
): THREE.Intersection[] {
  const settings = getSupportSymmetrySettings();
  if (settings.mode === 'off') return [];

  const surface = meshModelSurface(mesh);
  const tolerance = Math.max(0, settings.toleranceMm);
  const ops = symmetryOpsReachingSurface(surface, [tipPos], tolerance, settings);
  if (ops.length === 0) return [];

  const modelId = (mesh.userData?.modelId as string | undefined) ?? '';
  const occupied = options.skipOccupied && modelId ? modelSupportContactPoints(modelId) : [];
  const dedupeMm = Math.max(tolerance, 0.25);
  const hits: THREE.Intersection[] = [];
  const backoffMm = Math.max(2, tolerance * 4);

  for (const op of ops) {
    const target = transformPoint(tipPos, op.matrix);
    if (occupied.some((point) => distanceBetween(point, target) <= dedupeMm)) continue;
    if (hits.some((hit) => distanceBetween(hit.point, target) <= dedupeMm)) continue;

    // Cast back onto the surface along the mirrored normal, from just outside.
    const normal = transformDirection(tipNormal, op.normalMatrix);
    const origin = new THREE.Vector3(target.x, target.y, target.z)
      .addScaledVector(new THREE.Vector3(normal.x, normal.y, normal.z), backoffMm);
    placementRaycaster.set(origin, new THREE.Vector3(-normal.x, -normal.y, -normal.z));
    placementRaycaster.near = 0;
    placementRaycaster.far = backoffMm * 2 + tolerance;
    const candidates = placementRaycaster.intersectObject(mesh, false);
    const best = candidates
      .filter((hit) => hit.face)
      .sort((a, b) => distanceBetween(a.point, target) - distanceBetween(b.point, target))[0];
    if (!best || distanceBetween(best.point, target) > Math.max(tolerance, 0.5)) continue;
    hits.push(best);
  }

  return hits;
}
