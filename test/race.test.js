import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Race, formatTime } from '../game/race.js';
import { buildTrack } from '../game/track.js';

const track = buildTrack();
const L = track.length;
const DT = 1 / 120;

/**
 * A stand-in for a physics kart that drives along the centre line.
 * `s` can go past the lap length or below zero; it wraps like a real kart would.
 */
function fakeKart(startS) {
  const kart = { s: startS, speed: 0, heading: 0, x: 0, z: 0, where: null };
  kart.moveTo = (s, speed = 20, backwards = false) => {
    kart.s = s;
    const p = track.pointAt(s);
    kart.x = p.x;
    kart.z = p.z;
    kart.heading = backwards ? p.heading + Math.PI : p.heading;
    kart.speed = speed;
    kart.where = track.locate(p.x, p.z, kart.where?.index ?? null);
  };
  kart.moveTo(startS, 0);
  return kart;
}

/** Run the race clock, moving each kart forward at its speed. */
function run(race, karts, seconds, speeds = new Map()) {
  const events = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    for (const [slot, kart] of karts) {
      const v = speeds.get(slot) ?? 0;
      if (!race.frozen && v !== 0) kart.moveTo(kart.s + v * DT, Math.abs(v), v < 0);
    }
    events.push(...race.update(DT, karts));
  }
  return events;
}

function grid(...slots) {
  return new Map(slots.map((slot) => [slot, fakeKart(L - 6 - 4 * slot)]));
}

test('practice until started; then a 3 s countdown with karts frozen; then GO', () => {
  const race = new Race(track);
  const karts = grid(1);
  assert.deepEqual(race.update(DT, karts), []);
  assert.equal(race.phase, 'practice');

  race.start(karts);
  assert.equal(race.phase, 'countdown');
  assert.ok(race.frozen);
  assert.ok(race.racers.get(1).progress < 0, 'starts just behind the line');

  const events = run(race, karts, 3.01);
  assert.equal(race.phase, 'racing');
  assert.ok(events.some((e) => e.type === 'go'));
  assert.ok(race.time < 0.02);
});

test('driving three laps passes every checkpoint in order, times each lap, and finishes', () => {
  const race = new Race(track);
  const karts = grid(1);
  race.start(karts);
  run(race, karts, 3);

  const v = 25; // m/s along the centre line
  const events = run(race, karts, (3 * L + 30) / v, new Map([[1, v]]));
  const laps = events.filter((e) => e.type === 'lap');
  assert.deepEqual(
    laps.map((e) => e.lap),
    [1, 2, 3],
  );
  // Every lap: checkpoints 1..7, then the finish line.
  const checkpoints = events.filter((e) => e.type === 'checkpoint').map((e) => e.checkpoint);
  assert.deepEqual(checkpoints, [1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7]);
  // Laps 2 and 3 are exactly one lap long at 25 m/s (lap 1 includes the run-up from the grid).
  assert.ok(Math.abs(laps[1].lapTime - L / v) < 0.05, `lap 2: ${laps[1].lapTime}`);
  assert.ok(laps[0].lapTime > laps[1].lapTime);

  const finish = events.find((e) => e.type === 'finish');
  assert.equal(finish.place, 1);
  assert.equal(race.phase, 'finished', 'everyone home: results');
  assert.equal(race.racers.get(1).bestLap, Math.min(...race.racers.get(1).lapTimes));
});

test('standings: further along wins, finishers ahead of everyone', () => {
  const race = new Race(track);
  const karts = grid(1, 2);
  race.start(karts);
  run(race, karts, 3);
  run(race, karts, 10, new Map([[1, 20], [2, 24]]));
  assert.deepEqual(
    race.standings().map((r) => r.slot),
    [2, 1],
  );
  assert.equal(race.standings()[0].place, 1);
});

test('reversing over the line and back does not count a lap', () => {
  const race = new Race(track);
  const karts = grid(1);
  race.start(karts);
  run(race, karts, 3);

  // Drive across the line, back over it, and across again.
  const events = [
    ...run(race, karts, 2, new Map([[1, 10]])),
    ...run(race, karts, 2, new Map([[1, -10]])),
    ...run(race, karts, 2, new Map([[1, 10]])),
  ];
  assert.equal(events.filter((e) => e.type === 'lap').length, 0);
  assert.equal(race.racers.get(1).lap, 0);
});

test('a jump (respawn, shortcut through a glitch) does not count as distance', () => {
  const race = new Race(track);
  const karts = grid(1);
  race.start(karts);
  run(race, karts, 3);
  const kart = karts.get(1);
  const before = race.racers.get(1).progress;

  kart.where = null; // forget the hint: a long jump forward
  kart.moveTo(L / 2, 20);
  race.update(DT, karts);
  assert.equal(race.racers.get(1).progress, before);
});

test('wrong way shows after a moment of going backwards, and clears when you turn round', () => {
  const race = new Race(track);
  const karts = grid(1);
  race.start(karts);
  run(race, karts, 3);
  run(race, karts, 2, new Map([[1, 15]]));

  run(race, karts, 0.5, new Map([[1, -10]]));
  assert.equal(race.racers.get(1).wrongWay, false, 'not straight away');
  run(race, karts, 0.6, new Map([[1, -10]]));
  assert.equal(race.racers.get(1).wrongWay, true);

  run(race, karts, 1, new Map([[1, 10]]));
  assert.equal(race.racers.get(1).wrongWay, false);
});

test('stragglers get a grace period after the winner, then a DNF', () => {
  const race = new Race(track, { laps: 1, finishGraceS: 5 });
  const karts = grid(1, 2);
  race.start(karts);
  run(race, karts, 3);
  run(race, karts, (L + 40) / 25, new Map([[1, 25]])); // P1 finishes, P2 sits still
  assert.equal(race.phase, 'racing');
  const events = run(race, karts, 5.1);
  assert.ok(events.some((e) => e.type === 'results'));
  assert.equal(race.phase, 'finished');
  assert.equal(race.racers.get(2).dnf, true);
  assert.deepEqual(
    race.standings().map((r) => r.slot),
    [1, 2],
  );
});

test('a racer whose player leaves is a DNF, and the race can still end', () => {
  const race = new Race(track, { laps: 1 });
  const karts = grid(1, 2);
  race.start(karts);
  run(race, karts, 3);
  karts.delete(2);
  run(race, karts, (L + 40) / 25, new Map([[1, 25]]));
  assert.equal(race.racers.get(2).dnf, true);
  assert.equal(race.phase, 'finished');
});

test('current lap is capped at the last lap, and stop() goes back to practice', () => {
  const race = new Race(track, { laps: 2 });
  const karts = grid(1);
  race.start(karts);
  assert.equal(race.currentLap(1), 1);
  assert.equal(race.currentLap(9), null);
  race.stop();
  assert.equal(race.phase, 'practice');
  assert.equal(race.isRacing(1), false);
});

test('formatTime', () => {
  assert.equal(formatTime(83.4567), '1:23.457');
  assert.equal(formatTime(5), '0:05.000');
  assert.equal(formatTime(null), '–');
});
