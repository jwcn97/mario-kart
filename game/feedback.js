/**
 * Feedback: turns physics events into things you feel.
 *   - on the game screen: camera shake, landing squash
 *   - on each player's phone: vibration patterns, and the drift pad's glow
 *
 * No Three.js or DOM here: effects and sending are passed in, so the rules
 * (which event buzzes how, how often) are unit-tested in test/feedback.test.js.
 */

/** Vibration patterns in ms: buzz, pause, buzz… (Android only; iPhones ignore vibration). */
export const BUZZ = Object.freeze({
  hit: (strength) => [Math.round(Math.min(90, 20 + strength * 5))],
  bump: () => [25],
  'boost-pad': () => [40, 30, 40],
  'mini-turbo-1': () => [30],
  'mini-turbo-2': () => [30, 20, 60],
  'drift-level-1': () => [12],
  'drift-level-2': () => [12, 40, 12],
  land: () => [35],
});

/** Camera shake (0..1 trauma) per event. */
const SHAKE = {
  hit: (strength) => Math.min(0.6, strength / 25),
  bump: () => 0.15,
  land: () => 0.12,
  'boost-pad': () => 0.08,
  'mini-turbo-2': () => 0.06,
};

export class Feedback {
  /**
   * send(slot, data)       deliver { buzz?, drift? } to that player's phone
   * effects.shake(amount)  shake the game screen's camera
   * effects.squash(slot)   squash a kart on landing
   */
  constructor({ send, effects = {}, minGapMs = 120, minHitStrength = 2 }) {
    this.send = send;
    this.effects = effects;
    this.minGapMs = minGapMs; // at most one buzz this often per phone (scraping a wall fires every step)
    this.minHitStrength = minHitStrength; // m/s of speed lost: below this a wall touch is just a scrape
    this.lastBuzzAt = new Map();
    this.lastDrift = new Map();
    this.pending = new Map(); // slot -> data to send on flush()
  }

  #queue(slot, patch) {
    this.pending.set(slot, { ...this.pending.get(slot), ...patch });
  }

  /** Physics events from this frame's steps. `now` in ms. */
  handle(events, now) {
    for (const e of events) {
      if (e.type === 'hit' && (e.strength ?? 0) < this.minHitStrength) continue;

      const shake = SHAKE[e.type]?.(e.strength ?? 0);
      if (shake) this.effects.shake?.(shake);
      if (e.type === 'land') this.effects.squash?.(e.slot);

      const pattern = BUZZ[e.type]?.(e.strength ?? 0);
      if (!pattern) continue;
      const last = this.lastBuzzAt.get(e.slot) ?? -Infinity;
      if (now - last < this.minGapMs) continue;
      this.lastBuzzAt.set(e.slot, now);
      this.#queue(e.slot, { buzz: pattern });
    }
  }

  /** Tell a phone its drift charge whenever it changes: -1 none, 0 drifting, 1 blue, 2 orange. */
  drift(slot, kart) {
    const level = kart.drift.dir === 0 ? -1 : kart.drift.level;
    if (this.lastDrift.get(slot) === level) return;
    this.lastDrift.set(slot, level);
    this.#queue(slot, { drift: level });
  }

  /** Forget a player (left the room), so a new one starts fresh. */
  forget(slot) {
    this.lastBuzzAt.delete(slot);
    this.lastDrift.delete(slot);
    this.pending.delete(slot);
  }

  /** Send what this frame collected: one message per phone at most. */
  flush() {
    for (const [slot, data] of this.pending) this.send(slot, data);
    this.pending.clear();
  }
}
