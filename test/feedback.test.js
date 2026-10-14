import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Feedback } from '../game/feedback.js';

function setup() {
  const sent = [];
  const shakes = [];
  const squashes = [];
  const feedback = new Feedback({
    send: (slot, data) => sent.push({ slot, data }),
    effects: { shake: (a) => shakes.push(a), squash: (slot) => squashes.push(slot) },
  });
  return { feedback, sent, shakes, squashes };
}

test('a boost pad buzzes that player’s phone and nudges the camera', () => {
  const { feedback, sent, shakes } = setup();
  feedback.handle([{ slot: 2, type: 'boost-pad' }], 0);
  feedback.flush();
  assert.deepEqual(sent, [{ slot: 2, data: { buzz: [40, 30, 40] } }]);
  assert.equal(shakes.length, 1);
});

test('wall scrapes are ignored; real hits buzz harder the harder you hit', () => {
  const { feedback, sent } = setup();
  feedback.handle([{ slot: 1, type: 'hit', strength: 0.5 }], 0);
  feedback.flush();
  assert.equal(sent.length, 0);

  feedback.handle([{ slot: 1, type: 'hit', strength: 4 }], 1000);
  feedback.handle([{ slot: 2, type: 'hit', strength: 20 }], 1000);
  feedback.flush();
  const [soft, hard] = sent.map((m) => m.data.buzz[0]);
  assert.ok(hard > soft, `${soft} vs ${hard}`);
});

test('at most one buzz per phone every 120 ms', () => {
  const { feedback, sent } = setup();
  for (let t = 0; t < 100; t += 10) feedback.handle([{ slot: 1, type: 'bump' }], t);
  feedback.flush();
  assert.equal(sent.length, 1);
  feedback.handle([{ slot: 1, type: 'bump' }], 130);
  feedback.flush();
  assert.equal(sent.length, 2);
});

test('landing squashes the kart', () => {
  const { feedback, squashes } = setup();
  feedback.handle([{ slot: 3, type: 'land' }], 0);
  assert.deepEqual(squashes, [3]);
});

test('drift charge is sent only when it changes, merged with any buzz', () => {
  const { feedback, sent } = setup();
  const kart = { drift: { dir: 0, level: 0 } };
  feedback.drift(1, kart);
  feedback.flush();
  assert.deepEqual(sent.pop(), { slot: 1, data: { drift: -1 } });

  feedback.drift(1, kart);
  feedback.flush();
  assert.equal(sent.length, 0, 'unchanged: nothing sent');

  kart.drift = { dir: 1, level: 1 };
  feedback.handle([{ slot: 1, type: 'drift-level-1' }], 500);
  feedback.drift(1, kart);
  feedback.flush();
  assert.deepEqual(sent.pop(), { slot: 1, data: { buzz: [12], drift: 1 } });
});
