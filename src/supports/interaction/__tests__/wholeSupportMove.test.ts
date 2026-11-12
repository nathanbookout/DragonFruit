import assert from 'node:assert/strict';
import test from 'node:test';

import { liftWouldDropDependents } from '../wholeSupportMove';
import { SUPPORT_COLLECTION_KEYS } from '../../supportTypeRegistry';
import { keyOf } from '../../__tests__/helpers/typeCollections';
import type { SupportState } from '../../types';

const seg = (id: string) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

function build(parts: Partial<Record<string, Record<string, unknown>>>): SupportState {
    const state = {} as Record<string, Record<string, unknown>>;
    for (const key of SUPPORT_COLLECTION_KEYS) state[key] = {};
    return { ...state, ...parts } as unknown as SupportState;
}

const TRUNKS = keyOf('trunk');
const BRANCHES = keyOf('branch');

const trunk = {
    'trunk-0': { id: 'trunk-0', typeId: 'trunk', modelId: 'm', rootId: 'root-0', segments: [seg('seg-t0')] },
};
const roots = { 'root-0': { id: 'root-0', modelId: 'm' } };

test('a lone trunk (with its root) can be lifted', () => {
    const state = build({ roots, [TRUNKS]: trunk });
    assert.equal(liftWouldDropDependents(state, ['trunk-0']), false);
});

test('a trunk carrying a branch cannot be lifted without losing it', () => {
    const state = build({
        roots,
        [TRUNKS]: trunk,
        knots: { 'knot-0': { id: 'knot-0', parentShaftId: 'seg-t0' } },
        [BRANCHES]: {
            'branch-0': { id: 'branch-0', typeId: 'branch', modelId: 'm', parentKnotId: 'knot-0', segments: [seg('seg-b0')] },
        },
    });
    assert.equal(liftWouldDropDependents(state, ['trunk-0']), true);
});
