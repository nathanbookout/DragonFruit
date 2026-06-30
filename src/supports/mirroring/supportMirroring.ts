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

function makeOp(matrix: THREE.Matrix4): SymmetryOp {
  return { matrix, normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix) };
}

function transformPoint(point: Vec3, matrix: THREE.Matrix4): Vec3 {
  const v = new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix);
  return { x: v.x, y: v.y, z: v.z };
}

function transformDirection(direction: Vec3, normalMatrix: THREE.Matrix3): Vec3 {
  const v = new THREE.Vector3(direction.x, direction.y, direction.z).applyMatrix3(normalMatrix);
  if (v.lengthSq() <= 1e-12) return direction;
  v.normalize();
  return { x: v.x, y: v.y, z: v.z };
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function reflectionMatrixAbout(flip: [boolean, boolean, boolean], pivot: Vec3): THREE.Matrix4 {
  const scale = new THREE.Matrix4().makeScale(flip[0] ? -1 : 1, flip[1] ? -1 : 1, flip[2] ? -1 : 1);
  const toPivot = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  const fromPivot = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
  return fromPivot.multiply(scale).multiply(toPivot);
}

function rotationMatrixAboutAxis(axis: SymmetrySettings['radialAxis'], angle: number, pivot: Vec3): THREE.Matrix4 {
  const rotation = axis === 'x'
    ? new THREE.Matrix4().makeRotationX(angle)
    : axis === 'y'
      ? new THREE.Matrix4().makeRotationY(angle)
      : new THREE.Matrix4().makeRotationZ(angle);
  const toPivot = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  const fromPivot = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
  return fromPivot.multiply(rotation).multiply(toPivot);
}

function enabledAxisIndices(settings: SymmetrySettings): number[] {
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

function radialAngles(settings: SymmetrySettings): number[] {
  const count = Math.max(2, Math.round(settings.radialCount));
  const angles: number[] = [];
  for (let k = 1; k < count; k += 1) angles.push((k * 2 * Math.PI) / count);
  return angles;
}

function symmetryOpsAbout(settings: SymmetrySettings, pivot: Vec3): SymmetryOp[] {
  if (settings.mode === 'mirror') {
    return nonEmptyAxisSubsets(enabledAxisIndices(settings)).map((subset) => {
      const flip: [boolean, boolean, boolean] = [false, false, false];
      subset.forEach((axis) => { flip[axis] = true; });
      return makeOp(reflectionMatrixAbout(flip, pivot));
    });
  }
  if (settings.mode === 'radial') {
    return radialAngles(settings).map((angle) => makeOp(rotationMatrixAboutAxis(settings.radialAxis, angle, pivot)));
  }
  return [];
}

function modelWorldCenter(mesh: THREE.Mesh): Vec3 {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const localCenter = mesh.geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
  const worldCenter = localCenter.applyMatrix4(mesh.matrixWorld);
  return { x: worldCenter.x, y: worldCenter.y, z: worldCenter.z };
}

function symmetryPivot(mesh: THREE.Mesh, settings: SymmetrySettings): Vec3 {
  return settings.scope === 'global' ? { x: 0, y: 0, z: 0 } : modelWorldCenter(mesh);
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
  const hit = boundsTree.closestPointToPoint(localPoint, { point: new THREE.Vector3(), distance: 0 });
  if (!hit) return Number.POSITIVE_INFINITY;

  const worldClosest = hit.point.clone().applyMatrix4(mesh.matrixWorld);
  return worldClosest.distanceTo(new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z));
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

  const next: Segment = {
    ...segment,
    id: generateUuid(),
    topJoint: transformJoint(segment.topJoint),
    bottomJoint: transformJoint(segment.bottomJoint),
  };

  if (segment.type === 'bezier') {
    const bezier = next as BezierSegment;
    bezier.controlPoint1 = transformPoint(segment.controlPoint1, op.matrix);
    bezier.controlPoint2 = transformPoint(segment.controlPoint2, op.matrix);
    bezier.startTangent = transformDirection(segment.startTangent, op.normalMatrix);
    bezier.endTangent = transformDirection(segment.endTangent, op.normalMatrix);
  }

  return next;
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

function transformTrunkCopy(root: Roots, trunk: Trunk, op: SymmetryOp): { root: Roots; trunk: Trunk } {
  const mapJointId = createJointIdRemapper();
  const reflectedRootId = generateUuid();
  return {
    root: {
      ...root,
      id: reflectedRootId,
      transform: { ...root.transform, pos: transformPoint(root.transform.pos, op.matrix) },
    },
    trunk: {
      ...trunk,
      id: generateUuid(),
      rootId: reflectedRootId,
      segments: trunk.segments.map((segment) => transformSegment(segment, op, mapJointId)),
      contactCone: trunk.contactCone ? transformContactCone(trunk.contactCone, op, mapJointId) : trunk.contactCone,
    },
  };
}

function transformStickCopy(stick: Stick, op: SymmetryOp): Stick {
  const mapJointId = createJointIdRemapper();
  return {
    ...stick,
    id: generateUuid(),
    segments: stick.segments.map((segment) => transformSegment(segment, op, mapJointId)),
    contactConeA: transformContactCone(stick.contactConeA, op, mapJointId),
    contactConeB: transformContactCone(stick.contactConeB, op, mapJointId),
  };
}

function transformTwigCopy(twig: Twig, op: SymmetryOp): Twig {
  const mapJointId = createJointIdRemapper();
  return {
    ...twig,
    id: generateUuid(),
    segments: twig.segments.map((segment) => transformSegment(segment, op, mapJointId)),
    contactDiskA: transformContactDisk(twig.contactDiskA, op),
    contactDiskB: transformContactDisk(twig.contactDiskB, op),
  };
}

function transformAnchorCopy(anchor: Anchor, op: SymmetryOp): Anchor {
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

function opMapsContactsOntoThemselves(contactPoints: Vec3[], op: SymmetryOp, tolerance: number): boolean {
  return contactPoints.every((point) => {
    const transformed = transformPoint(point, op.matrix);
    return contactPoints.some((source) => distanceBetween(transformed, source) <= tolerance);
  });
}

function placeSymmetryCopies(args: {
  modelId: string;
  mesh: THREE.Mesh | undefined;
  contactPoints: Vec3[];
  addCopy: (op: SymmetryOp) => void;
}): void {
  const settings = getSupportSymmetrySettings();
  if (settings.mode === 'off' || !args.mesh || args.contactPoints.length === 0) return;

  const ops = symmetryOpsAbout(settings, symmetryPivot(args.mesh, settings));
  if (ops.length === 0) return;

  const tolerance = Math.max(0, settings.toleranceMm);
  const occupiedContacts = modelSupportContactPoints(args.modelId);
  const historyBefore = captureSupportEditSnapshot();
  let copiedAny = false;

  for (const op of ops) {
    if (opMapsContactsOntoThemselves(args.contactPoints, op, tolerance)) continue;

    const transformedContacts = args.contactPoints.map((point) => transformPoint(point, op.matrix));

    const landsOnSurface = transformedContacts.every((point) => meshSurfaceDistance(args.mesh!, point) <= tolerance);
    if (!landsOnSurface) continue;

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

export function symmetrizePlacedTrunk(mesh: THREE.Mesh | undefined, root: Roots, trunk: Trunk): void {
  if (!trunk.contactCone) return;
  placeSymmetryCopies({
    modelId: trunk.modelId,
    mesh,
    contactPoints: [trunk.contactCone.pos],
    addCopy: (op) => {
      const copy = transformTrunkCopy(root, trunk, op);
      addRoot(copy.root);
      addTrunk(copy.trunk);
    },
  });
}

export function symmetrizePlacedStick(mesh: THREE.Mesh | undefined, stick: Stick): void {
  placeSymmetryCopies({
    modelId: stick.modelId,
    mesh,
    contactPoints: [stick.contactConeA.pos, stick.contactConeB.pos],
    addCopy: (op) => addStick(transformStickCopy(stick, op)),
  });
}

export function symmetrizePlacedTwig(mesh: THREE.Mesh | undefined, twig: Twig): void {
  placeSymmetryCopies({
    modelId: twig.modelId,
    mesh,
    contactPoints: [twig.contactDiskA.pos, twig.contactDiskB.pos],
    addCopy: (op) => addTwig(transformTwigCopy(twig, op)),
  });
}

export function symmetrizePlacedAnchor(mesh: THREE.Mesh | undefined, anchor: Anchor): void {
  placeSymmetryCopies({
    modelId: anchor.modelId,
    mesh,
    contactPoints: [anchor.contactCone.pos],
    addCopy: (op) => addAnchor(transformAnchorCopy(anchor, op)),
  });
}

function supportDataContactPoints(data: SupportData): Vec3[] {
  const points: Vec3[] = [];
  if (data.contactCone) points.push(data.contactCone.pos);
  data.contactCones?.forEach((cone) => points.push(cone.pos));
  data.contactDisks?.forEach((disk) => points.push(disk.pos));
  return points;
}

function transformSupportData(data: SupportData, op: SymmetryOp, copyIndex: number): SupportData {
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

export function buildSymmetryPreviewCopies(mesh: THREE.Mesh | undefined, data: SupportData | null): SupportData[] {
  if (!mesh || !data) return [];
  const settings = getSupportSymmetrySettings();
  if (settings.mode === 'off') return [];

  const ops = symmetryOpsAbout(settings, symmetryPivot(mesh, settings));
  if (ops.length === 0) return [];

  const tolerance = Math.max(0, settings.toleranceMm);
  const contactPoints = supportDataContactPoints(data);
  const copies: SupportData[] = [];

  ops.forEach((op, index) => {
    if (contactPoints.length === 0 || opMapsContactsOntoThemselves(contactPoints, op, tolerance)) return;
    const transformedContacts = contactPoints.map((point) => transformPoint(point, op.matrix));
    const landsOnSurface = transformedContacts.every((point) => meshSurfaceDistance(mesh, point) <= tolerance);
    if (!landsOnSurface) return;
    copies.push(transformSupportData(data, op, index));
  });

  return copies;
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

function candidateEditOps(
  settings: SymmetrySettings,
  source: Trunk,
  target: Trunk,
  radialCenter: Vec3 | null,
): SymmetryOp[] {
  if (!source.contactCone || !target.contactCone) return [];

  if (settings.mode === 'mirror') {
    return nonEmptyAxisSubsets(enabledAxisIndices(settings)).map((subset) => {
      const flip: [boolean, boolean, boolean] = [false, false, false];
      const pivot: Vec3 = { x: 0, y: 0, z: 0 };
      subset.forEach((axis) => {
        flip[axis] = true;
        const sourceValue = axis === 0 ? source.contactCone!.pos.x : axis === 1 ? source.contactCone!.pos.y : source.contactCone!.pos.z;
        const targetValue = axis === 0 ? target.contactCone!.pos.x : axis === 1 ? target.contactCone!.pos.y : target.contactCone!.pos.z;
        const mid = (sourceValue + targetValue) / 2;
        if (axis === 0) pivot.x = mid; else if (axis === 1) pivot.y = mid; else pivot.z = mid;
      });
      return makeOp(reflectionMatrixAbout(flip, pivot));
    });
  }

  if (settings.mode === 'radial' && radialCenter) {
    return radialAngles(settings).map((angle) => makeOp(rotationMatrixAboutAxis(settings.radialAxis, angle, radialCenter)));
  }

  return [];
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

  let radialCenter: Vec3 | null = null;
  if (settings.mode === 'radial' && previous.contactCone) {
    if (settings.scope === 'global') {
      radialCenter = { x: 0, y: 0, z: 0 };
    } else {
      const contacts = [previous.contactCone.pos, ...siblings.map((sibling) => sibling.contactCone?.pos).filter((pos): pos is Vec3 => Boolean(pos))];
      const sum = contacts.reduce((acc, pos) => ({ x: acc.x + pos.x, y: acc.y + pos.y, z: acc.z + pos.z }), { x: 0, y: 0, z: 0 });
      radialCenter = { x: sum.x / contacts.length, y: sum.y / contacts.length, z: sum.z / contacts.length };
    }
  }

  propagatingTrunkEdit = true;
  try {
    for (const sibling of siblings) {
      const siblingRoot = snapshot.roots[sibling.rootId];
      const op = candidateEditOps(settings, previous, sibling, radialCenter)
        .find((candidate) => trunkMatchesUnderOp(previous, previousRoot, sibling, siblingRoot, candidate, tolerance));
      if (!op) continue;

      const mapJointId = createJointIdRemapper();
      const segments = next.segments.map((segment, index) => {
        const targetSegment = sibling.segments[index] as Segment | undefined;
        const transformJoint = (joint: Joint | undefined, matched: Joint | undefined): Joint | undefined => (
          joint ? { ...joint, id: matched?.id ?? mapJointId(joint.id), pos: transformPoint(joint.pos, op.matrix) } : joint
        );
        const reflected: Segment = {
          ...segment,
          id: targetSegment?.id ?? generateUuid(),
          topJoint: transformJoint(segment.topJoint, targetSegment?.topJoint),
          bottomJoint: transformJoint(segment.bottomJoint, targetSegment?.bottomJoint),
        };
        if (segment.type === 'bezier') {
          const bezier = reflected as BezierSegment;
          bezier.controlPoint1 = transformPoint(segment.controlPoint1, op.matrix);
          bezier.controlPoint2 = transformPoint(segment.controlPoint2, op.matrix);
          bezier.startTangent = transformDirection(segment.startTangent, op.normalMatrix);
          bezier.endTangent = transformDirection(segment.endTangent, op.normalMatrix);
        }
        return reflected;
      });

      const contactCone = next.contactCone && sibling.contactCone
        ? {
          ...next.contactCone,
          id: sibling.contactCone.id,
          pos: transformPoint(next.contactCone.pos, op.matrix),
          normal: transformDirection(next.contactCone.normal, op.normalMatrix),
          surfaceNormal: next.contactCone.surfaceNormal ? transformDirection(next.contactCone.surfaceNormal, op.normalMatrix) : next.contactCone.surfaceNormal,
          socketJointId: sibling.contactCone.socketJointId,
        }
        : sibling.contactCone;

      if (nextRoot && siblingRoot) {
        addRoot({ ...siblingRoot, transform: { ...siblingRoot.transform, pos: transformPoint(nextRoot.transform.pos, op.matrix) } });
      }
      updateTrunk({ ...next, id: sibling.id, modelId: sibling.modelId, rootId: sibling.rootId, segments, contactCone });
    }
  } finally {
    propagatingTrunkEdit = false;
  }
}

setTrunkEditObserver(propagateTrunkEditToSymmetricTrunks);
