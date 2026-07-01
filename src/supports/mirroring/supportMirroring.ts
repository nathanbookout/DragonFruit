import * as THREE from 'three';
import {
  addAnchor,
  addRoot,
  addStick,
  addTrunk,
  addTwig,
  getSnapshot,
  setTrunkEditObserver,
  updateTrunk,
} from '@/supports/state';
import { getSupportSymmetrySettings } from '@/supports/Settings/state';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '@/supports/history/supportEditHistory';
import { generateUuid } from '@/utils/uuid';
import type {
  Anchor,
  BezierSegment,
  ContactDisk,
  Joint,
  Knot,
  Roots,
  Segment,
  Stick,
  Trunk,
  Twig,
  Vec3,
} from '@/supports/types';
import type { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
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

function transformSegment(segment: Segment, op: SymmetryOp, mapJointId: (id: string) => string): Segment {
  const transformJoint = (joint: Joint | undefined): Joint | undefined => (
    joint ? { ...joint, id: mapJointId(joint.id), pos: transformPoint(joint.pos, op.matrix) } : joint
  );

  const transformed: Segment = {
    ...segment,
    id: generateUuid(),
    topJoint: transformJoint(segment.topJoint),
    bottomJoint: transformJoint(segment.bottomJoint),
  };

  if (segment.type === 'bezier') {
    const bezier = transformed as BezierSegment;
    bezier.controlPoint1 = transformPoint(segment.controlPoint1, op.matrix);
    bezier.controlPoint2 = transformPoint(segment.controlPoint2, op.matrix);
    bezier.startTangent = transformDirection(segment.startTangent, op.normalMatrix);
    bezier.endTangent = transformDirection(segment.endTangent, op.normalMatrix);
  }

  return transformed;
}

function transformContactCone(cone: ContactCone, op: SymmetryOp, mapJointId: (id: string) => string): ContactCone {
  return {
    ...cone,
    id: generateUuid(),
    pos: transformPoint(cone.pos, op.matrix),
    normal: transformDirection(cone.normal, op.normalMatrix),
    surfaceNormal: cone.surfaceNormal ? transformDirection(cone.surfaceNormal, op.normalMatrix) : cone.surfaceNormal,
    socketJointId: cone.socketJointId ? mapJointId(cone.socketJointId) : cone.socketJointId,
  };
}

function transformContactDisk(disk: ContactDisk, op: SymmetryOp): ContactDisk {
  return {
    ...disk,
    id: generateUuid(),
    pos: transformPoint(disk.pos, op.matrix),
    surfaceNormal: transformDirection(disk.surfaceNormal, op.normalMatrix),
    coneAxis: transformDirection(disk.coneAxis, op.normalMatrix),
  };
}

function copyTrunkThroughOp(root: Roots, trunk: Trunk, op: SymmetryOp): { root: Roots; trunk: Trunk } {
  const mapJointId = createJointIdRemapper();
  const newRootId = generateUuid();
  return {
    root: {
      ...root,
      id: newRootId,
      transform: { ...root.transform, pos: transformPoint(root.transform.pos, op.matrix) },
    },
    trunk: {
      ...trunk,
      id: generateUuid(),
      rootId: newRootId,
      segments: trunk.segments.map((segment) => transformSegment(segment, op, mapJointId)),
      contactCone: trunk.contactCone ? transformContactCone(trunk.contactCone, op, mapJointId) : trunk.contactCone,
    },
  };
}

function copyStickThroughOp(stick: Stick, op: SymmetryOp): Stick {
  const mapJointId = createJointIdRemapper();
  return {
    ...stick,
    id: generateUuid(),
    segments: stick.segments.map((segment) => transformSegment(segment, op, mapJointId)),
    contactConeA: transformContactCone(stick.contactConeA, op, mapJointId),
    contactConeB: transformContactCone(stick.contactConeB, op, mapJointId),
  };
}

function copyTwigThroughOp(twig: Twig, op: SymmetryOp): Twig {
  const mapJointId = createJointIdRemapper();
  return {
    ...twig,
    id: generateUuid(),
    segments: twig.segments.map((segment) => transformSegment(segment, op, mapJointId)),
    contactDiskA: transformContactDisk(twig.contactDiskA, op),
    contactDiskB: transformContactDisk(twig.contactDiskB, op),
  };
}

function copyAnchorThroughOp(anchor: Anchor, op: SymmetryOp): Anchor {
  const mapJointId = createJointIdRemapper();
  return {
    ...anchor,
    id: generateUuid(),
    rootPos: transformPoint(anchor.rootPos, op.matrix),
    joint: { ...anchor.joint, id: mapJointId(anchor.joint.id), pos: transformPoint(anchor.joint.pos, op.matrix) },
    segments: anchor.segments.map((segment) => transformSegment(segment, op, mapJointId)),
    contactCone: transformContactCone(anchor.contactCone, op, mapJointId),
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
  for (const anchor of Object.values(snapshot.anchors)) {
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

function placeSymmetryCopies(args: {
  modelId: string;
  surface: ModelSurface | undefined;
  contactPoints: Vec3[];
  addCopy: (op: SymmetryOp) => void;
}): void {
  const settings = getSupportSymmetrySettings();
  if (settings.mode === 'off' || !args.surface) return;

  const tolerance = Math.max(0, settings.toleranceMm);
  const reachableOps = symmetryOpsReachingSurface(args.surface, args.contactPoints, tolerance, settings);
  if (reachableOps.length === 0) return;

  const occupiedContacts = modelSupportContactPoints(args.modelId);
  const historyBefore = captureSupportEditSnapshot();
  let copiedAny = false;

  for (const op of reachableOps) {
    const transformedContacts = args.contactPoints.map((point) => transformPoint(point, op.matrix));
    const alreadyOccupied = transformedContacts.every((point) => (
      occupiedContacts.some((existing) => distanceBetween(existing, point) <= tolerance)
    ));
    if (alreadyOccupied) continue;

    args.addCopy(op);
    occupiedContacts.push(...transformedContacts);
    copiedAny = true;
  }

  if (copiedAny) {
    pushSupportEditHistory('Symmetry supports', historyBefore, captureSupportEditSnapshot());
  }
}

export function symmetrizePlacedTrunk(surface: ModelSurface | undefined, root: Roots, trunk: Trunk): void {
  if (!trunk.contactCone) return;
  placeSymmetryCopies({
    modelId: trunk.modelId,
    surface,
    contactPoints: [trunk.contactCone.pos],
    addCopy: (op) => {
      const copy = copyTrunkThroughOp(root, trunk, op);
      addRoot(copy.root);
      addTrunk(copy.trunk);
    },
  });
}

export function symmetrizePlacedStick(surface: ModelSurface | undefined, stick: Stick): void {
  placeSymmetryCopies({
    modelId: stick.modelId,
    surface,
    contactPoints: [stick.contactConeA.pos, stick.contactConeB.pos],
    addCopy: (op) => addStick(copyStickThroughOp(stick, op)),
  });
}

export function symmetrizePlacedTwig(surface: ModelSurface | undefined, twig: Twig): void {
  placeSymmetryCopies({
    modelId: twig.modelId,
    surface,
    contactPoints: [twig.contactDiskA.pos, twig.contactDiskB.pos],
    addCopy: (op) => addTwig(copyTwigThroughOp(twig, op)),
  });
}

export function symmetrizePlacedAnchor(surface: ModelSurface | undefined, anchor: Anchor): void {
  placeSymmetryCopies({
    modelId: anchor.modelId,
    surface,
    contactPoints: [anchor.contactCone.pos],
    addCopy: (op) => addAnchor(copyAnchorThroughOp(anchor, op)),
  });
}

function supportDataContactPoints(data: SupportData): Vec3[] {
  const points: Vec3[] = [];
  if (data.contactCone) points.push(data.contactCone.pos);
  data.contactCones?.forEach((cone) => points.push(cone.pos));
  data.contactDisks?.forEach((disk) => points.push(disk.pos));
  return points;
}

function copySupportDataThroughOp(data: SupportData, op: SymmetryOp, copyIndex: number): SupportData {
  const mapJointId = createJointIdRemapper();
  return {
    ...data,
    id: `${data.id}:symmetry:${copyIndex}`,
    roots: data.roots
      ? { ...data.roots, id: generateUuid(), transform: { ...data.roots.transform, pos: transformPoint(data.roots.transform.pos, op.matrix) } }
      : data.roots,
    segments: data.segments.map((segment) => transformSegment(segment, op, mapJointId)),
    contactCone: data.contactCone ? transformContactCone(data.contactCone, op, mapJointId) : data.contactCone,
    contactCones: data.contactCones?.map((cone) => transformContactCone(cone, op, mapJointId)),
    contactDisks: data.contactDisks?.map((disk) => transformContactDisk(disk, op)),
    knot: data.knot ? { ...data.knot, id: generateUuid(), pos: transformPoint(data.knot.pos, op.matrix) } as Knot : data.knot,
    startPos: data.startPos ? transformPoint(data.startPos, op.matrix) : data.startPos,
  };
}

export function buildSymmetryPreviewCopies(surface: ModelSurface | undefined, data: SupportData | null): SupportData[] {
  if (!surface || !data) return [];
  const settings = getSupportSymmetrySettings();
  if (settings.mode === 'off') return [];

  const tolerance = Math.max(0, settings.toleranceMm);
  const reachableOps = symmetryOpsReachingSurface(surface, supportDataContactPoints(data), tolerance, settings);
  return reachableOps.map((op, index) => copySupportDataThroughOp(data, op, index));
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

export function propagateTrunkEditToSymmetricTrunks(previous: Trunk, next: Trunk): void {
  if (propagatingTrunkEdit || previous.id !== next.id) return;

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
      if (edited.root) addRoot(edited.root);
      updateTrunk(edited.trunk);
    }
  } finally {
    propagatingTrunkEdit = false;
  }
}

setTrunkEditObserver(propagateTrunkEditToSymmetricTrunks);
