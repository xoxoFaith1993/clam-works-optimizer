# Clam Works Optimizer

**Use it:** https://xoxofaith1993.github.io/clam-works-optimizer/

Plans your Legends of Idleon Clam Work and Scurge Works upgrades from your save. Paste your save
JSON and it runs entirely in your browser: nothing is uploaded or stored anywhere else.

## Getting your save

On [idleontoolbox.com](https://idleontoolbox.com), open the account menu (top right), click
**Copy raw data**, and paste it into the page. A Toolbox JSON export file works too.

## What it does

- **Clamworks:** the order to buy pearl upgrades to reach your next worker-class promotion as fast
  as possible. Promotion tries cost the full price and succeed 0.5 / (2 + worker class) of the
  time, so the plan targets the expected total. **Simple** mode groups the plan into a few
  check-ins.
- **Scurge Works:** where each Scurge point should go (for pearls or for Scurge EXP), a Self
  Affliction switch (it's the one upgrade you can reset), a leveling forecast, and a recommendation
  on whether to keep farming Scurge EXP or switch to pearls.
- **Your real numbers:** paste again after farming and it measures your actual pearls per hour and
  clam kills per hour from the difference. Type your in-game max damage (no crit, from AFK Info)
  and MULTI-SCALPING value once, and every character is corrected.

## Credits and license

The game formulas come from [Idleon Toolbox](https://github.com/Morta1/IdleonToolbox) by Morta1,
checked against the game's code. `core.js` is a bundle of this optimizer together with the Idleon
Toolbox parsers and game data (Toolbox commit `ac2ccff9`), so this project is licensed under the
**GNU GPL-3.0** like Idleon Toolbox. Not affiliated with Legends of Idleon or LavaFlame2.

## Building `core.js`

The optimizer's source is in `src/`. It imports the Toolbox's parsers, so it builds from a checkout
of Idleon Toolbox next to it:

```
IdleonToolbox/            (git clone https://github.com/Morta1/IdleonToolbox, then npm install)
clam-works-optimizer/     (this repo)
```

Rename the Toolbox folder to `app` (or edit the paths in `src/core.js` and `src/build-web.mjs`),
then run `node src/build-web.mjs` to write `core.js`.
