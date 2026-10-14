/**
 * Live tuning panel (T on the game screen), built with lil-gui.
 *
 * Every kart number in KART_PARAMS gets a slider. Drag while driving, feel the
 * difference straight away. Changes are saved in this browser; "Copy as code"
 * puts the current values on the clipboard, ready to paste over KART_PARAMS in
 * physics.js once you like them.
 */
import GUI from 'lil-gui';
import { KART_PARAMS } from './physics.js';

const STORAGE_KEY = 'kart.params.v2'; // v2: drift turning changed meaning, old tweaks dropped

/** [key, min, max, step] per folder. Anything in KART_PARAMS not listed here isn't tunable. */
const FOLDERS = {
  Speed: [
    ['maxSpeed', 10, 40, 0.5],
    ['accel', 4, 40, 0.5],
    ['brake', 5, 60, 1],
    ['coastDrag', 0, 10, 0.1],
    ['airDrag', 0, 0.05, 0.001],
  ],
  Steering: [
    ['maxTurnRate', 0.5, 5, 0.05],
    ['fullTurnSpeed', 1, 15, 0.5],
    ['topSpeedTurnLoss', 0, 0.9, 0.05],
  ],
  Drift: [
    ['driftMinSpeed', 2, 20, 0.5],
    ['driftStartSteer', 0, 0.9, 0.05],
    ['driftTurnOut', 0, 1, 0.05],
    ['driftTurnBase', 0, 1.5, 0.05],
    ['driftTurnIn', 0.3, 2, 0.05],
    ['driftDrag', 0, 8, 0.1],
    ['driftLevel1', 0.2, 3, 0.05],
    ['driftLevel2', 0.5, 5, 0.05],
    ['miniTurbo1', 0, 2, 0.05],
    ['miniTurbo2', 0, 3, 0.05],
  ],
  'Boost & jumps': [
    ['boostSpeed', 20, 50, 0.5],
    ['boostAccel', 0, 80, 1],
    ['overSpeedDrag', 1, 40, 0.5],
    ['padBoost', 0, 3, 0.05],
    ['gravity', 5, 50, 0.5],
    ['airSteer', 0, 1, 0.05],
  ],
  'Grass & walls': [
    ['offRoadMaxSpeed', 3, 25, 0.5],
    ['offRoadDrag', 0, 60, 1],
    ['wallBounce', 0, 1, 0.05],
    ['kartBounce', 0, 1, 0.05],
  ],
};

/** Defaults, overridden by any saved numbers for keys that still exist. */
export function loadParams() {
  const params = { ...KART_PARAMS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const [key, value] of Object.entries(saved)) {
      if (key in params && typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    }
  } catch {
    // nothing saved, or storage blocked
  }
  return params;
}

function saveParams(params) {
  try {
    const changed = Object.fromEntries(Object.entries(params).filter(([k, v]) => KART_PARAMS[k] !== v));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changed));
  } catch {
    // fine: changes just won't survive a reload
  }
}

/** Build the (hidden) panel. Returns { toggle() }. `world.juice` scales shake and FOV kick. */
export function createTuningPanel(params, { world, onMessage = () => {} }) {
  const gui = new GUI({ title: 'Tuning (T to hide)', width: 300 });
  gui.domElement.style.zIndex = 5;

  for (const [name, rows] of Object.entries(FOLDERS)) {
    const folder = gui.addFolder(name);
    for (const [key, min, max, step] of rows) {
      folder.add(params, key, min, max, step).onChange(() => saveParams(params));
    }
    folder.close();
  }
  gui.addFolder('Effects').add(world, 'juice', 0, 2, 0.05).name('juice (shake, FOV)');

  const actions = {
    copy: async () => {
      const code = `export const KART_PARAMS = Object.freeze(${JSON.stringify(params, null, 2)});`;
      console.log(code);
      try {
        await navigator.clipboard.writeText(code);
        onMessage('Copied the numbers: paste over KART_PARAMS in game/physics.js');
      } catch {
        onMessage('Couldn’t reach the clipboard: the numbers are in the browser console');
      }
    },
    reset: () => {
      Object.assign(params, KART_PARAMS);
      saveParams(params);
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      onMessage('Tuning reset to the defaults');
    },
  };
  gui.add(actions, 'copy').name('Copy as code');
  gui.add(actions, 'reset').name('Reset to defaults');
  gui.hide();

  return {
    toggle() {
      gui.show(gui._hidden);
      return !gui._hidden;
    },
  };
}
