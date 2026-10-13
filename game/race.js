/**
 * Race rules: countdown, checkpoints, laps, timing, wrong-way, standings.
 * Pure logic on the physics clock (summed fixed steps, not wall time), so lap
 * times are exact and the rules are unit-tested without a browser.
 *
 *   practice ──start()──► countdown (3 s, karts frozen) ──► racing ──► finished
 *       ▲                                                                 │
 *       └──────────────────────────── stop() ─────────────────────────────┘
 *
 * Progress: each kart has a running "distance driven along the track" built
 * from how its position along the lap (`s`) changes every step. Driving
 * backwards takes it down; a lap only counts when progress passes a whole lap
 * further, through every checkpoint in order. Jumps (a respawn, a glitch) are
 * ignored, so the only way to finish is to drive it.
 */
import { wrapDelta } from './track.js';

export const RACE_RULES = Object.freeze({
  laps: 3,
  checkpoints: 8, // gates per lap, evenly spaced; the last one is the finish line
  countdownS: 3,
  finishGraceS: 30, // after the winner finishes, how long the others get
  maxStepM: 5, // a progress change bigger than this in one physics step is a jump, not driving
  wrongWaySpeed: 2, // m/s backwards along the track...
  wrongWayDelayS: 0.8, // ...for this long shows the warning
});

export class Race {
  constructor(track, rules = {}) {
    this.track = track;
    this.rules = { ...RACE_RULES, ...rules };
    this.phase = 'practice';
    this.time = 0; // seconds since GO
    this.countdown = 0; // seconds left before GO
    this.racers = new Map(); // slot -> racer state
    this.finishOrder = [];
    this.firstFinishTime = null;
  }

  /** Begin the countdown for these karts (already placed on the grid). */
  start(karts) {
    this.phase = 'countdown';
    this.time = 0;
    this.countdown = this.rules.countdownS;
    this.finishOrder = [];
    this.firstFinishTime = null;
    this.racers = new Map();
    for (const [slot, kart] of karts) {
      const s = this.#locate(kart).s;
      this.racers.set(slot, {
        slot,
        progress: wrapDelta(s, this.track.length), // just behind the line: a little negative
        lastS: s,
        lap: 0, // laps completed
        nextCheckpoint: 1,
        lapStart: 0,
        lapTimes: [],
        bestLap: null,
        finishTime: null,
        dnf: false,
        wrongWayFor: 0,
        wrongWay: false,
      });
    }
  }

  /** Back to free driving. */
  stop() {
    this.phase = 'practice';
    this.racers = new Map();
    this.countdown = 0;
  }

  /** Karts can't move during the countdown. */
  get frozen() {
    return this.phase === 'countdown';
  }

  isRacing(slot) {
    return this.racers.has(slot);
  }

  /**
   * Advance by one physics step. `karts` = Map<slot, kart> after physics moved them.
   * Returns events for the screen to react to: go, checkpoint, lap, finish, results.
   */
  update(dt, karts) {
    const events = [];
    if (this.phase === 'practice') return events;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown > 0) return events;
      this.phase = 'racing';
      this.time = -this.countdown; // carry the overshoot so timing stays exact
      this.countdown = 0;
      events.push({ type: 'go' });
      return events;
    }

    this.time += dt;
    if (this.phase !== 'racing') return events;

    for (const racer of this.racers.values()) {
      if (racer.finishTime !== null || racer.dnf) continue;
      const kart = karts.get(racer.slot);
      if (!kart) {
        racer.dnf = true; // the player left the room (their slot's grace period ran out)
        continue;
      }
      this.#advance(racer, kart, dt, events);
    }

    // Everyone home, or the stragglers ran out of time: show results.
    const active = [...this.racers.values()].filter((r) => r.finishTime === null && !r.dnf);
    const timeUp = this.firstFinishTime !== null && this.time - this.firstFinishTime >= this.rules.finishGraceS;
    if (active.length === 0 || timeUp) {
      for (const r of active) r.dnf = true;
      this.phase = 'finished';
      events.push({ type: 'results' });
    }
    return events;
  }

  #locate(kart) {
    return kart.where ?? this.track.locate(kart.x, kart.z);
  }

  #advance(racer, kart, dt, events) {
    const { length } = this.track;
    const { checkpoints, laps } = this.rules;
    const where = this.#locate(kart);

    // 1. Progress: how far along the track it moved this step (the short way round).
    const delta = wrapDelta(where.s - racer.lastS, length);
    racer.lastS = where.s;
    if (Math.abs(delta) <= this.rules.maxStepM) racer.progress += delta;

    // 2. Checkpoints in order; the last one of each lap is the finish line.
    for (;;) {
      const gate = racer.lap * length + (racer.nextCheckpoint / checkpoints) * length;
      if (racer.progress < gate) break;
      if (racer.nextCheckpoint < checkpoints) {
        events.push({ type: 'checkpoint', slot: racer.slot, checkpoint: racer.nextCheckpoint });
        racer.nextCheckpoint++;
        continue;
      }
      // Crossed the finish line with every checkpoint behind us: a lap.
      const lapTime = this.time - racer.lapStart;
      racer.lapTimes.push(lapTime);
      racer.bestLap = racer.bestLap === null ? lapTime : Math.min(racer.bestLap, lapTime);
      racer.lapStart = this.time;
      racer.lap++;
      racer.nextCheckpoint = 1;
      events.push({ type: 'lap', slot: racer.slot, lap: racer.lap, lapTime });
      if (racer.lap >= laps) {
        racer.finishTime = this.time;
        this.finishOrder.push(racer.slot);
        this.firstFinishTime ??= this.time;
        events.push({ type: 'finish', slot: racer.slot, place: this.finishOrder.length, time: this.time });
        break;
      }
    }

    // 3. Wrong way: moving backwards along the track for a moment.
    const alongTrack = kart.speed * (Math.sin(kart.heading) * where.tx + Math.cos(kart.heading) * where.tz);
    racer.wrongWayFor = alongTrack < -this.rules.wrongWaySpeed ? racer.wrongWayFor + dt : Math.max(0, racer.wrongWayFor - 2 * dt);
    racer.wrongWay = racer.wrongWayFor >= this.rules.wrongWayDelayS;
  }

  /** Current order: finishers by time, then everyone else by distance driven. */
  standings() {
    const list = [...this.racers.values()];
    list.sort((a, b) => {
      if (a.finishTime !== null || b.finishTime !== null) {
        if (a.finishTime === null) return 1;
        if (b.finishTime === null) return -1;
        return a.finishTime - b.finishTime;
      }
      return b.progress - a.progress;
    });
    return list.map((racer, i) => ({ ...racer, place: i + 1 }));
  }

  /** Lap shown on screen: the one being driven, capped at the last lap. */
  currentLap(slot) {
    const racer = this.racers.get(slot);
    return racer ? Math.min(racer.lap + 1, this.rules.laps) : null;
  }

  /** Time into the lap being driven. */
  currentLapTime(slot) {
    const racer = this.racers.get(slot);
    if (!racer || this.phase === 'countdown') return 0;
    return (racer.finishTime ?? this.time) - racer.lapStart;
  }
}

/** 83.456 -> "1:23.456" */
export function formatTime(seconds) {
  if (seconds === null || seconds === undefined) return '–';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
