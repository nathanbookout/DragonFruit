import * as THREE from 'three';
import { msg } from '@lingui/core/macro';
import { setPickRayFromCamera } from '@/components/scene/camera/pickRay';
import { getClipBounds } from '@/components/scene/SceneCanvas/clipBoundsStore';
import { getSnapshot, removeSupportEntities, setHoveredState, setSnapshot } from '../state';
import { setSceneHoveredSupportId } from './shared/hover/sceneHoverStore';
import { captureSupportEditSnapshot, pushSupportEditHistory, type SupportEditHistorySnapshot } from '../history/supportEditHistory';
import { withSupportHistorySuppressed } from '../history/supportHistory';
import { symmetricSiblingTrunkIds } from '../mirroring/supportMirroring';
import { collectModelMeshes, getPointerClientPosition } from '../SupportPrimitives/ContactDisk/contactDiskDragController';
import { clearSupportSelection, selectSupportById } from './shared/selection/selectionController';
import { collectCascade, ownedPrimitives, type EntityRef } from '../supportCascade';
import { resolveSupportTypeIdOf, SUPPORT_TYPES } from '../supportTypeRegistry';
import type { SupportState, Vec3 } from '../types';

/**
 * Moving a whole support: press on the tip of a selected trunk and drag. The
 * support (and its symmetry copies) is lifted out of the scene, the normal
 * placement preview follows the pointer, and on release it is placed afresh at
 * the new spot -- routed, rooted and mirrored exactly like a click there. The
 * whole gesture is one undo step. A press that never moves past the drag
 * threshold is left alone, so a plain click still selects the tip.
 */

/** The placement pipeline, registered by the trunk placement hook. */
export interface WholeSupportPlacer {
    /** Preview a placement at `hit` (null clears it). */
    preview: (hit: THREE.Intersection | null) => void;
    /** Place at `hit`, with symmetry copies, as a click there would. */
    place: (hit: THREE.Intersection) => void;
}

let placer: WholeSupportPlacer | null = null;

export function registerWholeSupportPlacer(next: WholeSupportPlacer): () => void {
    placer = next;
    return () => {
        if (placer === next) placer = null;
    };
}

const DRAG_THRESHOLD_PX = 4;
const POST_MOVE_SUPPRESS_MS = 300;

let moveActive = false;
let suppressPlacementUntilMs = 0;
const moveActiveListeners = new Set<() => void>();

function setMoveActive(active: boolean) {
    if (moveActive === active) return;
    moveActive = active;
    moveActiveListeners.forEach((listener) => listener());
}

/** Subscribe to move start/end (for `useSyncExternalStore`). */
export function subscribeWholeSupportMoveActive(listener: () => void): () => void {
    moveActiveListeners.add(listener);
    return () => { moveActiveListeners.delete(listener); };
}

/** True while a whole-support move is dragging. */
export function isWholeSupportMoveActive(): boolean {
    return moveActive;
}

/**
 * Whether a model click should not place a support: during a move, and briefly
 * after, since the release that ends it also lands on the model as a click.
 */
export function shouldSuppressPlacementAfterWholeSupportMove(): boolean {
    return moveActive || Date.now() < suppressPlacementUntilMs;
}

/**
 * Whether removing these trunks would take anything besides the trunks and the
 * primitives they own (their roots): a branch, leaf or brace hosted on one. A
 * move re-places only the trunk, so lifting such a trunk would lose those.
 */
export function liftWouldDropDependents(state: SupportState, trunkIds: readonly string[]): boolean {
    const seeds: EntityRef[] = trunkIds
        .filter((id) => state.trunks[id])
        .map((id) => ({ collection: 'trunks', id }));
    const kept = new Set(seeds.map((seed) => `${seed.collection}:${seed.id}`));
    for (const seed of seeds) {
        const trunk = state.trunks[seed.id];
        const typeId = resolveSupportTypeIdOf(trunk);
        if (!typeId) continue;
        for (const [collection, ids] of ownedPrimitives(state, typeId, trunk)) {
            for (const id of ids) kept.add(`${collection}:${id}`);
        }
    }
    for (const key of collectCascade(state, seeds)) {
        if (!kept.has(key)) return true;
    }
    return false;
}

/** Supports of any type present in `after` but not in `before`. */
function newlyPlacedSupports(before: SupportState, after: SupportState): Array<{ id: string; contact: Vec3 | null }> {
    const placed: Array<{ id: string; contact: Vec3 | null }> = [];
    for (const descriptor of SUPPORT_TYPES) {
        const key = descriptor.location.key as keyof SupportState;
        const beforeCollection = before[key] as unknown as Record<string, unknown>;
        const afterCollection = after[key] as unknown as Record<string, { id: string; contactCone?: { pos: Vec3 } }>;
        for (const entity of Object.values(afterCollection ?? {})) {
            if (beforeCollection?.[entity.id]) continue;
            placed.push({ id: entity.id, contact: entity.contactCone?.pos ?? null });
        }
    }
    return placed;
}

export interface BeginWholeSupportMoveOptions {
    trunkId: string;
    event: unknown;
    camera: THREE.Camera;
    domElement: HTMLElement;
    scene: THREE.Object3D;
    controls?: { enabled?: boolean } | null;
}

/**
 * Start tracking a press on a selected trunk's tip. Returns false when the move
 * cannot run (nothing to place with), so the caller lets the press through.
 */
export function beginWholeSupportMove(options: BeginWholeSupportMoveOptions): boolean {
    const { trunkId, event, camera, domElement, scene, controls } = options;
    const trunk = getSnapshot().trunks[trunkId];
    const start = getPointerClientPosition(event);
    if (!placer || !trunk || !start || moveActive) return false;
    const activePlacer: WholeSupportPlacer = placer;

    // Hold the camera from the press on, so an orbit cannot start under the drag.
    const savedControlsEnabled = typeof controls?.enabled === 'boolean' ? controls.enabled : null;
    if (controls && savedControlsEnabled !== null) controls.enabled = false;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let meshes: THREE.Mesh[] = [];
    // Set once the press becomes a drag and the support is lifted out.
    let before: SupportEditHistorySnapshot | null = null;
    let finished = false;
    let lastHit: THREE.Intersection | null = null;
    let rafId: number | null = null;
    let pendingEvent: PointerEvent | null = null;

    const raycast = (clientX: number, clientY: number): THREE.Intersection | null => {
        const rect = domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        // Off the canvas the ray can still meet a part of the model out of view.
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        setPickRayFromCamera(raycaster, pointer, camera);
        const { clipLower, clipUpper } = getClipBounds();
        return raycaster.intersectObjects(meshes, false).find((hit) => (
            !!hit.face
            && (clipUpper == null || hit.point.z <= clipUpper)
            && (clipLower == null || hit.point.z >= clipLower)
        )) ?? null;
    };

    /** Lift the support out; false when its model cannot be found to drag over. */
    const lift = (): boolean => {
        meshes = collectModelMeshes(scene, trunk.modelId);
        if (meshes.length === 0) return false;

        const ids = [trunkId, ...symmetricSiblingTrunkIds(trunkId, meshes[0])];
        // Lifting removes with the cascade, and only the trunk is re-placed.
        if (liftWouldDropDependents(getSnapshot(), ids)) return false;
        before = captureSupportEditSnapshot();
        clearSupportSelection();
        // Lifted without history: the gesture records one entry when it lands.
        withSupportHistorySuppressed(() => removeSupportEntities(
            ids.map((id) => ({ collection: 'trunks' as const, id })),
        ));
        // The pressed tip was hovered, and it is gone now, so nothing will ever
        // clear that hover -- and a hovered support hides the placement preview.
        setHoveredState('none', null);
        setSceneHoveredSupportId(null);
        setMoveActive(true);
        document.body.style.cursor = 'grabbing';
        return true;
    };

    const handleMove = (e: PointerEvent) => {
        if (finished) return;
        if (!before) {
            if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < DRAG_THRESHOLD_PX) return;
            if (!lift()) {
                cleanup();
                return;
            }
        }
        pendingEvent = e;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            const hit = pendingEvent && raycast(pendingEvent.clientX, pendingEvent.clientY);
            pendingEvent = null;
            if (!hit) return;
            lastHit = hit;
            activePlacer.preview(hit);
        });
    };

    /** Stop listening and undo the press's side effects; returns the lifted state, if any. */
    function cleanup(): SupportEditHistorySnapshot | null {
        finished = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        window.removeEventListener('pointermove', handleMove, true);
        window.removeEventListener('pointerup', handleUp, true);
        window.removeEventListener('pointercancel', handleCancel, true);
        if (controls && savedControlsEnabled !== null) controls.enabled = savedControlsEnabled;
        if (before) {
            setMoveActive(false);
            suppressPlacementUntilMs = Date.now() + POST_MOVE_SUPPRESS_MS;
            document.body.style.cursor = '';
            activePlacer.preview(null);
        }
        return before;
    }

    function handleCancel() {
        if (finished) return;
        const lifted = cleanup();
        if (lifted) setSnapshot(lifted.support);
    }

    function handleUp(e: PointerEvent) {
        if (finished) return;
        // A press that never became a drag is a click: leave it to the tip.
        const lifted = cleanup();
        if (!lifted) return;

        const hit = raycast(e.clientX, e.clientY) ?? lastHit;
        if (!hit) {
            setSnapshot(lifted.support);
            return;
        }

        withSupportHistorySuppressed(() => activePlacer.place(hit));
        const after = captureSupportEditSnapshot();
        // A click there may place a branch, leaf or stick rather than a trunk.
        const placed = newlyPlacedSupports(lifted.support, after.support);
        if (placed.length === 0) {
            // Nothing could be placed there: put the support back where it was.
            setSnapshot(lifted.support);
            return;
        }

        pushSupportEditHistory(msg`Move support`, lifted, after);

        // Keep the moved support selected, so it can be nudged again.
        const distanceToHit = (t: (typeof placed)[number]) => (t.contact
            ? Math.hypot(t.contact.x - hit.point.x, t.contact.y - hit.point.y, t.contact.z - hit.point.z)
            : Infinity);
        const nearest = placed.reduce((best, t) => (distanceToHit(t) < distanceToHit(best) ? t : best));
        selectSupportById(nearest.id, false);
    }

    window.addEventListener('pointermove', handleMove, true);
    window.addEventListener('pointerup', handleUp, true);
    window.addEventListener('pointercancel', handleCancel, true);
    return true;
}
