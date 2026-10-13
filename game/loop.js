/**
 * Fixed-timestep game loop ("Fix Your Timestep", Gaffer on Games).
 *
 * Screens refresh at 30, 60, 120 or 144 Hz, and frames arrive unevenly. If physics
 * stepped by "however long this frame took", karts would handle differently on
 * every machine. Instead, real time goes into an accumulator and physics always
 * advances in equal slices (120 per second). Rendering then draws the karts a
 * fraction `alpha` of the way between the last two physics states, so motion
 * stays smooth on any screen.
 *
 *   frame time ─► accumulator ─► step(1/120 s) while enough time ─► render(alpha)
 */
export function createFixedStep({ stepHz = 120, maxStepsPerFrame = 10, step }) {
  const stepMs = 1000 / stepHz;
  let accumulator = 0;

  return {
    stepMs,
    /**
     * Feed it the real time since the last frame. Returns how many steps ran and
     * alpha (0..1) for interpolation. A long pause (tab in the background) is capped,
     * so the game doesn't try to catch up on minutes of physics at once.
     */
    advance(frameMs) {
      accumulator += Math.min(Math.max(frameMs, 0), stepMs * maxStepsPerFrame);
      let steps = 0;
      while (accumulator >= stepMs) {
        step(stepMs / 1000);
        accumulator -= stepMs;
        steps++;
      }
      return { steps, alpha: accumulator / stepMs };
    },
  };
}
