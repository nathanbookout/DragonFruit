import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RAFT_SETTINGS } from '../RaftDefaults';
import {
  getRaftSettings,
  readSavedRaftSettings,
  setRaftSettings,
  updateRaftSettings,
} from '../RaftState';

function reset(): void {
  setRaftSettings(DEFAULT_RAFT_SETTINGS);
}

test('a line base never keeps a wall', () => {
  reset();
  updateRaftSettings({ bottomMode: 'line' });
  assert.equal(getRaftSettings().wallEnabled, false);
});

test('the mode round-trip restores a wall that was on', () => {
  reset();
  assert.equal(getRaftSettings().wallEnabled, true);

  updateRaftSettings({ bottomMode: 'line' });
  updateRaftSettings({ bottomMode: 'solid' });

  assert.equal(getRaftSettings().wallEnabled, true);
});

test('the mode round-trip keeps a wall the user turned off', () => {
  reset();
  updateRaftSettings({ wallEnabled: false });

  updateRaftSettings({ bottomMode: 'line' });
  updateRaftSettings({ bottomMode: 'solid' });

  assert.equal(getRaftSettings().wallEnabled, false);
});

test('a saved scene with the wall off reopens with the wall off', () => {
  reset();
  // What a scene saves: the settings as they were, wall turned off.
  updateRaftSettings({ wallEnabled: false });
  const saved = JSON.parse(JSON.stringify(getRaftSettings())) as unknown;

  reset();
  assert.equal(getRaftSettings().wallEnabled, true);

  const restored = readSavedRaftSettings(saved);
  assert.ok(restored);
  setRaftSettings(restored);
  assert.equal(getRaftSettings().wallEnabled, false);
  assert.equal(getRaftSettings().bottomMode, 'solid');
});

test('saved raft settings ignore bad values and fall back to defaults', () => {
  assert.equal(readSavedRaftSettings(undefined), null);
  assert.equal(readSavedRaftSettings('nope'), null);
  assert.equal(readSavedRaftSettings({ unrelated: 1 }), null);

  const restored = readSavedRaftSettings({ wallEnabled: false, thickness: 'thick', bottomMode: 'weird' });
  assert.ok(restored);
  assert.equal(restored.wallEnabled, false);
  assert.equal(restored.thickness, DEFAULT_RAFT_SETTINGS.thickness);

  // An unknown mode survives the read but not the store's normalisation.
  setRaftSettings(restored);
  assert.equal(getRaftSettings().bottomMode, DEFAULT_RAFT_SETTINGS.bottomMode);
});
