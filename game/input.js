/**
 * Input hub: one place the game asks "what is player N pressing right now?"
 * The game never cares whether the answer came from a phone or a keyboard.
 *
 * Sources:
 *  - phones: the latest { steer, gas, brake } from the relay, per slot. If a phone
 *    goes quiet for 500 ms (locked, out of range) its input counts as released,
 *    so a kart never drives off on its own.
 *  - keyboard: arrows drive P1, W A S D drive P2, each with a Shift key to
 *    drift. While any of a slot's keys are held, the keyboard overrides that
 *    slot's phone. Let go and the phone is back.
 */

export const KEYBOARD_LAYOUTS = Object.freeze({
  1: { left: ['ArrowLeft'], right: ['ArrowRight'], gas: ['ArrowUp'], brake: ['ArrowDown'], drift: ['ShiftRight'] },
  2: { left: ['KeyA'], right: ['KeyD'], gas: ['KeyW'], brake: ['KeyS'], drift: ['ShiftLeft'] },
});

const STEER_IN_PER_S = 4; // keyboard steering ramps in over 0.25 s...
const STEER_OUT_PER_S = 8; // ...and centres twice as fast
const NONE = Object.freeze({ steer: 0, gas: false, brake: false, drift: false, source: 'none' });

export class InputHub {
  constructor({ staleMs = 500, layouts = KEYBOARD_LAYOUTS } = {}) {
    this.staleMs = staleMs;
    this.layouts = layouts;
    this.phones = new Map(); // slot -> { steer, gas, brake, at }
    this.pressed = new Set(); // KeyboardEvent.code values held down
    this.keyboardSteer = new Map(); // slot -> eased steering from keys
    this.keyboardUsed = new Set(); // slots the keyboard has ever driven
  }

  /** Every key this hub listens to, so the page can stop arrows from scrolling. */
  get keyCodes() {
    return new Set(Object.values(this.layouts).flatMap((l) => Object.values(l).flat()));
  }

  phoneInput(slot, { steer = 0, gas = false, brake = false, drift = false }, at) {
    this.phones.set(slot, { steer, gas: gas === true, brake: brake === true, drift: drift === true, at });
  }

  forgetPhone(slot) {
    this.phones.delete(slot);
  }

  keyDown(code) {
    this.pressed.add(code);
    for (const [slot, layout] of Object.entries(this.layouts)) {
      const driving = ['left', 'right', 'gas', 'brake'].some((action) => layout[action].includes(code));
      if (driving) this.keyboardUsed.add(Number(slot));
    }
  }

  keyUp(code) {
    this.pressed.delete(code);
  }

  /** Forget held keys (e.g. the window lost focus, so we'd never see the key-up). */
  releaseAllKeys() {
    this.pressed.clear();
  }

  #held(slot, action) {
    return this.layouts[slot]?.[action].some((code) => this.pressed.has(code)) ?? false;
  }

  #keyboardActive(slot) {
    const layout = this.layouts[slot];
    if (!layout) return false;
    // Drift alone doesn't take over: holding Shift shouldn't steal a phone's kart.
    const anyHeld = ['left', 'right', 'gas', 'brake'].some((action) => this.#held(slot, action));
    return anyHeld || (this.keyboardSteer.get(slot) ?? 0) !== 0;
  }

  /** Ease keyboard steering towards the held direction. Call once per physics step. */
  tick(dt) {
    for (const slot of Object.keys(this.layouts).map(Number)) {
      const target = (this.#held(slot, 'right') ? 1 : 0) - (this.#held(slot, 'left') ? 1 : 0);
      const current = this.keyboardSteer.get(slot) ?? 0;
      const rate = target === 0 || Math.sign(target) !== Math.sign(current) ? STEER_OUT_PER_S : STEER_IN_PER_S;
      const delta = target - current;
      const stepped = Math.abs(delta) <= rate * dt ? target : current + Math.sign(delta) * rate * dt;
      this.keyboardSteer.set(slot, stepped);
    }
  }

  /** What slot `slot` is pressing at time `now` (ms). */
  get(slot, now) {
    if (this.#keyboardActive(slot)) {
      return {
        steer: this.keyboardSteer.get(slot) ?? 0,
        gas: this.#held(slot, 'gas'),
        brake: this.#held(slot, 'brake'),
        drift: this.#held(slot, 'drift'),
        source: 'keyboard',
      };
    }
    const phone = this.phones.get(slot);
    if (phone && now - phone.at <= this.staleMs) {
      return { steer: phone.steer, gas: phone.gas, brake: phone.brake, drift: phone.drift, source: 'phone' };
    }
    return NONE;
  }
}
