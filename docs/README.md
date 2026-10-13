# Tech docs

Everything written down about how this game works and why it's built this way. Code comments explain *what a line does*; these docs explain *how the pieces fit* and *what you learned building them*.

| Doc | What's in it |
| --- | --- |
| [learning-plan.md](learning-plan.md) | The 9 phases, their "done when" tests, and where each one stands |
| [architecture.md](architecture.md) | The three parts (phones, relay server, shared screen) and the repo layout |
| [decisions.md](decisions.md) | Short log of design choices and the reasoning behind them |
| [phase-0-setup.md](phase-0-setup.md) | Dev server, HTTPS on your phone, troubleshooting |
| [phase-1-steering.md](phase-1-steering.md) | How phone tilt becomes a steering value, step by step |
| [phase-2-networking.md](phase-2-networking.md) | Rooms, the message protocol, reconnects, measuring lag |
| [phase-3-driving.md](phase-3-driving.md) | Three.js scene, fixed timestep, arcade kart physics, input mixing, cameras |

## Conventions

- One `phase-N-<topic>.md` per phase: goal, how it works, how to test it, what's next.
- Add a line to [decisions.md](decisions.md) whenever you pick one approach over another.
- Update the status table in [learning-plan.md](learning-plan.md) when a phase passes its "done when" test.
- Diagrams use Mermaid code blocks, which GitHub renders.
