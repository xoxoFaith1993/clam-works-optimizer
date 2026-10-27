// Browser entry: the same optimizer, run on a pasted save instead of the game files.
import { analyze, calibrate, measureKills, measureRate, snapshot } from './core.js';

window.ClamCore = { analyze, calibrate, measureKills, measureRate, snapshot };
