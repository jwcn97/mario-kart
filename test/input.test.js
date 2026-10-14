import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputHub } from '../game/input.js';

const DT = 1 / 120;
const tickFor = (hub, seconds) => {
  for (let t = 0; t < seconds; t += DT) hub.tick(DT);
};

test('phone input is used while fresh', () => {
  const hub = new InputHub();
  hub.phoneInput(1, { steer: 0.4, gas: true }, 1000);
  assert.deepEqual(hub.get(1, 1100), { steer: 0.4, gas: true, brake: false, drift: false, source: 'phone' });
});

test('a phone that goes quiet counts as hands off after 500 ms', () => {
  const hub = new InputHub();
  hub.phoneInput(1, { steer: 1, gas: true }, 1000);
  assert.equal(hub.get(1, 1600).source, 'none');
  assert.equal(hub.get(1, 1600).gas, false);
});

test('gas and brake must be real booleans', () => {
  const hub = new InputHub();
  hub.phoneInput(1, { gas: 'yes', brake: 1 }, 0);
  const input = hub.get(1, 0);
  assert.equal(input.gas, false);
  assert.equal(input.brake, false);
});

test('arrow keys drive P1 and override its phone; letting go hands back', () => {
  const hub = new InputHub();
  hub.phoneInput(1, { steer: -0.5, gas: false }, 0);

  hub.keyDown('ArrowUp');
  hub.keyDown('ArrowRight');
  tickFor(hub, 0.5);
  const kb = hub.get(1, 100);
  assert.equal(kb.source, 'keyboard');
  assert.equal(kb.gas, true);
  assert.equal(kb.steer, 1);

  hub.keyUp('ArrowUp');
  hub.keyUp('ArrowRight');
  tickFor(hub, 0.5); // steering eases back to centre first
  assert.equal(hub.get(1, 200).source, 'phone');
});

test('keyboard steering ramps in instead of snapping', () => {
  const hub = new InputHub();
  hub.keyDown('ArrowLeft');
  hub.tick(DT);
  const steer = hub.get(1, 0).steer;
  assert.ok(steer < 0 && steer > -0.1, `after one step: ${steer}`);
  tickFor(hub, 0.3);
  assert.equal(hub.get(1, 0).steer, -1);
});

test('W A S D drive P2 without touching P1', () => {
  const hub = new InputHub();
  hub.keyDown('KeyW');
  assert.equal(hub.get(2, 0).gas, true);
  assert.equal(hub.get(1, 0).source, 'none');
  assert.deepEqual([...hub.keyboardUsed], [2]);
});

test('releaseAllKeys drops stuck keys', () => {
  const hub = new InputHub();
  hub.keyDown('ArrowUp');
  hub.releaseAllKeys();
  assert.equal(hub.get(1, 0).gas, false);
});

test('Right Shift drifts for P1 while driving with the arrows; Shift alone does not take over a phone', () => {
  const hub = new InputHub();
  hub.phoneInput(1, { steer: 0.5, gas: true, drift: true }, 0);
  hub.keyDown('ShiftRight');
  assert.equal(hub.get(1, 10).source, 'phone', 'Shift alone leaves the phone in charge');
  assert.equal(hub.get(1, 10).drift, true, 'the phone is drifting');
  assert.equal(hub.keyboardUsed.has(1), false);

  hub.keyDown('ArrowUp');
  const kb = hub.get(1, 10);
  assert.equal(kb.source, 'keyboard');
  assert.equal(kb.drift, true);
});
