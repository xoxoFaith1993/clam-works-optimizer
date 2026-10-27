// Clam Work + Scurge Works optimizer. Game formulas come from the Toolbox's parsers (app/parsers);
// the pieces they don't export are restated here with the game function they mirror.
import '../../app/polyfills';
import { parseData } from '@parsers/index';
import {
  getClamBonus,
  getClamCost,
  getClamHp,
  getClamLevels,
  getScurgeBonus,
  getScurgeState,
  parseClamWork
} from '@parsers/world-7/clamWork';
import { getScurgeExp } from '@parsers/world-7/menagerie';
import { getClamworksMultiKill, getMaxDamage } from '@parsers/damage';
import { getDropRate, getRespawnRate } from '@parsers/character';
import { gameTables, generalSpelunky } from '@website-data';

const UPGRADES = 9;
const CLAMWORKS_MAP = 306;
// Thingies("Clam_Respawn") returns 60 but nothing uses it: clams respawn on the monster timer
// (Noble Clam: 45 s) cut by each character's respawn bonuses (game: getRespawnRate).
const CLAM_MONSTER = 'w7a6';
const BASE_RESPAWN_SECONDS = 45;
const NAMES = gameTables.clamWorkBonusNames.map((name) => name.replace(/_/g, ' '));
const PEARL_NAMES = NAMES.slice(0, UPGRADES);
const SCURGE_NAMES = NAMES.slice(UPGRADES, 2 * UPGRADES);
// game: MenagerieStuff("ScurgeUpg_LvREQ")
const SCURGE_LEVEL_REQ = gameTables.scurgeUpgradeLevelReq;
const DESCRIPTIONS = (generalSpelunky?.[27] ?? []).map((text) => String(text).replace(/_/g, ' '));
const SWARMING = 7;
const SELF_AFFLICTION = 2;

// game: Thingies("Clam_PearlUpgReq") - holding this many pearls unlocks upgrade i (nothing is spent)
const unlockReq = (workerClass, index) => (index === 0 ? 0 : 20 * Math.pow(10 + 3 * workerClass, index - 1));
// game: Clam_Cost(9) - promoting resets every pearl and Scurge upgrade, pearls and Scurge LV/EXP
const promotionCost = (workerClass) => 1e5 * Math.pow(10, workerClass);
// game: Thingies("ClamPromochance"). Every try takes the full cost first, then rolls this chance,
// so a promotion costs cost / chance pearls on average. Upgrades survive failed tries.
const promotionChance = (workerClass) => 0.5 / (2 + workerClass);
const promotionTarget = (workerClass) => promotionCost(workerClass) / promotionChance(workerClass);
// Tries needed to have succeeded with probability q.
const triesFor = (chance, q) => Math.max(1, Math.ceil(Math.log(1 - q) / Math.log(1 - chance)));
// game: MenagerieStuff("ScurgeEXP_Req")
const scurgeExpReq = (level) => (50 + 15 * level) * Math.pow(1.08, level);
// EXP still needed for the next level. A save can be written before the game rolls a full bar
// over (EXP above the requirement), so finished levels are carried over first.
const expToNextLevel = (level, exp) => {
  let lv = level;
  let left = exp;
  while (left >= scurgeExpReq(lv) && lv < level + 1000) left -= scurgeExpReq(lv++);
  return scurgeExpReq(lv) - left;
};

// ---------------------------------------------------------------- the model

// Everything that turns a state { levels, scurge: { levels, level } } into pearls and Scurge EXP.
function createModel({ workerClass, dropRate, rawDamage, multiKillAt, killWeightAt, calibration, afflictionLimit = 0,
  respawnSeconds = BASE_RESPAWN_SECONDS }) {
  const clamHp = getClamHp(workerClass);
  // SELF_AFFLICTION divides your damage on the Clamworks by 100 per level
  // (game: DamageDealed:Max, 306 == CurrentMap).
  const damageAt = (afflictionLevel) => rawDamage / Math.pow(100, afflictionLevel);
  // Pearls come mostly from AFK kills, and AFK kills do slow down once damage falls below the
  // clam's HP; SELF AFFLICTION cuts damage for everyone at the Clamworks. (Active kills with Raise
  // Dead keep up far below that, which is what the per-character limit is for, and they're measured.)
  const killSpeedAt = (afflictionLevel) => Math.min(1, damageAt(afflictionLevel) / clamHp);

  const pearlValue = (state) => {
    const { levels, scurge } = state;
    const multiKill = multiKillAt(scurge.levels[SELF_AFFLICTION] ?? 0);
    // game: Thingies("ClamPearlValue")
    return (1 + getClamBonus(levels, 0))
      * (1 + getClamBonus(levels, 3, multiKill) / 100)
      * (1 + getClamBonus(levels, 7) / 100)
      * (1 + getScurgeBonus(scurge, 1) / 100)
      * (1 + (getScurgeBonus(scurge, 8) * scurge.level) / 100);
  };

  // Pearls per kill: the map-load drop table (0.5% pearl, 0.0025% pure pearl once PURE_PEARLS is
  // bought) x your drop rate, x the 10x roll, x pearl value; pure pearls also x Clam_BlackPearlValue.
  const pearlsPerKill = (state) => {
    const { levels } = state;
    const dropMulti = (1 + getClamBonus(levels, 6) / 100) * Math.pow(0.66, workerClass) * dropRate;
    const tenX = 1 + 9 * (1 - 1 / (1 + getClamBonus(levels, 2) / 100));
    const blackPearlValue = 50 + getClamBonus(levels, 5);
    const pure = (levels[5] ?? 0) > 0 ? 25e-6 * blackPearlValue : 0;
    return dropMulti * (0.005 + pure) * tenX * pearlValue(state);
  };

  // game: Thingies("Clam_Mobs")
  const mobs = (levels) => Math.min(25, 2 + (levels[1] ?? 0));
  // Every clam respawns each 60 s, and each kill counts as one per point of multikill, for every
  // character standing at the Clamworks.
  const killsPerHour = (state) => {
    const affliction = state.scurge.levels[SELF_AFFLICTION] ?? 0;
    return mobs(state.levels) * (3600 / respawnSeconds) * killSpeedAt(affliction) * killWeightAt(affliction);
  };
  const pearlsPerHour = (state) => calibration * pearlsPerKill(state) * killsPerHour(state);

  // game: MenagerieStuff("ScurgeEXPgain"), solo (SWARMING counts other real players on the map)
  const expPerKill = (scurge) => (1 + getScurgeBonus(scurge, 0))
    * (1 + getScurgeBonus(scurge, 4) / 100)
    * (1 + getScurgeBonus(scurge, SELF_AFFLICTION) / 100);
  // game: MenagerieStuff("ScurgeStartingEXP") - each level starts this far filled
  const startingExp = (scurge) => {
    const level = scurge.levels[6] ?? 0;
    return Math.max(0, Math.min(0.8, (level / (level + 25)) * 0.75));
  };
  // EXP per kill as "levels' worth": a head start on every level is worth 1 / (1 - start).
  const effectiveExpPerKill = (scurge) => expPerKill(scurge) / (1 - startingExp(scurge));

  const cost = (state, index) => getClamCost(state.levels, index, workerClass, state.scurge);

  return {
    clamHp, respawnSeconds, damageAt, killSpeedAt, pearlValue, pearlsPerKill, pearlsPerHour, mobs, killsPerHour,
    expPerKill, startingExp, effectiveExpPerKill, cost, multiKillAt
  };
}

const cloneState = (state) => ({
  pearls: state.pearls,
  unlocked: state.unlocked,
  levels: [...state.levels],
  scurge: { level: state.scurge.level, levels: [...state.scurge.levels] }
});

// ---------------------------------------------------------------- clam (pearl) planning

// Hours until the target is reached from this state if nothing else is bought.
const hoursTo = (target, pearls, rate) => (rate > 0 ? Math.max(0, target - pearls) / rate : Infinity);

// What buying upgrade i next costs in time: wait until it's affordable (and unlocked), then pay.
function purchaseOutcome(model, state, index, workerClass) {
  // CLAM COMRADES stops at 25 clams on the map.
  if (index === 1 && model.mobs(state.levels) >= 25) return null;
  const rate = model.pearlsPerHour(state);
  const price = model.cost(state, index);
  const needed = index > state.unlocked ? Math.max(price, unlockReq(workerClass, index)) : price;
  const wait = hoursTo(needed, state.pearls, rate);
  if (!Number.isFinite(wait)) return null;
  const next = cloneState(state);
  next.pearls = Math.max(state.pearls, needed) - price;
  next.unlocked = Math.max(state.unlocked, index);
  next.levels[index] += 1;
  return { next, wait, price };
}

// Simple policy for looking ahead: buy whatever reaches the target soonest on its own, else save.
function greedyHours(model, state, target, workerClass, budget = 400) {
  let current = cloneState(state);
  let elapsed = 0;
  for (let step = 0; step < budget; step++) {
    const rate = model.pearlsPerHour(current);
    let best = { total: hoursTo(target, current.pearls, rate), outcome: null };
    for (let index = 0; index < UPGRADES; index++) {
      const outcome = purchaseOutcome(model, current, index, workerClass);
      if (!outcome) continue;
      const total = outcome.wait + hoursTo(target, outcome.next.pearls, model.pearlsPerHour(outcome.next));
      if (total < best.total) best = { total, outcome };
    }
    if (!best.outcome) return elapsed + best.total;
    elapsed += best.outcome.wait;
    current = best.outcome.next;
  }
  return elapsed + hoursTo(target, current.pearls, model.pearlsPerHour(current));
}

// The plan: before every purchase, try each upgrade (and "just save") and look ahead to the
// promotion; take whichever gets there soonest. The look-ahead is what values the discount upgrades.
export function planPearls(model, start, workerClass, maxSteps = 120) {
  const target = promotionTarget(workerClass);
  let state = cloneState(start);
  let elapsed = 0;
  const steps = [];
  const saveOnly = hoursTo(target, start.pearls, model.pearlsPerHour(start));
  for (let step = 0; step < maxSteps; step++) {
    const rate = model.pearlsPerHour(state);
    let best = { total: hoursTo(target, state.pearls, rate), index: -1, outcome: null };
    for (let index = 0; index < UPGRADES; index++) {
      const outcome = purchaseOutcome(model, state, index, workerClass);
      if (!outcome) continue;
      const total = outcome.wait + greedyHours(model, outcome.next, target, workerClass);
      if (total < best.total - 1e-9) best = { total, index, outcome };
    }
    if (!best.outcome) break;
    const { next, wait, price } = best.outcome;
    elapsed += wait;
    steps.push({
      index: best.index,
      name: PEARL_NAMES[best.index],
      fromLevel: state.levels[best.index],
      toLevel: next.levels[best.index],
      cost: price,
      waitHours: wait,
      atHours: elapsed,
      unlocks: best.index > state.unlocked,
      gainPercent: 100 * (model.pearlsPerHour(next) / rate - 1)
    });
    state = next;
  }
  const finish = hoursTo(target, state.pearls, model.pearlsPerHour(state));
  return {
    target,
    steps,
    promoteAtHours: elapsed + finish,
    saveOnlyHours: saveOnly,
    finalRate: model.pearlsPerHour(state),
    finalState: state
  };
}

// ---------------------------------------------------------------- simple (grouped) plan

// Upgrades that only make others cheaper go first within a check-in, so the rest cost less.
const DISCOUNTS = new Set([4, 8]);

// The best plan, followed in check-ins: every `everyHours` you buy, all at once and grouped by
// upgrade, whatever the best plan has lined up next that you can afford. Simulated exactly as
// you'd follow it, so the promotion time shows what the simplicity costs.
export function planSimple(model, start, workerClass, bestSteps, everyHours = 1) {
  const target = promotionTarget(workerClass);
  const queue = bestSteps.map((step) => step.index);
  let state = cloneState(start);
  let elapsed = 0;
  const checkIns = [];
  for (let visit = 0; visit < 500 && queue.length; visit++) {
    if (visit > 0) {
      const rate = model.pearlsPerHour(state);
      // Promotion may land before the next check-in.
      if (hoursTo(target, state.pearls, rate) <= everyHours) break;
      state.pearls += rate * everyHours;
      elapsed += everyHours;
    }
    // What the best plan buys next, in its order, as far as today's pearls reach.
    let budget = cloneState(state);
    let take = 0;
    while (take < queue.length) {
      const index = queue[take];
      const price = model.cost(budget, index);
      if (price > budget.pearls || index > Math.max(budget.unlocked, unlockedBy(budget.pearls, workerClass))) break;
      budget.pearls -= price;
      budget.levels[index] += 1;
      take += 1;
    }
    if (!take) continue;
    const counts = new Map();
    queue.splice(0, take).forEach((index) => counts.set(index, (counts.get(index) ?? 0) + 1));
    const order = [...counts.keys()].sort((a, b) => (DISCOUNTS.has(b) - DISCOUNTS.has(a)));
    // Buy them grouped, discounts first; anything that no longer fits waits for the next check-in.
    const buys = [];
    for (const index of order) {
      const wanted = counts.get(index);
      const from = state.levels[index];
      let spent = 0;
      let bought = 0;
      while (bought < wanted) {
        const price = model.cost(state, index);
        if (price > state.pearls) break;
        state.pearls -= price;
        state.levels[index] += 1;
        state.unlocked = Math.max(state.unlocked, index);
        spent += price;
        bought += 1;
      }
      if (bought < wanted) queue.unshift(...Array(wanted - bought).fill(index));
      if (bought) buys.push({ index, name: PEARL_NAMES[index], from, to: from + bought, count: bought, cost: spent });
    }
    if (buys.length) checkIns.push({ atHours: elapsed, buys, cost: buys.reduce((sum, buy) => sum + buy.cost, 0) });
  }
  return {
    everyHours,
    checkIns,
    promoteAtHours: elapsed + hoursTo(target, state.pearls, model.pearlsPerHour(state))
  };
}

// The highest upgrade these pearls have unlocked (holding the requirement unlocks it).
const unlockedBy = (pearls, workerClass) => {
  let index = 0;
  while (index + 1 < UPGRADES && pearls >= unlockReq(workerClass, index + 1)) index += 1;
  return index;
};

// ---------------------------------------------------------------- scurge planning

const scurgeAvailable = (scurge, index) => index !== SWARMING && scurge.level >= (SCURGE_LEVEL_REQ[index] ?? Infinity);
const scurgePointsLeft = (scurge) => scurge.level - scurge.levels.reduce((sum, level) => sum + level, 0);

// Points spent outside SELF AFFLICTION: those are permanent until the next promotion.
const permanentSpent = (scurge) => scurge.levels.reduce((sum, level, i) => (i === SELF_AFFLICTION ? sum : sum + level), 0);

// SELF AFFLICTION is the one Scurge upgrade you can hold down to reset (points back), so it's a
// switch: at your limit while farming Scurge EXP, at 0 while farming pearls. Its points are kept
// free; every other point is permanent and goes where the chosen goal ("pearls": soonest
// promotion, re-planning the pearl upgrades for each option; "exp": most Scurge levels per kill)
// gains most, judged with the switch set for that goal.
export function planScurge(model, start, workerClass, { mode = 'pearls', points = 15, maxAffliction = 0 } = {}) {
  let state = cloneState(start);
  const reserve = scurgeAvailable(state.scurge, SELF_AFFLICTION) ? maxAffliction : 0;
  state.scurge.levels[SELF_AFFLICTION] = mode === 'exp' ? reserve : 0;
  const permanentLeft = (scurge) => scurge.level - permanentSpent(scurge) - reserve;
  const picks = [];
  for (let n = 0; n < points; n++) {
    // Points come from levels: once today's are spent, the next one is the next Scurge LV.
    const future = permanentLeft(state.scurge) <= 0;
    if (future) state.scurge.level += 1;
    if (permanentLeft(state.scurge) <= 0) continue;
    let best = null;
    for (let index = 0; index < UPGRADES; index++) {
      if (index === SELF_AFFLICTION || !scurgeAvailable(state.scurge, index)) continue;
      const next = cloneState(state);
      next.scurge.levels[index] += 1;
      const score = mode === 'exp'
        ? -model.effectiveExpPerKill(next.scurge)
        : greedyHours(model, next, promotionTarget(workerClass), workerClass);
      if (!best || score < best.score - 1e-12) best = { index, score, next };
    }
    if (!best) break;
    picks.push({
      index: best.index,
      name: SCURGE_NAMES[best.index],
      atScurgeLevel: state.scurge.level,
      future,
      toLevel: best.next.scurge.levels[best.index],
      promoteHours: mode === 'exp' ? greedyHours(model, best.next, promotionTarget(workerClass), workerClass) : best.score,
      expPerKill: model.expPerKill(best.next.scurge)
    });
    state = best.next;
  }
  return { picks, reserve };
}

// The two ways to run the switch, from today's permanent points.
export function scurgeLoadouts(model, start, reserve) {
  const free = Math.max(0, start.scurge.level - permanentSpent(start.scurge));
  const at = (affliction) => {
    const state = cloneState(start);
    state.scurge.levels[SELF_AFFLICTION] = affliction;
    return {
      affliction,
      expPerKill: model.expPerKill(state.scurge),
      pearlRate: model.pearlsPerHour(state) / Math.max(1e-9, model.pearlsPerHour({ ...cloneState(start), scurge: { ...start.scurge, levels: start.scurge.levels.map((v, i) => (i === SELF_AFFLICTION ? 0 : v)) } }))
    };
  };
  return { exp: at(Math.min(reserve, free)), pearls: at(0), free, reserve };
}

// Farming Scurge EXP from now on: every level-up's point goes where it raises EXP per kill most
// (SELF AFFLICTION held at your limit), at your active kill rate. Returns the time each milestone
// takes, in hours of active farming.
const SCURGE_MILESTONES = [150, 200, 250, 300, 400, 500, 750, 1000];
export function projectScurge(model, start, { killsPerHour, affliction = 0, maxHours = 1e6, nextLevels = 5 } = {}) {
  const scurge = { level: start.scurge.level, levels: [...start.scurge.levels] };
  scurge.levels[SELF_AFFLICTION] = Math.max(scurge.levels[SELF_AFFLICTION], affliction);
  let exp = start.scurgeExp ?? 0;
  let hours = 0;
  const marks = new Set([...Array.from({ length: nextLevels }, (_, i) => start.scurge.level + 1 + i),
    ...SCURGE_MILESTONES.filter((level) => level > start.scurge.level + nextLevels)]);
  const unlocks = Object.fromEntries(SCURGE_LEVEL_REQ.map((level, index) => [level, SCURGE_NAMES[index]]).filter(([, name]) => name));
  const spend = () => {
    // One point per level; spend any unspent ones the way the EXP plan would.
    while (scurgePointsLeft(scurge) > 0) {
      let best = null;
      for (let index = 0; index < UPGRADES; index++) {
        if (index === SELF_AFFLICTION || !scurgeAvailable(scurge, index)) continue;
        scurge.levels[index] += 1;
        const value = model.effectiveExpPerKill(scurge);
        scurge.levels[index] -= 1;
        if (!best || value > best.value) best = { index, value };
      }
      if (!best) break;
      scurge.levels[best.index] += 1;
    }
  };
  const rows = [];
  spend();
  const top = Math.max(...marks);
  while (scurge.level < top && hours < maxHours) {
    const need = Math.max(0, scurgeExpReq(scurge.level) - exp);
    const perHour = model.expPerKill(scurge) * killsPerHour;
    if (!(perHour > 0)) break;
    hours += need / perHour;
    scurge.level += 1;
    // game: MenagerieStuff("ScurgeStartingEXP") - a level starts this far filled
    exp = model.startingExp(scurge) * scurgeExpReq(scurge.level);
    spend();
    if (marks.has(scurge.level)) {
      rows.push({ level: scurge.level, hours, expPerKill: model.expPerKill(scurge), unlocks: unlocks[scurge.level] ?? null });
    }
  }
  return { rows, killsPerHour, capped: scurge.level < top };
}

// Should you keep farming Scurge EXP or switch to pearls, judged by getting promoted sooner? The
// next Scurge level costs its farming time, during which pearls mostly stop (Self Affliction on);
// its point, put on the best pearl upgrade, gets the promotion that much sooner. Keep farming
// Scurge while a level pays for itself; once levels cost more than they give back, farm pearls.
export function recommend(model, pearlStart, workerClass, opts) {
  const { hoursToNextLevel, pearlRateWhileFarmingExp, pointsLeft, reserve, level, exp, killsPerHour, affliction } = opts;
  const target = promotionTarget(workerClass);
  const now = greedyHours(model, pearlStart, target, workerClass);
  const next = cloneState(pearlStart);
  next.scurge.level += 1;
  let best = null;
  for (let index = 0; index < UPGRADES; index++) {
    if (index === SELF_AFFLICTION || !scurgeAvailable(next.scurge, index)) continue;
    const tried = cloneState(next);
    tried.scurge.levels[index] += 1;
    const hours = greedyHours(model, tried, target, workerClass);
    if (!best || hours < best.hours) best = { index, hours };
  }
  const gain = best ? Math.max(0, now - best.hours) : 0;
  const paused = 1 - Math.min(1, pearlRateWhileFarmingExp ?? 0);
  const cost = hoursToNextLevel * paused;
  const farmScurge = gain > cost;

  // How long Scurge farming stays worth it: upcoming levels whose time (pearls paused) is still
  // under what a pearl-value point gives back.
  const farming = { ...pearlStart.scurge, levels: pearlStart.scurge.levels.map((v, i) => (i === SELF_AFFLICTION ? affliction : v)) };
  const perHour = model.expPerKill(farming) * killsPerHour;
  let sessionHours = 0;
  let worthLevels = 0;
  let lv = level;
  let need = expToNextLevel(level, exp);
  while (worthLevels < 500 && perHour > 0 && (need / perHour) * paused < gain) {
    sessionHours += need / perHour;
    worthLevels += 1;
    lv += 1;
    need = scurgeExpReq(lv);
  }
  // An EXP point makes every level of that session faster; the hours saved go back to pearls.
  let expPick = null;
  for (const index of [0, 4]) {
    if (!scurgeAvailable(farming, index)) continue;
    const tried = { ...farming, levels: farming.levels.map((v, i) => (i === index ? v + 1 : v)) };
    const ratio = model.effectiveExpPerKill(tried) / model.effectiveExpPerKill(farming);
    const saved = sessionHours * (1 - 1 / ratio) * paused;
    if (!expPick || saved > expPick.saved) expPick = { index, saved };
  }
  const pointsTo = farmScurge && expPick && expPick.saved > gain ? 'exp' : 'pearls';
  return {
    action: farmScurge ? 'scurge' : 'pearls',
    pointsTo,
    point: pointsTo === 'exp' ? SCURGE_NAMES[expPick.index] : best ? SCURGE_NAMES[best.index] : null,
    gainHours: gain,
    costHours: cost,
    nextLevelHours: hoursToNextLevel,
    worthLevels,
    sessionHours,
    expPointSaves: expPick?.saved ?? 0,
    pointsLeft,
    reserve
  };
}

// ---------------------------------------------------------------- measuring the real rate

// What the save says right now, for measuring income between saves.
export function snapshot(save) {
  const { account, characters } = parseSave(save);
  const scurge = getScurgeState(account);
  const farmer = pickCharacter(characters ?? [], null);
  return {
    t: save.savedAt,
    // A jump here means gear or cards changed, and income measured before it no longer applies.
    dropRate: farmer ? getDropRate(farmer, account, characters)?.dropRate ?? null : null,
    scurgeExp: getScurgeExp(account),
    pearls: account?.accountOptions?.[454] ?? 0,
    workerClass: account?.accountOptions?.[464] ?? 0,
    levels: getClamLevels(account),
    scurge: { level: scurge.level, levels: [...scurge.levels] }
  };
}

// Pearls spent going from one save's upgrade levels to the next's, buying levels one at a time at
// the prices they had (discount upgrades first, since that's how they're usually bought).
const BUY_ORDER = [4, 8, 0, 1, 2, 3, 5, 6, 7];
function spentBetween(from, to) {
  const levels = [...from.levels];
  let spent = 0;
  for (const index of BUY_ORDER) {
    while (levels[index] < (to.levels[index] ?? 0)) {
      spent += getClamCost(levels, index, to.workerClass, to.scurge);
      levels[index] += 1;
    }
  }
  return spent;
}

// Pearls earned per hour across your recent saves: (pearls now - pearls before + spent) / time.
// Gaps that include a promotion, or where levels went down, are skipped.
// The last save where the drop rate changed by more than this (a card set or gear swap), or where
// it was first recorded, starts a fresh measurement.
const DROP_RATE_CHANGE = 0.02;
const lastSetup = (history) => {
  for (let i = history.length - 1; i > 0; i--) {
    const before = history[i - 1].dropRate;
    const after = history[i].dropRate;
    if (after != null && (before == null || Math.abs(after / before - 1) > DROP_RATE_CHANGE)) return i;
  }
  return 0;
};

export function measureRate(history, { windowHours = 24 } = {}) {
  const from = lastSetup(history);
  const recent = history.slice(from).filter((point) => point.t >= history.at(-1)?.t - windowHours * 3.6e6);
  const changedAt = from > 0 ? history[from].t : null;
  let earned = 0;
  let hours = 0;
  let used = 0;
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1];
    const b = recent[i];
    if (b.workerClass !== a.workerClass || b.t <= a.t) continue;
    if (b.levels.some((level, index) => level < (a.levels[index] ?? 0))) continue;
    // SELF AFFLICTION on means farming Scurge EXP: pearl income then isn't your pearl setup.
    if ((a.scurge?.levels?.[SELF_AFFLICTION] ?? 0) > 0 || (b.scurge?.levels?.[SELF_AFFLICTION] ?? 0) > 0) continue;
    const gained = b.pearls - a.pearls + spentBetween(a, b);
    if (!(gained >= 0)) continue;
    earned += gained;
    hours += (b.t - a.t) / 3.6e6;
    used += 1;
  }
  // Before a change: what was measured then, and at what drop rate, to bridge the re-measuring.
  let before = null;
  if (from > 0 && history[from - 1].dropRate != null) {
    const earlier = measureRate(history.slice(0, from), { windowHours });
    if (earlier.hours >= MIN_MEASURED_HOURS && earlier.rate > 0) {
      before = { rate: earlier.rate, dropRate: history[from - 1].dropRate, nowDropRate: history[from].dropRate };
    }
  }
  return { rate: hours > 0 ? earned / hours : null, hours, saves: used + (used ? 1 : 0), earned, changedAt, before };
}

// game: MenagerieStuff("ScurgeEXPgain"), solo, from upgrade levels alone (for measuring kills)
const expPerKillOf = (scurge) => (1 + getScurgeBonus(scurge, 0)) * (1 + getScurgeBonus(scurge, 4) / 100)
  * (1 + getScurgeBonus(scurge, SELF_AFFLICTION) / 100);

// Active clam kills per hour, read back from Scurge EXP: every kill adds a known amount, and the
// game keeps no other count. Kills with Raise Dead and the like don't follow the respawn timer,
// so this is the only reliable number. Stretches with no kills (not actively farming) don't count.
export function measureKills(history) {
  let kills = 0;
  let hours = 0;
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (a.scurgeExp == null || b.scurgeExp == null || b.workerClass !== a.workerClass || b.t <= a.t) continue;
    const from = a.scurge?.level ?? 0;
    const to = b.scurge?.level ?? 0;
    if (to < from) continue;
    let gained = b.scurgeExp - a.scurgeExp;
    if (to > from) {
      gained = scurgeExpReq(from) - a.scurgeExp + b.scurgeExp;
      for (let level = from + 1; level < to; level++) gained += scurgeExpReq(level);
    }
    const perKill = expPerKillOf(a.scurge);
    // An upgrade changed EXP per kill (SELF AFFLICTION flipped) somewhere in between: unknown when.
    if (Math.abs(expPerKillOf(b.scurge) / perKill - 1) > 1e-9) continue;
    if (!(gained > 0) || !(perKill > 0)) continue;
    kills += gained / perKill;
    hours += (b.t - a.t) / 3.6e6;
  }
  return { killsPerHour: hours > 0 ? kills / hours : null, hours, kills };
}
const MIN_KILL_HOURS = 0.05;

// The rate is only trusted after this much measured time; shorter spans can be one big AFK claim.
const MIN_MEASURED_HOURS = 0.25;

// Reads a number the way the game prints it: "258T", "1.5Qa", "2.58e32", and the ◆ suffix (x1e18,
// as in "258T◆" or "197B◆"; type "d" if ◆ is awkward). ₸ is the game's glyph for T◆.
const GAME_SUFFIXES = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, QA: 1e15, QI: 1e18, SX: 1e21, SP: 1e24, OC: 1e27, NO: 1e30 };
export function parseGameNumber(text) {
  if (text == null || text === '') return null;
  let value = String(text).trim().replace(/,/g, '').replace(/₸/g, 'T◆');
  let scale = 1;
  if (/[◆♦d]$/i.test(value)) { scale = 1e18; value = value.slice(0, -1).trim(); }
  const match = value.match(/^([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*([a-z]{0,2})$/i);
  if (!match) return null;
  const suffix = match[2].toUpperCase();
  if (suffix && !GAME_SUFFIXES[suffix]) return null;
  const number = Number(match[1]) * (GAME_SUFFIXES[suffix] ?? 1) * scale;
  return number > 0 ? number : null;
}

// ---------------------------------------------------------------- putting it together

const pickCharacter = (characters, preferredId) => characters.find((char) => char?.playerId === preferredId)
  ?? characters.find((char) => char?.mapIndex === CLAMWORKS_MAP)
  ?? [...characters].sort((a, b) => (b?.level ?? 0) - (a?.level ?? 0))[0];

// A pasted bare save has no names: fall back to "Character 1", "Character 2"...
const charNamesOf = (save) => {
  const data = save.data ?? save;
  const count = Object.keys(data ?? {}).filter((key) => /^Lv0_\d+$/.test(key)).length;
  return Array.from({ length: count }, (_, i) => save.charNames?.[i] || `Character ${i + 1}`);
};

// Parsing a save is the slow part; option changes re-plan from the same parse.
let parsed = { key: null, value: null };
const parseSave = (save) => {
  const key = save.savedAt ?? save;
  if (parsed.key !== key) {
    parsed = {
      key,
      value: parseData(save.data ?? save, charNamesOf(save), save.companion ?? null, save.guildData ?? null, save.serverVars ?? {})
    };
  }
  return parsed.value;
};

export function analyze(save, options = {}, history = []) {
  const { account, characters } = parseSave(save);
  const workerClass = account?.accountOptions?.[464] ?? 0;
  const levels = getClamLevels(account);
  const scurge = getScurgeState(account);
  // Query strings arrive as text; player ids are numbers.
  const preferredId = options.characterId == null || options.characterId === '' ? null : Number(options.characterId);
  const character = pickCharacter(characters ?? [], preferredId);
  const playerInfo = character ? getMaxDamage(character, characters, account) : null;
  // The game files miss companions and more, so damage reads far too low, by about the same factor
  // for every character. A typed in-game max damage (AFK Info "Max Dmg Req") replaces it; otherwise
  // the account-wide factor learned from earlier readings scales the estimate.
  const typedDamage = parseGameNumber(options.damage);
  const damageFactor = Number(options.damageFactor) > 0 ? Number(options.damageFactor) : 1;
  const shownDamage = typedDamage ?? (playerInfo?.maxDamage ?? 0) * damageFactor;
  // getMaxDamage already applies the SELF_AFFLICTION cut when the character stands on the Clamworks.
  const rawDamage = character?.mapIndex === CLAMWORKS_MAP
    ? shownDamage * Math.pow(100, scurge.levels[SELF_AFFLICTION] ?? 0)
    : shownDamage;
  // What the game files alone say, for learning the factor from a reading.
  const filesRawDamage = (playerInfo?.maxDamage ?? 0)
    * (character?.mapIndex === CLAMWORKS_MAP ? Math.pow(100, scurge.levels[SELF_AFFLICTION] ?? 0) : 1);
  const clamHp = getClamHp(workerClass);
  const multiKillCache = new Map();
  const computedMultiKill = (affliction) => {
    if (!multiKillCache.has(affliction)) {
      multiKillCache.set(affliction, character
        ? getClamworksMultiKill(character, characters, account, clamHp, rawDamage / Math.pow(100, affliction))
        : 1000);
    }
    return multiKillCache.get(affliction);
  };
  const currentAffliction = scurge.levels[SELF_AFFLICTION] ?? 0;
  // The game shows MULTI-SCALPING as "Currently gives Nx", which is 1 + multikill / 1000 x Lv / 100
  // (game: ClamBonuses(3)); reading it back gives the multikill the game is using.
  const scalpingLevel = levels[3] ?? 0;
  const scalpingShown = Number(String(options.scalping ?? '').replace(/x/i, ''));
  const multiKillFromScalping = scalpingShown > 1 && scalpingLevel > 0
    ? (scalpingShown - 1) * 1e5 / (parseFloat(generalSpelunky[28]?.[3] ?? 1) * scalpingLevel) : null;
  // A remembered reading is kept as "real multikill / our estimate", so it follows MULTI-SCALPING
  // upgrades and gear changes without being typed again.
  // Per-character readings (maps by player id); characters without one use the others' average.
  const ratioMap = options.multiKillRatios && typeof options.multiKillRatios === 'object' ? options.multiKillRatios : {};
  const ratioValues = Object.values(ratioMap).map(Number).filter((v) => v > 0);
  const mapRatio = character && Number(ratioMap[character.playerId]) > 0 ? Number(ratioMap[character.playerId])
    : ratioValues.length ? ratioValues.reduce((a, b) => a + b, 0) / ratioValues.length : null;
  const multiKillRatio = Number(options.multiKillRatio) > 0 ? Number(options.multiKillRatio) : mapRatio;
  const multiKillRatioOwn = !!(character && Number(ratioMap[character.playerId]) > 0) || Number(options.multiKillRatio) > 0;
  const multiKillOverride = multiKillFromScalping
    ?? (multiKillRatio ? computedMultiKill(currentAffliction) * multiKillRatio : null)
    ?? (Number(options.multiKill) > 0 ? Number(options.multiKill) : null);
  // An override replaces today's multikill; other affliction levels keep their ratio to it.
  const multiKillAt = (affliction) => (multiKillOverride
    ? multiKillOverride * computedMultiKill(affliction) / Math.max(1, computedMultiKill(currentAffliction))
    : computedMultiKill(affliction));
  const dropRate = character ? (getDropRate(character, account, characters)?.dropRate ?? 1) : 1;
  // Seconds between a clam dying and coming back, for this character (as if fighting clams).
  const respawnSeconds = character
    ? getRespawnRate({ ...character, targetMonster: CLAM_MONSTER }, account)?.respawnRate || BASE_RESPAWN_SECONDS
    : BASE_RESPAWN_SECONDS;
  // Everyone standing at the Clamworks kills clams; each counts with their own multikill.
  const farmers = (characters ?? []).filter((char) => char?.mapIndex === CLAMWORKS_MAP);
  const others = farmers.filter((char) => char !== character).map((char) => {
    const info = getMaxDamage(char, characters, account);
    return { char, raw: (info?.maxDamage ?? 0) * Math.pow(100, scurge.levels[SELF_AFFLICTION] ?? 0) };
  });
  const killWeightCache = new Map();
  const killWeightAt = (affliction) => {
    if (!killWeightCache.has(affliction)) {
      const own = multiKillAt(affliction);
      const rest = others.reduce((sum, { char, raw }) => sum
        + getClamworksMultiKill(char, characters, account, clamHp, raw / Math.pow(100, affliction)), 0);
      killWeightCache.set(affliction, own + rest);
    }
    return killWeightCache.get(affliction);
  };

  // The highest SELF AFFLICTION you can keep up with, from your own testing; otherwise what you run now.
  const limitMap = options.afflictionLimits && typeof options.afflictionLimits === 'object' ? options.afflictionLimits : {};
  const limitOption = options.maxAffliction ?? (character ? limitMap[character.playerId] : undefined);
  const typedLimit = limitOption === '' || limitOption == null ? NaN : Number(limitOption);
  const afflictionLimit = Number.isFinite(typedLimit) && typedLimit >= 0 ? typedLimit : currentAffliction;

  const start = {
    pearls: account?.accountOptions?.[454] ?? 0,
    unlocked: account?.accountOptions?.[465] ?? 0,
    levels,
    scurge: { level: scurge.level, levels: [...scurge.levels] }
  };
  const uncalibrated = createModel({ workerClass, dropRate, rawDamage, multiKillAt, killWeightAt, calibration: 1, afflictionLimit, respawnSeconds });
  // Pearls are planned with SELF AFFLICTION off (held to reset): that's how you farm them.
  const pearlStart = { ...cloneState(start), scurge: { ...start.scurge, levels: start.scurge.levels.map((v, i) => (i === SELF_AFFLICTION ? 0 : v)) } };
  const estimatedRate = uncalibrated.pearlsPerHour(pearlStart);
  // Your own number wins, then the measured rate, then the estimate.
  const measured = measureRate(history.filter((point) => point.workerClass === workerClass));
  const measuredRate = measured.hours >= MIN_MEASURED_HOURS && measured.rate > 0 ? measured.rate : null;
  const typedRate = Number(options.pearlsPerHour) > 0 ? Number(options.pearlsPerHour) : null;
  // Right after a gear or card swap: the old measured rate, scaled by how much drop rate changed.
  const carriedRate = !measuredRate && measured.before
    ? measured.before.rate * measured.before.nowDropRate / measured.before.dropRate : null;
  const rateSource = typedRate ? 'typed' : measuredRate ? 'measured' : carriedRate ? 'carried' : 'estimate';
  const usedRate = typedRate ?? measuredRate ?? carriedRate;
  const calibration = usedRate ? usedRate / estimatedRate : 1;
  const model = createModel({ workerClass, dropRate, rawDamage, multiKillAt, killWeightAt, calibration, afflictionLimit, respawnSeconds });

  // SELF_AFFLICTION: what each level does to damage, multikill, Scurge EXP and pearls.
  const afflictionTable = Array.from({ length: 7 }, (_, level) => ({
    level,
    damage: model.damageAt(level),
    withinLimit: level <= afflictionLimit,
    multiKill: multiKillAt(level),
    expMulti: 1 + 2 * level,
    pearlRateVsNow: model.pearlsPerHour({ ...start, scurge: { ...start.scurge, levels: start.scurge.levels.map((v, i) => (i === SELF_AFFLICTION ? level : v)) } })
      / model.pearlsPerHour(pearlStart)
  }));
  const maxAffliction = afflictionLimit;

  const pearlPlan = planPearls(model, pearlStart, workerClass, Number(options.steps) || 120);
  const simpleEvery = [0.5, 1, 3, 8].includes(Number(options.simpleEvery)) ? Number(options.simpleEvery) : 1;
  const simplePlan = planSimple(model, pearlStart, workerClass, pearlPlan.steps, simpleEvery);
  const scurgeMode = options.scurgeMode === 'exp' ? 'exp' : 'pearls';
  const { picks: scurgePlan, reserve: afflictionReserve } = planScurge(model, start, workerClass,
    { mode: scurgeMode, points: Number(options.points) || 15, maxAffliction });
  const loadouts = scurgeLoadouts(model, start, afflictionReserve);

  // The game's own descriptions with their numbers filled in.
  const described = parseClamWork(account, null, multiKillAt(currentAffliction));
  const chance = promotionChance(workerClass);

  const measuredKills = measureKills(history.filter((point) => point.workerClass === workerClass));
  const activeKillsPerHour = measuredKills.hours >= MIN_KILL_HOURS && measuredKills.killsPerHour > 0
    ? measuredKills.killsPerHour
    : model.mobs(levels) * 3600 / respawnSeconds;

  const forecast = projectScurge(model, { ...start, scurgeExp: getScurgeExp(account) },
    { killsPerHour: activeKillsPerHour, affliction: afflictionReserve });

  const level = scurge.level;
  const exp = getScurgeExp(account);
  const expPerKillFarming = model.expPerKill({ ...start.scurge, levels: start.scurge.levels.map((v, i) => (i === SELF_AFFLICTION ? Math.max(v, afflictionReserve) : v)) });
  const recommendation = scurgeAvailable(start.scurge, 0) ? recommend(model, pearlStart, workerClass, {
    hoursToNextLevel: expToNextLevel(level, exp) / Math.max(1e-9, expPerKillFarming * activeKillsPerHour),
    level,
    exp,
    expPerKillFarming,
    killsPerHour: activeKillsPerHour,
    affliction: afflictionReserve,
    pearlRateWhileFarmingExp: loadouts.exp.pearlRate,
    pointsLeft: Math.max(0, loadouts.free - afflictionReserve),
    reserve: afflictionReserve
  }) : null;
  const expReq = scurgeExpReq(level);
  return {
    savedAt: save.savedAt ?? null,
    characters: (characters ?? []).map((char) => ({ id: char.playerId, name: char.name, atClamworks: char.mapIndex === CLAMWORKS_MAP })),
    character: character ? { id: character.playerId, name: character.name, atClamworks: character.mapIndex === CLAMWORKS_MAP } : null,
    workerClass,
    promotionCost: promotionCost(workerClass),
    promotion: {
      cost: promotionCost(workerClass),
      chance,
      expectedPearls: promotionTarget(workerClass),
      expectedTries: 1 / chance,
      medianTries: triesFor(chance, 0.5),
      unluckyTries: triesFor(chance, 0.9)
    },
    clamHp,
    damage: rawDamage,
    dropRate,
    multiKill: multiKillAt(currentAffliction),
    multiKillSource: multiKillFromScalping ? 'typed' : multiKillRatio ? (multiKillRatioOwn ? 'reading' : 'learned') : 'estimate',
    damageSource: typedDamage ? 'typed' : damageFactor !== 1 ? 'learned' : 'estimate',
    filesRawDamage,
    damageFactor,
    scalping: {
      level: scalpingLevel,
      perLevel: parseFloat(generalSpelunky[28]?.[3] ?? 1),
      // What the game should show as "Currently gives Nx" with this multikill.
      shown: 1 + (multiKillAt(currentAffliction) / 1000) * parseFloat(generalSpelunky[28]?.[3] ?? 1) * scalpingLevel / 100
    },
    computedMultiKill: computedMultiKill(currentAffliction),
    rateSource,
    measured: { ...measured, minHours: MIN_MEASURED_HOURS, trusted: !!measuredRate },
    farmers: farmers.map((char) => char.name),
    estimatedPearlsPerHour: estimatedRate,
    pearlsPerHour: model.pearlsPerHour(pearlStart),
    afflictionOn: currentAffliction > 0,
    pearls: start.pearls,
    mobs: model.mobs(levels),
    respawnSeconds,
    // Clams killed per hour of active play: measured from Scurge EXP when there's enough, else
    // every clam as soon as it respawns.
    activeKillsPerHour,
    activeKillsSource: measuredKills.hours >= MIN_KILL_HOURS && measuredKills.killsPerHour > 0 ? 'measured' : 'respawn',
    measuredKills,
    pearlValue: model.pearlValue(pearlStart),
    upgrades: PEARL_NAMES.map((name, index) => ({
      index,
      name,
      description: described?.upgrades?.[index]?.description?.replace(/_/g, ' ') ?? DESCRIPTIONS[index],
      maxed: index === 1 && model.mobs(levels) >= 25,
      level: levels[index],
      cost: model.cost(start, index),
      unlocked: index <= start.unlocked,
      unlockAt: unlockReq(workerClass, index)
    })),
    pearlPlan: { ...pearlPlan, finalState: undefined },
    simplePlan,
    scurge: {
      level,
      exp,
      expReq,
      pointsLeft: scurgePointsLeft(start.scurge),
      expPerKill: model.expPerKill(start.scurge),
      startingExp: model.startingExp(start.scurge),
      expToNextLevel: expToNextLevel(level, exp),
      killsToNextLevel: Math.ceil(expToNextLevel(level, exp) / Math.max(1e-9, model.expPerKill(start.scurge))),
      hoursToNextLevel: expToNextLevel(level, exp) / Math.max(1e-9, model.expPerKill(start.scurge)) / Math.max(1e-9, activeKillsPerHour),
      upgrades: SCURGE_NAMES.map((name, index) => ({
        index,
        name,
        description: described?.scurge?.upgrades?.[index]?.description?.replace(/_/g, ' ') ?? DESCRIPTIONS[index + UPGRADES],
        level: scurge.levels[index] ?? 0,
        levelReq: SCURGE_LEVEL_REQ[index],
        unlocked: scurge.level >= SCURGE_LEVEL_REQ[index],
        soloUseless: index === SWARMING
      })),
      mode: scurgeMode,
      plan: scurgePlan,
      afflictionTable,
      maxAffliction,
      loadouts,
      forecast,
      recommendation,
      // Unspent points that aren't being kept for the SELF AFFLICTION switch.
      permanentPointsLeft: Math.max(0, loadouts.free - afflictionReserve),
      limitFromYou: Number.isFinite(typedLimit) && typedLimit >= 0
    }
  };
}

// ---------------------------------------------------------------- readings (calibration)

const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

// Turns one typed reading into stored calibration. Damage readings are kept per character as
// "in game / game files" and averaged into one account-wide factor; MULTI-SCALPING readings are
// kept as "real multikill / estimate", re-anchored whenever the damage factor moves.
export function calibrate(save, history, cal, { type, characterId, value }) {
  const id = Number(characterId);
  const next = { damageReadings: {}, multiKillRatios: {}, afflictionLimits: {}, ...cal };
  const run = (c, extra = {}) => analyze(save, { ...c, characterId: id, ...extra }, history);
  if (type === 'limit') {
    if (value === '' || value == null) delete next.afflictionLimits[id];
    else next.afflictionLimits = { ...next.afflictionLimits, [id]: Math.max(0, Math.round(Number(value))) };
  } else if (type === 'scalping') {
    if (value === '' || value == null) delete next.multiKillRatios[id];
    else {
      const a = run(next);
      const shown = parseFloat(String(value).replace(/x/i, ''));
      if (shown > 1 && a.scalping.level > 0 && a.computedMultiKill > 0) {
        const multiKill = (shown - 1) * 1e5 / (a.scalping.perLevel * a.scalping.level);
        next.multiKillRatios = { ...next.multiKillRatios, [id]: multiKill / a.computedMultiKill };
      }
    }
  } else if (type === 'damage') {
    // Every character's multikill in use now, to keep it after the factor changes.
    const before = Object.keys(next.multiKillRatios).map((key) => [key, run(next, { characterId: Number(key) }).multiKill]);
    if (value === '' || value == null) delete next.damageReadings[id];
    else {
      const typed = run({ ...next, damageFactor: 1 }, { damage: value });
      const files = typed.filesRawDamage;
      if (typed.damage > 0 && files > 0) next.damageReadings = { ...next.damageReadings, [id]: typed.damage / files };
    }
    next.damageFactor = average(Object.values(next.damageReadings).map(Number).filter((v) => v > 0));
    for (const [key, multiKill] of before) {
      const after = analyze(save, { ...next, characterId: Number(key), multiKillRatios: {} }, history);
      if (after.computedMultiKill > 0) next.multiKillRatios[key] = multiKill / after.computedMultiKill;
    }
  }
  return next;
}
