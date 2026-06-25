"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Briefcase, Dumbbell, Battery, ShoppingBag, Settings, Play, Pause,
  Moon, Coffee, Utensils, Droplets, Wind, Sparkles, BedDouble,
  Monitor, Zap, Brain, Rocket, Download, Upload, Save,
  ChevronRight, Flame, TrendingUp, Clock, Star, Trophy,
  Crown, Sun, Users, PenLine, Snowflake, Apple, Dice5,
  LucideIcon,
} from "lucide-react";

// ─── System Overview ─────────────────────────────────────────────────────────
// OFFLINE PROGRESS APPROACH:
//   When work starts → save a full "work checkpoint" (state snapshot + timestamp).
//   When work stops  → clear the checkpoint.
//   On page reload   → if checkpoint exists, simulate elapsed seconds from
//                      checkpoint.timestamp to now using checkpoint.state as
//                      the starting point. No double-counting possible because
//                      the tick loop only ever runs from the current in-memory
//                      state, and the checkpoint is the authoritative "what was
//                      the world when work began this session".
//   The tick loop itself never writes to the checkpoint — it just mutates
//   in-memory state per tick. Auto-save writes the current state separately.

// ─── Constants ───────────────────────────────────────────────────────────────
const TICK_MS: number = 250;
const MAX_SHIFT_SECS: number = 5400; // 1.5 hrs
const MANA_DRAIN_PER_SEC: number = 90 / 5400;
const ENERGY_DECAY_PER_SEC: number = 100 / (6 * 3600);
const MULTIPLIER_DECAY_PER_SEC: number = 100 / 57600;
const SHIFT_COMPLETION_BONUS: number = 500;
const BASE_INCOME_PER_SEC: number = 1.0;
const SAVE_KEY = "idleWorker_v5";
const CHECKPOINT_KEY = "idleWorker_v5_checkpoint";

// ─── Types ───────────────────────────────────────────────────────────────────
interface GambleOutcome {
  label: string;
  emoji: string;
  mult: number;
  chance: number;
  color: string;
  rare?: boolean;
}

interface PendingGamble {
  baseBonus: number;
}

interface LogEntry {
  id: number;
  text: string;
  color: string;
}

interface TitleDef {
  hours: number;
  label: string;
  color: string;
}

interface UpgradeDef {
  name: string;
  desc: string;
  icon: LucideIcon;
  color: string;
  baseCost: number;
  costScale: number;
  effect: (level: number) => string;
}

interface RecoveryCategory {
  id: string;
  label: string;
  icon: LucideIcon;
  color: string;
}

interface RecoveryAction {
  id: string;
  name: string;
  icon: LucideIcon;
  color: string;
  category: string;
  duration: number;
  realTime: string;
  currencyCost?: number;
  desc: string;
  effect: string;
  canDo: (s: GameState) => boolean;
  apply: (s: GameState) => Partial<GameState>;
  log: string;
  logColor: string;
  freezesMultiplier?: boolean;
}

interface GameState {
  currency: number;
  mana: number;
  maxMana: number;
  energy: number;
  maxEnergy: number;
  multiplier: number;
  workSeconds: number;
  isWorking: boolean;
  workProgress: number;
  totalWorkSeconds: number;
  completedCycles: number;
  // upgrades
  ergonomicDesk: number;
  incomePerSecond: number;
  espressoMachine: number;
  deepFocusGuide: number;
  automationSpeed: number;
  lunchBox: number;
  waterBottle: number;
  // recovery
  activeRecovery: string | null;
  recoveryProgress: number;
  recoveryMax: number;
  // gambling
  pendingGamble: PendingGamble | null;
  // transient flags (never persisted intentionally)
  _stopWork?: boolean;
  _energyWarn?: boolean;
  _warnedEnergy?: boolean;
  _levelUp?: number;
}

// Checkpoint: saved when work starts, cleared when work stops/pauses.
// On reload, if this exists, we fast-forward from checkpoint.state
// for (now - checkpoint.timestamp) seconds.
interface WorkCheckpoint {
  state: GameState;
  timestamp: number; // ms since epoch when work began
}

interface ProgressBarProps {
  value: number;
  max: number;
  color: string;
  label: string;
  sublabel?: string;
  icon?: LucideIcon;
  height?: number;
  warn?: boolean;
}

interface GamblingModalProps {
  pending: PendingGamble;
  onResult: (finalBonus: number, outcome: GambleOutcome) => void;
  addLog: (text: string, color?: string) => void;
}

type UpgradeKey = "ergonomicDesk" | "incomePerSecond" | "espressoMachine" | "deepFocusGuide" | "automationSpeed" | "lunchBox" | "waterBottle";

// ─── Gambling Outcomes ───────────────────────────────────────────────────────
const GAMBLE_OUTCOMES: GambleOutcome[] = [
  { label: "JACKPOT", emoji: "💎", mult: 10,  chance: 0.02, color: "#fbbf24", rare: true },
  { label: "BIG WIN", emoji: "🔥", mult: 3,   chance: 0.08, color: "#f472b6" },
  { label: "NICE",    emoji: "✨", mult: 2,   chance: 0.20, color: "#a78bfa" },
  { label: "OKAY",    emoji: "👍", mult: 1.5, chance: 0.30, color: "#34d399" },
  { label: "BASE",    emoji: "💼", mult: 1,   chance: 0.40, color: "#64748b" },
];

function rollGamble(): GambleOutcome {
  const r = Math.random();
  let cum = 0;
  for (const o of GAMBLE_OUTCOMES) {
    cum += o.chance;
    if (r < cum) return o;
  }
  return GAMBLE_OUTCOMES[GAMBLE_OUTCOMES.length - 1];
}

// ─── Level helpers ────────────────────────────────────────────────────────────
function hoursToReachLevel(level: number): number { return Math.pow(level - 1, 2); }
function secsToReachLevel(level: number): number   { return hoursToReachLevel(level) * 3600; }
function levelFromSecs(totalSecs: number): number  { return Math.floor(Math.sqrt(totalSecs / 3600)) + 1; }
function levelProgressInSecs(level: number, totalSecs: number): { done: number; needed: number; startHrs: number; endHrs: number } {
  const startSecs = secsToReachLevel(level);
  const endSecs   = secsToReachLevel(level + 1);
  return { done: totalSecs - startSecs, needed: endSecs - startSecs, startHrs: hoursToReachLevel(level), endHrs: hoursToReachLevel(level + 1) };
}
function levelIncomeMultiplier(level: number): number { return level; }

// ─── Title System ─────────────────────────────────────────────────────────────
const TITLES: TitleDef[] = [
  { hours: 0,     label: "Novice",                      color: "#64748b" },
  { hours: 20,    label: "The Learner",                 color: "#60a5fa" },
  { hours: 100,   label: "The Proficient Practitioner", color: "#34d399" },
  { hours: 1000,  label: "The Expert",                  color: "#a78bfa" },
  { hours: 10000, label: "The Elite Expert",            color: "#fbbf24" },
  { hours: 15000, label: "The Greatest of This Time",   color: "#f472b6" },
  { hours: 20000, label: "The Greatest of All Time",    color: "#f97316" },
  { hours: 30000, label: "The Human Ceiling",           color: "#ffffff" },
];
function getTitleForHours(h: number): TitleDef {
  let t: TitleDef = TITLES[0];
  for (const x of TITLES) { if (h >= x.hours) t = x; else break; }
  return t;
}
function getNextTitle(h: number): TitleDef | null {
  for (const t of TITLES) { if (h < t.hours) return t; }
  return null;
}

// ─── Design Tokens ────────────────────────────────────────────────────────────
const P = {
  bg: "#0d0f14", surface: "#13161e", card: "#191d28", border: "#252a3a",
  accent: "#6c63ff", green: "#34d399", yellow: "#fbbf24", red: "#f87171",
  blue: "#60a5fa", purple: "#a78bfa", pink: "#f472b6", cyan: "#22d3ee",
  orange: "#fb923c", text: "#e2e8f0", muted: "#64748b", mana: "#818cf8",
} as const;

const F = {
  display: "'Space Grotesk','Segoe UI',sans-serif",
  body: "'Inter','Helvetica Neue',sans-serif",
  mono: "'JetBrains Mono','Fira Code',monospace",
} as const;

// ─── Upgrade Definitions ──────────────────────────────────────────────────────
const UPGRADES: Record<UpgradeKey, UpgradeDef> = {
  ergonomicDesk:   { name: "Ergonomic Desk",     desc: "Boosts shift completion bonus",              icon: Monitor, color: P.blue,   baseCost: 80,  costScale: 1.7, effect: (l) => `+$${l*100} per shift bonus` },
  incomePerSecond: { name: "Mechanical Keyboard", desc: "Increases base currency per second",         icon: Zap,     color: P.yellow, baseCost: 50,  costScale: 1.5, effect: (l) => `+$${(l*0.5).toFixed(1)}/sec base` },
  espressoMachine: { name: "Espresso Machine",    desc: "Reduces mana drain while working",           icon: Coffee,  color: P.pink,   baseCost: 120, costScale: 1.8, effect: (l) => `-${Math.min(l*10,60)}% mana drain` },
  deepFocusGuide:  { name: "Deep Focus Guide",    desc: "Slows productivity multiplier decay",        icon: Brain,   color: P.purple, baseCost: 200, costScale: 2.0, effect: (l) => `-${Math.min(l*10,60)}% decay rate` },
  automationSpeed: { name: "Turbo Workflow",      desc: "Increases per-second income while working",  icon: Rocket,  color: P.green,  baseCost: 150, costScale: 1.9, effect: (l) => `+${(l*0.25).toFixed(2)}x income speed` },
  lunchBox:        { name: "Insulated Lunchbox",  desc: "Slows energy decay — hunger drains slower",  icon: Utensils,color: P.orange, baseCost: 90,  costScale: 1.6, effect: (l) => `-${Math.min(l*10,50)}% energy decay` },
  waterBottle:     { name: "Hydration Bottle",    desc: "Each water drink restores extra energy",     icon: Droplets,color: P.cyan,   baseCost: 60,  costScale: 1.5, effect: (l) => `+${l*3} energy per drink` },
};

function upgradeCost(base: number, scale: number, lvl: number): number {
  return Math.floor(base * Math.pow(scale, lvl));
}

// ─── Recovery Categories ──────────────────────────────────────────────────────
const RECOVERY_CATEGORIES: RecoveryCategory[] = [
  { id: "nutrition", label: "Nutrition", icon: Apple,     color: P.green  },
  { id: "rest",      label: "Rest",      icon: Moon,      color: P.purple },
  { id: "hygiene",   label: "Hygiene",   icon: Wind,      color: P.cyan   },
  { id: "movement",  label: "Movement",  icon: Dumbbell,  color: P.red    },
  { id: "mind",      label: "Mind",      icon: Brain,     color: P.pink   },
  { id: "sleep",     label: "Sleep",     icon: BedDouble, color: P.accent },
];

// ─── Recovery Actions ─────────────────────────────────────────────────────────
const RECOVERY_ACTIONS: RecoveryAction[] = [
  // Nutrition
  {
    id: "drinkWater", name: "Drink Water", icon: Droplets, color: P.blue, category: "nutrition",
    duration: 60*2, realTime: "~2 min",
    desc: "Hydration check. Mild dehydration measurably hurts focus — a glass of water is the cheapest fix. Restores a small amount of energy.",
    effect: "Energy +6, Mana +3",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+3, s.maxMana), energy: Math.min(s.energy + 6 + (s.waterBottle||0)*3, s.maxEnergy) }),
    log: "Hydrated! Staying ahead of the drain.", logColor: P.blue,
  },
  {
    id: "healthySnack", name: "Healthy Snack", icon: Apple, color: P.green, category: "nutrition",
    duration: 60*8, realTime: "8 min", currencyCost: 8,
    desc: "A quick, real bite — fruit, nuts, something with nutrients. Steadies blood sugar. Good energy boost.",
    effect: "Energy +22, Mana +5 (costs $8)",
    canDo: (s: GameState) => s.currency >= 8,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+5, s.maxMana), energy: Math.min(s.energy+22, s.maxEnergy), currency: s.currency-8 }),
    log: "Snacked smart. Energy climbing.", logColor: P.green,
  },
  {
    id: "healthyMeal", name: "Healthy Meal", icon: Utensils, color: P.green, category: "nutrition",
    duration: 60*25, realTime: "25 min", currencyCost: 30,
    desc: "A full, balanced meal. This is the king of energy restoration — nothing else comes close for raw energy gain. Your body needs real food.",
    effect: "Energy +55, Mana +14 (costs $30) ★ HIGHEST ENERGY",
    canDo: (s: GameState) => s.currency >= 30,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+14, s.maxMana), energy: Math.min(s.energy+55, s.maxEnergy), currency: s.currency-30 }),
    log: "Ate a real meal. Energy surges — this is what the body needed!", logColor: P.green,
  },
  {
    id: "bigMeal", name: "Big Nutritious Meal", icon: Utensils, color: "#22c55e", category: "nutrition",
    duration: 60*40, realTime: "40 min", currencyCost: 60,
    desc: "A large, nutrient-dense meal cooked properly. Maximum energy restoration possible from food alone. Worth every cent.",
    effect: "Energy +80, Mana +20 (costs $60) ★★ MAXIMUM ENERGY",
    canDo: (s: GameState) => s.currency >= 60,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+20, s.maxMana), energy: Math.min(s.energy+80, s.maxEnergy), currency: s.currency-60 }),
    log: "FULLY FED. Energy at peak. You feel unstoppable.", logColor: "#22c55e",
  },
  // Rest
  {
    id: "shortNap", name: "Power Nap", icon: Moon, color: P.purple, category: "rest",
    duration: 60*20, realTime: "20 min",
    desc: "The 10-20 min sweet spot. Mostly a physical reset — energy-led, doesn't restore energy as well as food does.",
    effect: "Energy +18, Mana +16",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+16, s.maxMana), energy: Math.min(s.energy+18, s.maxEnergy) }),
    log: "Power nap done. Alertness restored, no grogginess.", logColor: P.purple,
  },
  {
    id: "meditation", name: "Mindful Meditation", icon: Sparkles, color: P.blue, category: "rest",
    duration: 60*20, realTime: "20 min",
    desc: "NSDR: parasympathetic activation — almost entirely a mental reset. Freezes productivity decay.",
    effect: "Energy +4, Mana +48 (freezes decay)",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+48, s.maxMana), energy: Math.min(s.energy+4, s.maxEnergy) }),
    log: "Meditation complete. Mind clear.", logColor: P.blue,
    freezesMultiplier: true,
  },
  {
    id: "nsdr", name: "Non-Sleep Deep Rest", icon: Sparkles, color: P.blue, category: "rest",
    duration: 60*20, realTime: "20 min",
    desc: "Yoga nidra / guided body-scan. Calms the nervous system, almost pure Mana. Freezes decay.",
    effect: "Energy +4, Mana +48 (freezes decay)",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+48, s.maxMana), energy: Math.min(s.energy+4, s.maxEnergy) }),
    log: "Non-Sleep Deep Rest complete. Mind clear.", logColor: P.blue,
    freezesMultiplier: true,
  },
  // Hygiene
  {
    id: "skincare", name: "Face Skincare", icon: Star, color: P.pink, category: "hygiene",
    duration: 60*10, realTime: "10 min",
    desc: "Small ritual, small balanced lift.",
    effect: "Energy +9, Mana +9",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+9, s.maxMana), energy: Math.min(s.energy+9, s.maxEnergy) }),
    log: "Skin glowing. Feel radiant.", logColor: P.pink,
  },
  {
    id: "hygiene", name: "Shower", icon: Wind, color: P.green, category: "hygiene",
    duration: 60*20, realTime: "20 min",
    desc: "Fresh and clean. A bigger physical reset than mental one.",
    effect: "Energy +22, Mana +12",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+12, s.maxMana), energy: Math.min(s.energy+22, s.maxEnergy) }),
    log: "Showered up. Mental clarity restored!", logColor: P.green,
  },
  {
    id: "coldShower", name: "Cold Finish", icon: Snowflake, color: P.cyan, category: "hygiene",
    duration: 60*5, realTime: "5 min",
    desc: "A short cold-water finish — the norepinephrine spike behind why it jolts you awake.",
    effect: "Energy +14, Mana +6",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+6, s.maxMana), energy: Math.min(s.energy+14, s.maxEnergy) }),
    log: "Cold finish done. Wide awake.", logColor: P.cyan,
  },
  {
    id: "grooming", name: "Grooming", icon: Wind, color: P.green, category: "hygiene",
    duration: 60*15, realTime: "15 min",
    desc: "Shave, trim, tidy up. Lighter than a full shower, still a genuine refresh.",
    effect: "Energy +14, Mana +10",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+10, s.maxMana), energy: Math.min(s.energy+14, s.maxEnergy) }),
    log: "Groomed up. Feeling fresh.", logColor: P.green,
  },
  // Movement
  {
    id: "exercise", name: "Exercise", icon: Dumbbell, color: P.red, category: "movement",
    duration: 60*60, realTime: "60 min",
    desc: "A real bout of cardio or strength. Strong mana via mood/anxiety reduction. Note: uses some energy but gives a net gain.",
    effect: "Energy +20, Mana +30",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+30, s.maxMana), energy: Math.min(s.energy+20, s.maxEnergy) }),
    log: "Workout complete. Feeling strong and clear-headed!", logColor: P.red,
  },
  {
    id: "outdoorWalk", name: "Sunlight Walk", icon: Sun, color: P.orange, category: "movement",
    duration: 60*15, realTime: "15 min",
    desc: "A short walk outside. Daylight exposure anchors your circadian rhythm and reliably lifts mood.",
    effect: "Energy +15, Mana +16",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+16, s.maxMana), energy: Math.min(s.energy+15, s.maxEnergy) }),
    log: "Walked it off. Body and mind both lighter.", logColor: P.orange,
  },
  // Mind
  {
    id: "socialConnection", name: "Talk to Someone", icon: Users, color: P.pink, category: "mind",
    duration: 60*20, realTime: "20 min",
    desc: "Real conversation. Social connection — almost all the benefit lands on mood, not the body.",
    effect: "Energy +6, Mana +26",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+26, s.maxMana), energy: Math.min(s.energy+6, s.maxEnergy) }),
    log: "Good talk. Feeling a lot less alone in this.", logColor: P.pink,
  },
  {
    id: "journaling", name: "Journaling", icon: PenLine, color: P.purple, category: "mind",
    duration: 60*10, realTime: "10 min",
    desc: "Write down what's on your mind. Cognitive offloading eases mental load.",
    effect: "Energy +3, Mana +15",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: Math.min(s.mana+15, s.maxMana), energy: Math.min(s.energy+3, s.maxEnergy) }),
    log: "Got it out of your head. Mind feels lighter.", logColor: P.purple,
  },
  // Sleep
  {
    id: "sleep", name: "Sleep (Full Night)", icon: BedDouble, color: P.accent, category: "sleep",
    duration: 480, realTime: "8 hrs",
    desc: "Full night's sleep. The only full reset — nothing else comes close.",
    effect: "Mana FULL, Energy FULL, Productivity 100%",
    canDo: (_s: GameState) => true,
    apply: (s: GameState) => ({ mana: s.maxMana, energy: s.maxEnergy, multiplier: 100 }),
    log: "You slept 8 hours. Everything fully restored. Let's crush it!", logColor: P.accent,
  },
];

// ─── Initial State ────────────────────────────────────────────────────────────
const INITIAL_STATE: GameState = {
  currency: 10,
  mana: 100, maxMana: 100,
  energy: 80, maxEnergy: 100,
  multiplier: 100,
  workSeconds: 0,
  isWorking: false,
  workProgress: 0,
  totalWorkSeconds: 0,
  completedCycles: 0,
  ergonomicDesk: 0, incomePerSecond: 0, espressoMachine: 0,
  deepFocusGuide: 0, automationSpeed: 0, lunchBox: 0, waterBottle: 0,
  activeRecovery: null, recoveryProgress: 0, recoveryMax: 0,
  pendingGamble: null,
};

// ─── Persistence Helpers ──────────────────────────────────────────────────────
function encodeState(s: GameState): string {
  // Strip transient flags before saving
  const { _stopWork, _energyWarn, _warnedEnergy, _levelUp, ...clean } = s;
  return btoa(JSON.stringify(clean));
}

function decodeState(str: string): GameState | null {
  try { return JSON.parse(atob(str)) as GameState; } catch { return null; }
}

function saveCheckpoint(state: GameState): void {
  try {
    const cp: WorkCheckpoint = { state, timestamp: Date.now() };
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(cp));
  } catch { /* ignore */ }
}

function clearCheckpoint(): void {
  try { localStorage.removeItem(CHECKPOINT_KEY); } catch { /* ignore */ }
}

function loadCheckpoint(): WorkCheckpoint | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WorkCheckpoint;
  } catch { return null; }
}

// ─── Core Simulation: advance N seconds from a starting state ────────────────
// This is the single source of truth for "what happens per second".
// Used both by the tick loop (dt = 0.25s) and offline catch-up (dt = 1s each).
function simulateSeconds(
  s: GameState,
  seconds: number,
  onShiftComplete?: (baseBonus: number) => void,
): GameState {
  const drainReduction = Math.min((s.espressoMachine || 0) * 0.10, 0.60);
  const focusReduction = Math.min((s.deepFocusGuide  || 0) * 0.10, 0.60);
  const lunchReduction = Math.min((s.lunchBox        || 0) * 0.10, 0.50);
  const speedBonus     = 1 + (s.automationSpeed || 0) * 0.25;
  const baseIncome     = BASE_INCOME_PER_SEC + (s.incomePerSecond || 0) * 0.5;

  let { mana, multiplier, energy, currency, workSeconds, totalWorkSeconds, completedCycles } = s;

  // Cap offline sim at 24 hrs to avoid hangs
  const cap = Math.min(Math.floor(seconds), 86400);

  for (let t = 0; t < cap; t++) {
    if (mana <= 0) { mana = 0; break; }

    mana        = Math.max(0, mana - MANA_DRAIN_PER_SEC * (1 - drainReduction));
    multiplier  = Math.max(0, multiplier - MULTIPLIER_DECAY_PER_SEC * (1 - focusReduction));
    energy      = Math.max(0, energy - ENERGY_DECAY_PER_SEC * (1 - lunchReduction));

    const level      = levelFromSecs(totalWorkSeconds);
    const energyFac  = energy / 100;
    const prodFac    = multiplier / 100;
    const income     = baseIncome * speedBonus * prodFac * energyFac * levelIncomeMultiplier(level);
    currency        += income;
    workSeconds     += 1;
    totalWorkSeconds += 1;

    if (workSeconds >= MAX_SHIFT_SECS) {
      const deskBonus = (s.ergonomicDesk || 0) * 100;
      const bonus = (SHIFT_COMPLETION_BONUS + deskBonus) * prodFac;
      currency += bonus;
      completedCycles += 1;
      onShiftComplete?.(bonus);
      workSeconds = 0;
    }
  }

  return {
    ...s,
    mana: Math.max(0, mana),
    multiplier: Math.max(0, multiplier),
    energy: Math.max(0, energy),
    currency,
    workSeconds,
    totalWorkSeconds,
    completedCycles,
    isWorking: mana > 0,
  };
}

// ─── Offline Progress: called once on cold load ───────────────────────────────
function applyOfflineProgress(savedState: GameState, checkpoint: WorkCheckpoint, nowMs: number): { state: GameState; elapsedSecs: number; shiftsCompleted: number } {
  const elapsedSecs = Math.max(0, (nowMs - checkpoint.timestamp) / 1000);
  if (elapsedSecs < 2) return { state: savedState, elapsedSecs: 0, shiftsCompleted: 0 };

  // Start from the checkpoint state (the world as it was when work began),
  // then fast-forward elapsed seconds.
  let shiftsCompleted = 0;
  const result = simulateSeconds(
    checkpoint.state,
    elapsedSecs,
    () => { shiftsCompleted++; },
  );

  return { state: result, elapsedSecs, shiftsCompleted };
}

// ─── Format Helpers ───────────────────────────────────────────────────────────
function fmtTime(secs: number): string {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtHours(totalSecs: number): string {
  const h = totalSecs / 3600;
  if (h >= 1000) return `${(h / 1000).toFixed(1)}k hrs`;
  if (h >= 100)  return `${Math.floor(h)} hrs`;
  if (h >= 1)    return `${h.toFixed(1)} hrs`;
  return `${Math.floor(totalSecs / 60)} min`;
}
function fmtMultiplierTime(pct: number): string { return fmtTime(Math.round((pct / 100) * 57600)); }

// ─── ProgressBar ─────────────────────────────────────────────────────────────
function ProgressBar({ value, max, color, label, sublabel, icon: Icon, height = 7, warn }: ProgressBarProps): JSX.Element {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const effectiveColor = warn && pct < 25 ? P.red : pct < 50 ? P.yellow : color;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          {Icon && <Icon size={12} color={effectiveColor} />}
          <span style={{ fontSize: 11, color: P.muted, fontFamily: F.body, letterSpacing: "0.05em" }}>{label}</span>
          {warn && pct < 30 && <span style={{ fontSize: 9, color: P.red, fontFamily: F.mono, animation: "pulse 1s infinite" }}>LOW</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {sublabel && <span style={{ fontSize: 10, color: P.muted, fontFamily: F.mono }}>{sublabel}</span>}
          <span style={{ fontSize: 11, color: effectiveColor, fontFamily: F.mono, fontWeight: 600 }}>{Math.round(value)}/{max}</span>
        </div>
      </div>
      <div style={{ height, background: "#1e2435", borderRadius: 4, overflow: "hidden" }}>
        <motion.div animate={{ width: `${pct}%` }} transition={{ duration: 0.3, ease: "easeOut" }}
          style={{ height: "100%", background: effectiveColor, borderRadius: 4, boxShadow: pct > 10 ? `0 0 7px ${effectiveColor}55` : "none" }} />
      </div>
    </div>
  );
}

// ─── Gambling Modal ───────────────────────────────────────────────────────────
function GamblingModal({ pending, onResult, addLog }: GamblingModalProps): JSX.Element {
  const [spinning, setSpinning]   = useState<boolean>(false);
  const [result, setResult]       = useState<GambleOutcome | null>(null);
  const [revealed, setRevealed]   = useState<boolean>(false);
  const [slots, setSlots]         = useState<string[]>(["?", "?", "?"]);
  const SYMBOLS: string[] = ["💎", "🔥", "✨", "👍", "💼", "⭐", "🎯", "🃏"];

  const spin = (): void => {
    if (spinning || revealed) return;
    setSpinning(true);
    const outcome = rollGamble();
    let iter = 0;
    const total = 18;
    const interval = setInterval(() => {
      iter++;
      setSlots([
        SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
        SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
        SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
      ]);
      if (iter >= total) {
        clearInterval(interval);
        const sym = outcome.emoji;
        setSlots([sym, sym, sym]);
        setResult(outcome);
        setSpinning(false);
        setRevealed(true);
      }
    }, 80);
  };

  const claim = (): void => {
    if (!result) return;
    const finalBonus = Math.floor(pending.baseBonus * result.mult);
    onResult(finalBonus, result);
    addLog(`🎰 ${result.label}! ×${result.mult} — +$${finalBonus} shift bonus!`, result.color);
  };

  const skip = (): void => {
    const base = GAMBLE_OUTCOMES[GAMBLE_OUTCOMES.length - 1];
    onResult(Math.floor(pending.baseBonus * 1), base);
    addLog(`Took the base shift bonus: +$${Math.floor(pending.baseBonus)}.`, P.muted);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}>
      <motion.div initial={{ scale: 0.85, y: 30 }} animate={{ scale: 1, y: 0 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}
        style={{
          background: P.card, border: `1px solid ${result ? result.color : P.accent}`,
          borderRadius: 18, padding: "28px 24px", width: "100%", maxWidth: 380, textAlign: "center",
          boxShadow: `0 0 40px ${result ? result.color + "66" : P.accent + "44"}`,
        }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 6 }}>
          <Dice5 size={18} color={P.yellow} />
          <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 18, color: P.text }}>Shift Complete!</span>
        </div>
        <div style={{ fontSize: 12, color: P.muted, marginBottom: 20 }}>
          Base bonus: <span style={{ color: P.yellow, fontFamily: F.mono, fontWeight: 700 }}>${Math.floor(pending.baseBonus)}</span>
          &nbsp;— Gamble to multiply it?
        </div>

        {!revealed && (
          <div style={{ background: "#0f1220", borderRadius: 10, padding: "10px 14px", marginBottom: 18, textAlign: "left" }}>
            <div style={{ fontSize: 10, color: P.muted, letterSpacing: "0.06em", marginBottom: 8 }}>ODDS</div>
            {GAMBLE_OUTCOMES.map((o: GambleOutcome) => (
              <div key={o.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span>{o.emoji}</span>
                  <span style={{ fontSize: 11, color: o.color, fontFamily: F.display, fontWeight: 600 }}>{o.label}</span>
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <span style={{ fontSize: 11, fontFamily: F.mono, color: P.text }}>×{o.mult}</span>
                  <span style={{ fontSize: 11, fontFamily: F.mono, color: P.muted }}>{(o.chance * 100).toFixed(0)}%</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 20 }}>
          {slots.map((s: string, i: number) => (
            <motion.div key={i}
              animate={spinning ? { y: [0, -4, 0], scale: [1, 1.1, 1] } : {}}
              transition={{ repeat: Infinity, duration: 0.15 }}
              style={{
                width: 64, height: 64, borderRadius: 12, fontSize: 28,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: result ? `${result.color}22` : "#0f1220",
                border: `2px solid ${result ? result.color : P.border}`,
                boxShadow: result ? `0 0 16px ${result.color}55` : "none",
                transition: "all 0.3s",
              }}>
              {s}
            </motion.div>
          ))}
        </div>

        {revealed && result && (
          <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
            style={{ marginBottom: 18, padding: "10px 16px", borderRadius: 10, background: `${result.color}22`, border: `1px solid ${result.color}55` }}>
            <div style={{ fontSize: 22, fontFamily: F.display, fontWeight: 800, color: result.color }}>{result.label}!</div>
            <div style={{ fontSize: 14, color: P.text, fontFamily: F.mono, marginTop: 4 }}>
              ×{result.mult} → <span style={{ color: result.color, fontWeight: 700 }}>${Math.floor(pending.baseBonus * result.mult)}</span>
            </div>
          </motion.div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          {!revealed ? (
            <>
              <button onClick={spin} disabled={spinning}
                style={{
                  flex: 2, padding: "12px 0", borderRadius: 10, border: "none", cursor: spinning ? "not-allowed" : "pointer",
                  background: spinning ? "#1e2435" : `linear-gradient(135deg,${P.accent},${P.purple})`,
                  color: "#fff", fontFamily: F.display, fontWeight: 700, fontSize: 14,
                  boxShadow: spinning ? "none" : `0 0 20px ${P.accent}55`,
                }}>
                {spinning ? "Spinning…" : "🎰 SPIN"}
              </button>
              <button onClick={skip}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 10, cursor: "pointer",
                  background: "transparent", border: `1px solid ${P.border}`,
                  color: P.muted, fontFamily: F.body, fontSize: 12,
                }}>
                Skip
              </button>
            </>
          ) : (
            <button onClick={claim}
              style={{
                flex: 1, padding: "13px 0", borderRadius: 10, border: "none", cursor: "pointer",
                background: `linear-gradient(135deg,${result!.color},${result!.color}88)`,
                color: "#fff", fontFamily: F.display, fontWeight: 700, fontSize: 14,
                boxShadow: `0 0 20px ${result!.color}66`,
              }}>
              Claim +${Math.floor(pending.baseBonus * result!.mult)}
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function IdleWorkerGame(): JSX.Element {
  const [state, setState]             = useState<GameState>(INITIAL_STATE);
  const [tab, setTab]                 = useState<string>("work");
  const [recoveryTab, setRecoveryTab] = useState<string>("nutrition");
  const [log, setLog]                 = useState<LogEntry[]>([{ id: 0, text: "Welcome! Energy decays over time — eat and drink to keep working efficiently!", color: P.muted }]);
  const [importStr, setImportStr]     = useState<string>("");
  const [saveStatus, setSaveStatus]   = useState<string>("");
  const [levelUpAnim, setLevelUpAnim] = useState<boolean>(false);
  const [shiftCompleteAnim, setShiftCompleteAnim] = useState<boolean>(false);
  const [titleUnlocked, setTitleUnlocked]         = useState<TitleDef | null>(null);

  const logIdRef     = useRef<number>(1);
  const stateRef     = useRef<GameState>(state);
  stateRef.current   = state;
  const prevTitleRef = useRef<string | null>(null);

  const addLog = useCallback((text: string, color: string = P.muted): void => {
    const id = logIdRef.current++;
    setLog((prev: LogEntry[]) => [{ id, text, color }, ...prev].slice(0, 50));
  }, []);

  // ── Cold load: restore state + apply offline progress via checkpoint ──────
  useEffect(() => {
    try {
      const nowMs = Date.now();

      // 1. Load the last auto-saved state (used as fallback / non-working baseline)
      const savedRaw = localStorage.getItem(SAVE_KEY);
      const savedState: GameState = savedRaw ? (decodeState(savedRaw) ?? INITIAL_STATE) : INITIAL_STATE;

      // 2. Load the work checkpoint (set when work was started, cleared when stopped)
      const checkpoint = loadCheckpoint();

      if (checkpoint) {
        // There's a checkpoint → the player had work running when they left.
        // Fast-forward from the checkpoint state for however long they were away.
        const { state: result, elapsedSecs, shiftsCompleted } = applyOfflineProgress(savedState, checkpoint, nowMs);

        const finalState: GameState = {
          ...INITIAL_STATE,
          ...result,
          // Recovery doesn't run offline — reset it
          activeRecovery: null,
          recoveryProgress: 0,
          recoveryMax: 0,
        };

        setState(finalState);
        stateRef.current = finalState;

        if (elapsedSecs > 2) {
          addLog(
            `Welcome back! Away ${fmtTime(Math.round(elapsedSecs))}${shiftsCompleted > 0 ? ` · ${shiftsCompleted} shift(s) completed` : ""} — progress applied.`,
            P.green,
          );
        } else {
          addLog("Progress loaded.", P.green);
        }

        // If still working after catch-up, write a fresh checkpoint from this moment
        if (finalState.isWorking) {
          saveCheckpoint(finalState);
        } else {
          // Mana ran out during offline period
          clearCheckpoint();
          addLog("Mana ran out while you were away. Time to recover!", P.red);
        }
      } else {
        // No checkpoint → work was paused/stopped when they left. Just restore state.
        const finalState: GameState = {
          ...INITIAL_STATE,
          ...savedState,
          isWorking: false, // never auto-resume without a checkpoint
          activeRecovery: null,
          recoveryProgress: 0,
        };
        setState(finalState);
        stateRef.current = finalState;
        if (savedRaw) addLog("Progress loaded from auto-save.", P.green);
      }

      prevTitleRef.current = getTitleForHours((stateRef.current.totalWorkSeconds || 0) / 3600).label;
    } catch (e) {
      console.error("Load error", e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-save current state every 10s ────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      try { localStorage.setItem(SAVE_KEY, encodeState(stateRef.current)); } catch { /* ignore */ }
    }, 10000);
    return () => clearInterval(t);
  }, []);

  // ── Visibility change: update checkpoint timestamp on hide/show ────────────
  // On hide → save current state + update checkpoint timestamp to now.
  // On show  → apply delta using the updated checkpoint, then refresh checkpoint.
  // This means the checkpoint always reflects "the state right before we went away".
  useEffect(() => {
    const onVis = (): void => {
      if (document.hidden) {
        // Save current state immediately
        try { localStorage.setItem(SAVE_KEY, encodeState(stateRef.current)); } catch { /* ignore */ }
        // Update checkpoint to current state + now, so when we return,
        // offline calc starts from exactly here
        if (stateRef.current.isWorking) {
          saveCheckpoint(stateRef.current);
        }
      } else {
        // Tab visible again — apply offline progress since the checkpoint
        const checkpoint = loadCheckpoint();
        if (!checkpoint) return;

        const nowMs = Date.now();
        const elapsed = nowMs - checkpoint.timestamp;
        if (elapsed < 2000) return; // Less than 2s, ignore

        const { state: result, elapsedSecs, shiftsCompleted } = applyOfflineProgress(
          stateRef.current,
          checkpoint,
          nowMs,
        );

        const finalState: GameState = {
          ...result,
          activeRecovery: stateRef.current.activeRecovery,
          recoveryProgress: stateRef.current.recoveryProgress,
          recoveryMax: stateRef.current.recoveryMax,
        };

        setState(finalState);
        stateRef.current = finalState;

        if (elapsedSecs > 5) {
          addLog(
            `Back! Away ${fmtTime(Math.round(elapsedSecs))}${shiftsCompleted > 0 ? ` · ${shiftsCompleted} shift(s) done` : ""}.`,
            P.green,
          );
        }

        // Refresh checkpoint to now
        if (finalState.isWorking) {
          saveCheckpoint(finalState);
        } else {
          clearCheckpoint();
        }
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [addLog]);

  // ── Main tick loop — purely in-memory, no checkpoint interaction ──────────
  // Runs every TICK_MS. Accumulates fractional seconds for precise math.
  const accumulatorRef = useRef<number>(0);

  useEffect(() => {
    const t = setInterval((): void => {
      setState((prev: GameState): GameState => {
        const dt = TICK_MS / 1000;
        const focusReduction = Math.min((prev.deepFocusGuide || 0) * 0.10, 0.60);
        const lunchReduction = Math.min((prev.lunchBox       || 0) * 0.10, 0.50);

        const isFrozen = (() => {
          const act = RECOVERY_ACTIONS.find((a: RecoveryAction) => a.id === prev.activeRecovery);
          return act?.freezesMultiplier === true;
        })();

        let next: GameState = { ...prev };

        // Productivity decay (always, unless meditating)
        if (!isFrozen) {
          next.multiplier = Math.max(0, prev.multiplier - MULTIPLIER_DECAY_PER_SEC * (1 - focusReduction) * dt);
        }

        // Energy decay (hunger/thirst — always)
        next.energy = Math.max(0, prev.energy - ENERGY_DECAY_PER_SEC * (1 - lunchReduction) * dt);
        if (next.energy < 5 && prev.energy >= 5 && !prev._warnedEnergy) {
          next._warnedEnergy = true;
          next._energyWarn   = true;
        }
        if (next.energy >= 5) next._warnedEnergy = false;

        // Work tick
        if (prev.isWorking) {
          const drainReduction = Math.min((prev.espressoMachine || 0) * 0.10, 0.60);
          next.mana        = Math.max(0, prev.mana - MANA_DRAIN_PER_SEC * (1 - drainReduction) * dt);
          next.workProgress = (prev.workProgress + dt) % 5;

          const newWorkSeconds      = prev.workSeconds + dt;
          const newTotalWorkSeconds = (prev.totalWorkSeconds || 0) + dt;
          next.workSeconds      = newWorkSeconds;
          next.totalWorkSeconds = newTotalWorkSeconds;

          const level       = levelFromSecs(newTotalWorkSeconds);
          const speedBonus  = 1 + (prev.automationSpeed || 0) * 0.25;
          const baseIncome  = BASE_INCOME_PER_SEC + (prev.incomePerSecond || 0) * 0.5;
          const energyFactor = Math.max(0, next.energy / 100);
          const prodFactor   = next.multiplier / 100;
          const perTick = baseIncome * speedBonus * prodFactor * energyFactor * levelIncomeMultiplier(level) * dt;
          next.currency += perTick;

          // Shift completion → trigger gambling
          if (newWorkSeconds >= MAX_SHIFT_SECS && prev.workSeconds < MAX_SHIFT_SECS) {
            const deskBonus = (prev.ergonomicDesk || 0) * 100;
            const baseBonus = (SHIFT_COMPLETION_BONUS + deskBonus) * (next.multiplier / 100);
            next.completedCycles    = (prev.completedCycles || 0) + 1;
            next.isWorking          = false;
            next.workSeconds        = 0;
            next.workProgress       = 0;
            next.pendingGamble      = { baseBonus };
            // Work ended — clear the checkpoint
            clearCheckpoint();
          }

          if (next.mana <= 0) {
            next.isWorking    = false;
            next.workSeconds  = 0;
            next.workProgress = 0;
            next._stopWork    = true;
            clearCheckpoint();
          }
        }

        // Recovery tick
        if (prev.activeRecovery) {
          const newProg = prev.recoveryProgress + dt;
          if (newProg >= prev.recoveryMax) {
            const action = RECOVERY_ACTIONS.find((a: RecoveryAction) => a.id === prev.activeRecovery);
            if (action) {
              const applied = action.apply(prev);
              next = { ...next, ...applied, activeRecovery: null, recoveryProgress: 0, recoveryMax: 0 };
            }
          } else {
            next.recoveryProgress = newProg;
          }
        }

        // Level-up detection
        const prevLevel = levelFromSecs(prev.totalWorkSeconds || 0);
        const nextLevel = levelFromSecs(next.totalWorkSeconds || 0);
        if (nextLevel > prevLevel) next._levelUp = nextLevel;

        return next;
      });
    }, TICK_MS);
    return () => clearInterval(t);
  }, []);

  // ── Side effects for transient flags ──────────────────────────────────────
  useEffect(() => {
    if (!state._stopWork) return;
    addLog("Mana exhausted. Shift ended — go recover!", P.red);
    setState((p: GameState) => { const { _stopWork, ...r } = p; return r as GameState; });
  }, [state._stopWork, addLog]);

  useEffect(() => {
    if (!state._energyWarn) return;
    addLog("⚠️ Energy critically low! Eat something or your income tanks.", P.red);
    setState((p: GameState) => { const { _energyWarn, ...r } = p; return r as GameState; });
  }, [state._energyWarn, addLog]);

  useEffect(() => {
    if (!state._levelUp) return;
    const lvl = state._levelUp;
    addLog(`⭐ LEVEL UP! Now Level ${lvl}. Income ×${lvl}`, P.yellow);
    setLevelUpAnim(true);
    setTimeout(() => setLevelUpAnim(false), 1200);
    setState((p: GameState) => { const { _levelUp, ...r } = p; return r as GameState; });
  }, [state._levelUp, addLog]);

  useEffect(() => {
    const totalHours = (state.totalWorkSeconds || 0) / 3600;
    const current = getTitleForHours(totalHours);
    if (prevTitleRef.current !== null && current.label !== prevTitleRef.current) {
      addLog(`🏆 TITLE UNLOCKED: "${current.label}"!`, current.color);
      setTitleUnlocked(current);
      setTimeout(() => setTitleUnlocked(null), 4000);
    }
    prevTitleRef.current = current.label;
  }, [state.totalWorkSeconds, addLog]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const toggleWork = (): void => {
    if (state.isWorking) {
      // Pause: clear checkpoint since work is no longer running
      clearCheckpoint();
      setState((p: GameState) => ({ ...p, isWorking: false }));
      addLog("Work paused.", P.muted);
      return;
    }
    if (state.mana <= 2)       { addLog("Not enough Mana to work. Recover first.", P.red);   return; }
    if (state.activeRecovery)  { addLog("Finish your recovery first.", P.yellow);              return; }
    if (state.pendingGamble)   { addLog("Collect your shift bonus first!", P.yellow);          return; }

    // Save checkpoint BEFORE updating state, capturing the current moment
    const startingState = { ...state, isWorking: true };
    saveCheckpoint(startingState);

    setState((p: GameState) => ({ ...p, isWorking: true }));
    addLog(`Shift started! Energy affects income — keep it up! ${fmtTime(MAX_SHIFT_SECS - state.workSeconds)} remaining.`, P.green);
  };

  const handleGambleResult = (finalBonus: number, outcome: GambleOutcome): void => {
    setState((p: GameState) => ({ ...p, currency: p.currency + finalBonus, pendingGamble: null }));
    if (outcome.mult >= 10) { setShiftCompleteAnim(true); setTimeout(() => setShiftCompleteAnim(false), 2000); }
  };

  const startRecovery = (id: string): void => {
    const action = RECOVERY_ACTIONS.find((a: RecoveryAction) => a.id === id);
    if (!action) return;
    if (state.isWorking)      { addLog("Stop working before recovering.", P.yellow);      return; }
    if (state.activeRecovery) { addLog("Already doing a recovery action.", P.yellow);     return; }
    if (!action.canDo(state)) {
      if (action.currencyCost) addLog(`Need $${action.currencyCost} to do this.`, P.red);
      else                     addLog("Can't do that right now.", P.red);
      return;
    }
    setState((p: GameState) => ({ ...p, activeRecovery: id, recoveryProgress: 0, recoveryMax: action.duration }));
    addLog(`${action.name} started. (~${action.realTime})`, action.color);
  };

  const cancelRecovery = (): void => {
    setState((p: GameState) => ({ ...p, activeRecovery: null, recoveryProgress: 0, recoveryMax: 0 }));
    addLog("Recovery cancelled.", P.muted);
  };

  const buyUpgrade = (key: UpgradeKey): void => {
    const def  = UPGRADES[key];
    const lvl  = state[key] as number || 0;
    const cost = upgradeCost(def.baseCost, def.costScale, lvl);
    if (state.currency < cost) { addLog(`Need $${cost} for ${def.name}.`, P.red); return; }
    setState((p: GameState) => ({ ...p, currency: p.currency - cost, [key]: ((p[key] as number) || 0) + 1 }));
    addLog(`${def.name} upgraded to Lv${lvl + 1}!`, def.color);
  };

  const exportSave = (): void => {
    navigator.clipboard.writeText(encodeState(state)).then(() => {
      setSaveStatus("Copied to clipboard!");
      setTimeout(() => setSaveStatus(""), 2500);
    });
  };

  const importSave = (): void => {
    const d = decodeState(importStr.trim());
    if (d) {
      clearCheckpoint();
      setState({ ...INITIAL_STATE, ...d, isWorking: false, activeRecovery: null, pendingGamble: null });
      addLog("Save imported!", P.green);
      setSaveStatus("Loaded!");
    } else {
      setSaveStatus("Invalid save string.");
    }
    setTimeout(() => setSaveStatus(""), 2500);
  };

  const resetGame = (): void => {
    clearCheckpoint();
    localStorage.removeItem(SAVE_KEY);
    setState(INITIAL_STATE);
    setLog([{ id: 0, text: "Game reset. Fresh start!", color: P.muted }]);
    setSaveStatus("Reset done.");
    prevTitleRef.current = getTitleForHours(0).label;
    setTimeout(() => setSaveStatus(""), 2000);
  };

  // ── Computed display values ───────────────────────────────────────────────
  const totalWorkSecs = state.totalWorkSeconds || 0;
  const totalHours    = totalWorkSecs / 3600;
  const curLevel      = levelFromSecs(totalWorkSecs);
  const lvlProgress   = levelProgressInSecs(curLevel, totalWorkSecs);
  const levelPct      = lvlProgress.needed > 0 ? Math.min(100, (lvlProgress.done / lvlProgress.needed) * 100) : 100;
  const currentTitle  = getTitleForHours(totalHours);
  const nextTitle     = getNextTitle(totalHours);
  const titlePct      = nextTitle ? Math.min(100, ((totalHours - currentTitle.hours) / (nextTitle.hours - currentTitle.hours)) * 100) : 100;
  const shiftPct      = (state.workSeconds / MAX_SHIFT_SECS) * 100;
  const pulsePct      = (state.workProgress / 5) * 100;
  const multiColor    = state.multiplier > 60 ? P.green : state.multiplier > 25 ? P.yellow : P.red;
  const manaColor     = state.mana > 50 ? P.mana : state.mana > 20 ? P.yellow : P.red;
  const energyFactor  = Math.max(0, state.energy / 100);
  const baseIncomeSec = (BASE_INCOME_PER_SEC + (state.incomePerSecond || 0) * 0.5)
    * (1 + (state.automationSpeed || 0) * 0.25)
    * (state.multiplier / 100)
    * energyFactor
    * levelIncomeMultiplier(curLevel);

  const TABS = [
    { id: "work",    label: "Work",    Icon: Briefcase  },
    { id: "recover", label: "Recover", Icon: Battery    },
    { id: "shop",    label: "Shop",    Icon: ShoppingBag },
    { id: "save",    label: "Save",    Icon: Settings   },
  ] as const;

  const cs: React.CSSProperties = { minHeight: "100vh", background: P.bg, color: P.text, fontFamily: F.body, display: "flex", flexDirection: "column", alignItems: "center", padding: "0 0 80px" };
  const card: React.CSSProperties = { background: P.card, border: `1px solid ${P.border}`, borderRadius: 12, padding: "15px 17px", marginBottom: 12 };
  const bigBtn = (color: string, disabled: boolean = false): React.CSSProperties => ({
    width: "100%", padding: "13px 0", borderRadius: 10, border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    background: disabled ? "#1e2435" : color,
    color: disabled ? P.muted : "#fff",
    fontFamily: F.display, fontSize: 15, fontWeight: 700, letterSpacing: "0.04em",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    boxShadow: disabled ? "none" : `0 0 18px ${color}55`,
    transition: "all 0.18s", marginTop: 8, opacity: disabled ? 0.5 : 1,
  });

  const visibleRecoveryActions = RECOVERY_ACTIONS.filter((a: RecoveryAction) => a.category === recoveryTab);

  return (
    <div style={cs}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>

      <AnimatePresence>
        {state.pendingGamble && (
          <GamblingModal pending={state.pendingGamble} onResult={handleGambleResult} addLog={addLog} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {titleUnlocked && (
          <motion.div initial={{ opacity: 0, y: -40, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -20, scale: 0.9 }}
            style={{ position: "fixed", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 9998, background: "linear-gradient(135deg,#0d0f14,#1a1628)", border: `1px solid ${titleUnlocked.color}`, borderRadius: 12, padding: "12px 20px", display: "flex", alignItems: "center", gap: 10, boxShadow: `0 0 30px ${titleUnlocked.color}55`, maxWidth: 340, width: "90%" }}>
            <Crown size={20} color={titleUnlocked.color} />
            <div>
              <div style={{ fontSize: 10, color: P.muted, letterSpacing: "0.06em", marginBottom: 2 }}>TITLE UNLOCKED</div>
              <div style={{ fontSize: 14, fontFamily: F.display, fontWeight: 700, color: titleUnlocked.color }}>{titleUnlocked.label}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div style={{ width: "100%", background: P.surface, borderBottom: `1px solid ${P.border}`, padding: "13px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Flame size={17} color={P.accent} />
          <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 15, color: P.text, letterSpacing: "-0.02em" }}>Idle Optimal Worker</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {state.isWorking && (
            <motion.div animate={{ opacity: [1, 0.3, 1] }} transition={{ repeat: Infinity, duration: 1.1 }}
              style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: P.green }} />
              <span style={{ fontSize: 10, color: P.green, fontFamily: F.mono }}>WORKING</span>
            </motion.div>
          )}
          <motion.div animate={levelUpAnim ? { scale: [1, 1.3, 1], rotate: [0, 8, -8, 0] } : {}}
            style={{ display: "flex", alignItems: "center", gap: 4, background: levelUpAnim ? `${P.yellow}28` : `${P.accent}20`, border: `1px solid ${levelUpAnim ? P.yellow : P.accent}50`, borderRadius: 8, padding: "3px 8px" }}>
            <Star size={10} color={levelUpAnim ? P.yellow : P.accent} />
            <span style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 700, color: levelUpAnim ? P.yellow : P.accent }}>Lv{curLevel}</span>
          </motion.div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <TrendingUp size={12} color={P.yellow} />
            <span style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700, color: P.yellow }}>${Math.floor(state.currency)}</span>
          </div>
        </div>
      </div>

      <div style={{ width: "100%", maxWidth: 560, padding: "0 15px" }}>

        {/* Resource Card */}
        <motion.div animate={shiftCompleteAnim ? { borderColor: [P.border, P.yellow, P.border] } : {}} transition={{ duration: 1.5 }}
          style={{ ...card, marginTop: 14, paddingBottom: 10, border: `1px solid ${shiftCompleteAnim ? P.yellow : P.border}` }}>

          {/* Level */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <motion.div animate={levelUpAnim ? { scale: [1, 1.15, 1], boxShadow: [`0 0 0 ${P.yellow}00`, `0 0 22px ${P.yellow}99`, `0 0 0 ${P.yellow}00`] } : {}}
              style={{ width: 48, height: 48, borderRadius: 12, flexShrink: 0, background: `linear-gradient(135deg,${P.accent}33,${P.purple}33)`, border: `2px solid ${levelUpAnim ? P.yellow : P.accent}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 8, color: P.muted, fontFamily: F.mono, letterSpacing: "0.06em" }}>LVL</span>
              <span style={{ fontSize: 20, fontFamily: F.display, fontWeight: 800, color: levelUpAnim ? P.yellow : P.accent, lineHeight: 1 }}>{curLevel}</span>
            </motion.div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: P.muted, letterSpacing: "0.04em" }}>LEVEL PROGRESS</span>
                <span style={{ fontSize: 11, fontFamily: F.mono, color: P.accent }}>{fmtHours(lvlProgress.done)} / {fmtHours(lvlProgress.needed)} to Lv{curLevel + 1}</span>
              </div>
              <div style={{ height: 8, background: "#1e2435", borderRadius: 5, overflow: "hidden" }}>
                <motion.div animate={{ width: `${levelPct}%` }} transition={{ duration: 0.35 }}
                  style={{ height: "100%", borderRadius: 5, background: levelUpAnim ? `linear-gradient(90deg,${P.yellow},#f59e0b)` : `linear-gradient(90deg,${P.accent},${P.purple})`, boxShadow: `0 0 8px ${P.accent}55` }} />
              </div>
              <div style={{ fontSize: 10, color: P.muted, marginTop: 3, fontFamily: F.mono }}>Lv{curLevel} = {lvlProgress.startHrs}h – {lvlProgress.endHrs}h worked · ×{curLevel} income</div>
            </div>
          </div>

          {/* Title */}
          <div style={{ marginBottom: 14, padding: "10px 12px", background: "#0f1220", borderRadius: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <Crown size={11} color={currentTitle.color} />
                <span style={{ fontSize: 12, fontFamily: F.display, fontWeight: 700, color: currentTitle.color }}>{currentTitle.label}</span>
              </div>
              <span style={{ fontSize: 10, fontFamily: F.mono, color: P.muted }}>{fmtHours(state.totalWorkSeconds || 0)}</span>
            </div>
            {nextTitle && (
              <>
                <div style={{ height: 5, background: "#1e2435", borderRadius: 3, overflow: "hidden", marginBottom: 4 }}>
                  <motion.div animate={{ width: `${titlePct}%` }} transition={{ duration: 0.4 }}
                    style={{ height: "100%", background: `linear-gradient(90deg,${currentTitle.color},${nextTitle.color})`, borderRadius: 3 }} />
                </div>
                <div style={{ fontSize: 10, color: P.muted, fontFamily: F.mono }}>Next: <span style={{ color: nextTitle.color }}>{nextTitle.label}</span> at {nextTitle.hours.toLocaleString()} hrs</div>
              </>
            )}
          </div>

          <ProgressBar value={state.mana}       max={state.maxMana}   color={manaColor}  label="MANA"         icon={Flame}    />
          <ProgressBar value={state.energy}     max={state.maxEnergy} color={P.orange}   label="ENERGY"       icon={Battery}  warn sublabel="decays over time — EAT to restore" />
          <ProgressBar value={state.multiplier} max={100}             color={multiColor} label="PRODUCTIVITY" icon={Sparkles} sublabel={`${fmtMultiplierTime(state.multiplier)} left`} />

          {/* Income formula */}
          <div style={{ marginTop: 8, padding: "8px 12px", background: "#0f1220", borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: P.muted, fontFamily: F.mono }}>Income formula</span>
            <span style={{ fontSize: 10, fontFamily: F.mono, color: P.text }}>
              <span style={{ color: P.yellow }}>${(BASE_INCOME_PER_SEC + (state.incomePerSecond || 0) * 0.5).toFixed(1)}</span>
              <span style={{ color: P.muted }}> × </span>
              <span style={{ color: state.energy < 30 ? P.red : P.orange }}>{Math.round(state.energy)}%E</span>
              <span style={{ color: P.muted }}> × </span>
              <span style={{ color: multiColor }}>{Math.round(state.multiplier)}%P</span>
              <span style={{ color: P.muted }}> × </span>
              <span style={{ color: P.accent }}>Lv{curLevel}</span>
              <span style={{ color: P.muted }}> = </span>
              <span style={{ color: P.green, fontWeight: 700 }}>${baseIncomeSec.toFixed(2)}/s</span>
            </span>
          </div>
        </motion.div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, background: P.surface, borderRadius: 10, padding: 4, margin: "4px 0 12px", border: `1px solid ${P.border}` }}>
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              style={{ flex: 1, padding: "8px 4px", borderRadius: 7, border: "none", cursor: "pointer", background: tab === id ? P.accent : "transparent", color: tab === id ? "#fff" : P.muted, fontFamily: F.body, fontSize: 12, fontWeight: 600, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, transition: "all 0.15s" }}>
              <Icon size={14} />{label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.16 }}>

            {/* WORK TAB */}
            {tab === "work" && (
              <div>
                <div style={card}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 15 }}>Work Shift</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <Clock size={12} color={P.muted} />
                      <span style={{ fontFamily: F.mono, fontSize: 12, color: P.muted }}>{fmtTime(Math.round(state.workSeconds))} / 1h 30m</span>
                    </div>
                  </div>

                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: P.muted, letterSpacing: "0.04em" }}>SHIFT PROGRESS</span>
                      <span style={{ fontSize: 11, color: P.muted, fontFamily: F.mono }}>{Math.round(shiftPct)}% · {fmtTime(MAX_SHIFT_SECS - Math.round(state.workSeconds))} remaining</span>
                    </div>
                    <div style={{ height: 10, background: "#1e2435", borderRadius: 5, overflow: "hidden" }}>
                      <motion.div animate={{ width: `${shiftPct}%` }} transition={{ duration: 0.3 }}
                        style={{ height: "100%", borderRadius: 5, background: shiftPct > 80 ? `linear-gradient(90deg,${P.yellow},${P.green})` : `linear-gradient(90deg,${P.accent},${P.purple})`, boxShadow: state.isWorking ? `0 0 12px ${P.accent}66` : "none" }} />
                    </div>
                  </div>

                  {state.isWorking && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 10, color: P.muted, letterSpacing: "0.04em" }}>ACTIVITY PULSE</span>
                        <span style={{ fontSize: 10, color: P.muted, fontFamily: F.mono }}>${baseIncomeSec.toFixed(2)}/s</span>
                      </div>
                      <div style={{ height: 5, background: "#1e2435", borderRadius: 3, overflow: "hidden" }}>
                        <motion.div animate={{ width: `${pulsePct}%` }} transition={{ duration: 0.25 }}
                          style={{ height: "100%", background: P.green, borderRadius: 3, boxShadow: `0 0 6px ${P.green}88` }} />
                      </div>
                    </div>
                  )}

                  {state.energy < 25 && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: `${P.red}18`, border: `1px solid ${P.red}40`, fontSize: 12, color: P.red, fontFamily: F.mono }}>
                      ⚠️ Energy low ({Math.round(state.energy)}%) — income at {Math.round(state.energy)}% efficiency! Go eat!
                    </motion.div>
                  )}

                  <div style={{ display: "flex", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                    {[
                      { label: "Shift Bonus", val: `$${Math.floor((SHIFT_COMPLETION_BONUS + (state.ergonomicDesk || 0) * 100) * (state.multiplier / 100))}` },
                      { label: "Income/sec",  val: `$${baseIncomeSec.toFixed(2)}` },
                      { label: "Energy Eff.", val: `${Math.round(state.energy)}%` },
                    ].map(({ label, val }: { label: string; val: string }) => (
                      <div key={label} style={{ flex: "1 1 auto", background: "#0f1220", borderRadius: 7, padding: "7px 10px", textAlign: "center", minWidth: 90 }}>
                        <div style={{ fontSize: 10, color: P.muted, letterSpacing: "0.04em", marginBottom: 2 }}>{label}</div>
                        <div style={{ fontSize: 13, fontFamily: F.mono, color: P.text, fontWeight: 600 }}>{val}</div>
                      </div>
                    ))}
                  </div>

                  <motion.button whileTap={{ scale: 0.97 }}
                    style={bigBtn(state.isWorking ? P.red : P.accent, state.mana <= 2 && !state.isWorking)}
                    onClick={toggleWork}>
                    {state.isWorking
                      ? <><Pause size={16} /> Pause Work</>
                      : state.workSeconds > 0
                        ? <><Play size={16} /> Resume Shift</>
                        : <><Play size={16} /> Start Shift</>}
                  </motion.button>

                  {state.workSeconds > 0 && !state.isWorking && (
                    <button
                      onClick={() => {
                        clearCheckpoint();
                        setState((p: GameState) => ({ ...p, workSeconds: 0, workProgress: 0 }));
                        addLog("Shift abandoned.", P.muted);
                      }}
                      style={{ width: "100%", marginTop: 6, padding: "7px 0", borderRadius: 8, border: `1px solid ${P.border}`, background: "transparent", color: P.muted, fontSize: 11, cursor: "pointer", fontFamily: F.body }}>
                      Abandon shift
                    </button>
                  )}
                </div>

                {state.pendingGamble && (
                  <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                    style={{ ...card, border: `1px solid ${P.yellow}`, marginBottom: 12, textAlign: "center" }}>
                    <Dice5 size={20} color={P.yellow} style={{ marginBottom: 4 }} />
                    <div style={{ fontFamily: F.display, fontWeight: 700, color: P.yellow, fontSize: 14 }}>Shift bonus pending!</div>
                    <div style={{ fontSize: 12, color: P.muted, marginTop: 4 }}>Click the gambling modal to collect your reward.</div>
                  </motion.div>
                )}

                <div style={{ background: "#0e1018", border: `1px solid ${P.border}`, borderRadius: 10, padding: "10px 14px", maxHeight: 130, overflowY: "auto" }}>
                  <div style={{ fontSize: 10, color: P.muted, letterSpacing: "0.06em", marginBottom: 6 }}>ACTIVITY LOG</div>
                  {log.map((e: LogEntry) => (
                    <div key={e.id} style={{ fontSize: 11, color: e.color, fontFamily: F.mono, marginBottom: 3, lineHeight: 1.4 }}>› {e.text}</div>
                  ))}
                </div>
              </div>
            )}

            {/* RECOVER TAB */}
            {tab === "recover" && (
              <div>
                {state.activeRecovery && (() => {
                  const act = RECOVERY_ACTIONS.find((a: RecoveryAction) => a.id === state.activeRecovery);
                  if (!act) return null;
                  const pct = (state.recoveryProgress / state.recoveryMax) * 100;
                  const timeLeft = Math.ceil(state.recoveryMax - state.recoveryProgress);
                  return (
                    <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                      style={{ ...card, border: `1px solid ${act.color}`, marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <act.icon size={14} color={act.color} />
                          <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 14, color: act.color }}>{act.name}</span>
                        </div>
                        <span style={{ fontSize: 11, fontFamily: F.mono, color: P.muted }}>{fmtTime(timeLeft)} left</span>
                      </div>
                      <div style={{ height: 7, background: "#1e2435", borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
                        <motion.div animate={{ width: `${pct}%` }} transition={{ duration: 0.25 }} style={{ height: "100%", background: act.color, borderRadius: 4 }} />
                      </div>
                      <button onClick={cancelRecovery}
                        style={{ background: "transparent", border: `1px solid ${P.border}`, borderRadius: 7, padding: "5px 12px", color: P.muted, cursor: "pointer", fontSize: 11, fontFamily: F.body }}>
                        Cancel
                      </button>
                    </motion.div>
                  );
                })()}

                <div style={{ display: "flex", gap: 4, background: P.surface, borderRadius: 10, padding: 4, marginBottom: 12, border: `1px solid ${P.border}`, overflowX: "auto" }}>
                  {RECOVERY_CATEGORIES.map(({ id, label, icon: Icon, color }: RecoveryCategory) => (
                    <button key={id} onClick={() => setRecoveryTab(id)}
                      style={{ flex: "1 0 auto", padding: "7px 10px", borderRadius: 7, cursor: "pointer", background: recoveryTab === id ? `${color}22` : "transparent", color: recoveryTab === id ? color : P.muted, fontFamily: F.body, fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", border: recoveryTab === id ? `1px solid ${color}50` : "1px solid transparent", transition: "all 0.15s" }}>
                      <Icon size={12} />{label}
                    </button>
                  ))}
                </div>

                <AnimatePresence mode="wait">
                  <motion.div key={recoveryTab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.14 }}>
                    {visibleRecoveryActions.map((action: RecoveryAction) => {
                      const isActive = state.activeRecovery === action.id;
                      const canDo    = action.canDo(state) && !state.isWorking && !state.activeRecovery;
                      return (
                        <motion.div key={action.id} whileTap={canDo ? { scale: 0.98 } : {}}
                          onClick={() => !isActive && startRecovery(action.id)}
                          style={{ background: isActive ? "#1a1d2e" : P.card, border: `1px solid ${isActive ? action.color : P.border}`, borderRadius: 10, padding: "12px 14px", marginBottom: 10, cursor: canDo ? "pointer" : "not-allowed", opacity: canDo || isActive ? 1 : 0.5, transition: "all 0.15s" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ width: 38, height: 38, borderRadius: 9, flexShrink: 0, background: `${action.color}18`, border: `1px solid ${action.color}40`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <action.icon size={16} color={action.color} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <span style={{ fontWeight: 600, fontSize: 13, fontFamily: F.display }}>{action.name}</span>
                                <span style={{ fontSize: 11, fontFamily: F.mono, color: P.muted }}>{action.realTime}</span>
                              </div>
                              <div style={{ fontSize: 11, color: action.color, marginTop: 2 }}>{action.effect}</div>
                              <div style={{ fontSize: 10, color: P.muted, marginTop: 3, lineHeight: 1.4 }}>{action.desc}</div>
                            </div>
                            <ChevronRight size={13} color={P.muted} />
                          </div>
                        </motion.div>
                      );
                    })}
                  </motion.div>
                </AnimatePresence>
              </div>
            )}

            {/* SHOP TAB */}
            {tab === "shop" && (
              <div>
                <div style={{ fontSize: 11, color: P.muted, letterSpacing: "0.06em", marginBottom: 10 }}>PERMANENT UPGRADES</div>
                {(Object.keys(UPGRADES) as UpgradeKey[]).map((key: UpgradeKey) => {
                  const def  = UPGRADES[key];
                  const lvl  = (state[key] as number) || 0;
                  const cost = upgradeCost(def.baseCost, def.costScale, lvl);
                  const ok   = state.currency >= cost;
                  const Icon = def.icon;
                  return (
                    <motion.div key={key} whileTap={ok ? { scale: 0.98 } : {}} onClick={() => buyUpgrade(key)}
                      style={{ background: P.card, border: `1px solid ${ok ? P.border : "#1a1e2c"}`, borderRadius: 10, padding: "13px 14px", marginBottom: 10, display: "flex", alignItems: "center", gap: 12, opacity: ok ? 1 : 0.6, cursor: ok ? "pointer" : "default", transition: "all 0.15s" }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: `${def.color}18`, border: `1px solid ${def.color}40`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Icon size={18} color={def.color} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontWeight: 600, fontSize: 13, fontFamily: F.display }}>{def.name}</span>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontFamily: F.mono, fontSize: 12, color: P.yellow, fontWeight: 700 }}>${cost}</span>
                            {lvl > 0 && <span style={{ background: `${def.color}25`, color: def.color, fontSize: 10, borderRadius: 5, padding: "1px 6px", fontFamily: F.mono, fontWeight: 600 }}>Lv{lvl}</span>}
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: P.muted, marginTop: 2 }}>{def.desc}</div>
                        {lvl > 0 && <div style={{ fontSize: 11, color: def.color, marginTop: 2 }}>{def.effect(lvl)}</div>}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}

            {/* SAVE TAB */}
            {tab === "save" && (
              <div>
                <div style={card}>
                  <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Save & Export</div>
                  <div style={{ fontSize: 12, color: P.muted, marginBottom: 14, lineHeight: 1.6 }}>Auto-saves every 10 seconds. A work checkpoint is saved when you start a shift — offline progress is calculated exactly from that point on reload.</div>
                  <motion.button whileTap={{ scale: 0.97 }} style={{ ...bigBtn(P.accent), marginTop: 0, marginBottom: 10 }} onClick={exportSave}>
                    <Download size={15} /> Export Save
                  </motion.button>
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 12, color: P.muted, marginBottom: 6 }}>IMPORT SAVE</div>
                    <textarea value={importStr} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setImportStr(e.target.value)}
                      placeholder="Paste your save string here…"
                      style={{ width: "100%", background: "#0e1018", border: `1px solid ${P.border}`, borderRadius: 8, color: P.text, fontFamily: F.mono, fontSize: 11, padding: "10px 12px", resize: "vertical", minHeight: 70, outline: "none", boxSizing: "border-box" }} />
                    <motion.button whileTap={{ scale: 0.97 }} style={bigBtn(P.green, !importStr.trim())} onClick={importSave}>
                      <Upload size={15} /> Load Save
                    </motion.button>
                  </div>
                  {saveStatus && (
                    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                      style={{ marginTop: 10, padding: "8px 12px", borderRadius: 7, background: saveStatus.includes("Invalid") ? `${P.red}20` : `${P.green}20`, color: saveStatus.includes("Invalid") ? P.red : P.green, fontSize: 12, fontFamily: F.mono, textAlign: "center" }}>
                      {saveStatus}
                    </motion.div>
                  )}
                </div>

                <div style={{ ...card, marginTop: 4 }}>
                  <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                    <Dice5 size={13} color={P.yellow} /> Gambling Odds
                  </div>
                  {GAMBLE_OUTCOMES.map((o: GambleOutcome) => (
                    <div key={o.label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${P.border}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 16 }}>{o.emoji}</span>
                        <span style={{ fontSize: 12, color: o.color, fontFamily: F.display, fontWeight: 600 }}>{o.label}</span>
                      </div>
                      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontFamily: F.mono, color: P.text }}>×{o.mult}</span>
                        <span style={{ fontSize: 11, fontFamily: F.mono, color: P.muted }}>{(o.chance * 100).toFixed(0)}% chance</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ ...card, marginTop: 4 }}>
                  <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
                    <Trophy size={13} color={P.yellow} style={{ verticalAlign: "middle", marginRight: 6 }} />Stats
                  </div>
                  {([
                    ["Level",            `${curLevel} (×${curLevel} income)`],
                    ["Completed Cycles", `${state.completedCycles || 0}`],
                    ["Total Work Time",  fmtHours(state.totalWorkSeconds || 0)],
                    ["Title",            currentTitle.label],
                    ["Currency",         `$${Math.floor(state.currency)}`],
                    ["Mana",             `${Math.round(state.mana)} / ${state.maxMana}`],
                    ["Energy",           `${Math.round(state.energy)} / ${state.maxEnergy}`],
                    ["Productivity",     `${Math.round(state.multiplier)}%`],
                    ["Income/sec",       `$${baseIncomeSec.toFixed(2)}`],
                  ] as [string, string][]).map(([label, val]) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${P.border}` }}>
                      <span style={{ fontSize: 12, color: P.muted }}>{label}</span>
                      <span style={{ fontSize: 12, fontFamily: F.mono, color: P.text, fontWeight: 600 }}>{val}</span>
                    </div>
                  ))}
                  <button onClick={resetGame}
                    style={{ width: "100%", marginTop: 14, padding: "9px 0", background: "transparent", border: `1px solid ${P.red}50`, borderRadius: 8, color: P.red, cursor: "pointer", fontSize: 12, fontFamily: F.body }}>
                    <Save size={12} style={{ verticalAlign: "middle", marginRight: 5 }} />Reset Game
                  </button>
                </div>
              </div>
            )}

          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}