// How the radar scores protocols: a sealed snapshot in, a ranked board out.
//
// The board holds every slug the snapshot's watchlist names (that is the floor, never the
// ceiling) plus every other pre-token protocol the snapshot carries: the early finds this
// radar exists to surface. A record counts as pre-token when it carries no token at all —
// no market cap, no CoinGecko id, no symbol. Protocols whose token already trades are kept
// apart and shown with the market's own values, never mixed into the ranking.
//
// The implied value comes only from the snapshot's own numbers, never from a list of names:
//
//   base         = tvl_usd x BASE_FACTOR
//   growth       = clamp(change_7d, -60, 120) percent
//   growthFactor = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity     = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365 days)
//   breadth      = 1 + 0.02 x min(chains, 5)                (more chains, more surface)
//   implied      = max(1, round(base x growthFactor x maturity x breadth))
//
// TVL is the size of the prize, seven-day growth is its momentum, age without a token is
// how long the launch has been waited for, and chain breadth is how many chains the
// protocol already serves. The constants are printed in the dashboard and adjustable in
// the model sandbox. No protocol name is ever special-cased: one function scores all rows.

/** One protocol record from the sealed snapshot: exactly the ten fields it carries. */
export interface ProtocolEntry {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document as a whole. */
export interface SealedSnapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtocolEntry[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelParams {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const DEFAULT_MODEL: ModelParams = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_per_chain: 0.02,
  breadth_max_chains: 5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_TAG = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_VIEW_SIZE = 24;

/** One scored protocol: its implied value and the multipliers behind it. */
export interface ProtocolScore {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmAction {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface RankedRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface BoardViewRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveEntry {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface DashboardData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelParams;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardViewRow[];
  live: LiveEntry[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotProblem';
  }
}

const MS_PER_DAY = 86_400_000;

/** A finite number, or `fallback` when the value is not one. */
function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A finite number, or null when the value is not one. */
function asFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Clamp `n` into the closed interval [`lo`, `hi`]. */
function clampNumber(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when a date is missing or bad. */
export function daysSinceListing(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / MS_PER_DAY));
}

/** The multipliers and the implied value one protocol earns under `model`. */
export function scoreProtocol(protocol: ProtocolEntry, asOf: string, model: ModelParams): ProtocolScore {
  const age = daysSinceListing(asOf, protocol.listed_at);
  const growthPct = clampNumber(asFiniteNumber(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (clampNumber(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const breadthMult = 1 + model.breadth_per_chain * Math.min(protocol.chains.length, model.breadth_max_chains);
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a record carries no token at all. */
export function lacksToken(p: ProtocolEntry): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the board may rank a protocol: pre-token, not an exchange, not a versioned pool. */
export function rankable(p: ProtocolEntry): boolean {
  return lacksToken(p) && p.category !== 'CEX' && !VERSION_SUFFIX.test(p.name);
}

/** The snapshot's protocols keyed by slug. */
function indexProtocols(protocols: ProtocolEntry[]): Map<string, ProtocolEntry> {
  const index = new Map<string, ProtocolEntry>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** The protocols the board ranks, strongest first, carrying ranks 1..n. */
export function assembleBoard(snapshot: SealedSnapshot, model: ModelParams = DEFAULT_MODEL): RankedRow[] {
  const index = indexProtocols(snapshot.protocols);
  const picked: ProtocolEntry[] = [];
  const pickedSlugs = new Set<string>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const entry = index.get(slug);
    if (entry !== undefined && !pickedSlugs.has(slug)) {
      picked.push(entry);
      pickedSlugs.add(slug);
    }
  }
  // The early radar: every other rankable pre-token protocol below the watchlist floor, by TVL.
  // Never a replacement for a watchlist row: a picked protocol stays picked.
  const early = snapshot.protocols
    .filter((p) => !pickedSlugs.has(p.slug) && rankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) picked.push(p);

  const scored = picked.map((p) => {
    const score = scoreProtocol(p, snapshot.as_of, model);
    return { entry: p, ...score };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.entry.slug < b.entry.slug ? -1 : a.entry.slug > b.entry.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.entry.slug,
    name: s.entry.name,
    category: s.entry.category,
    chains: s.entry.chains,
    tvl_usd: s.entry.tvl_usd,
    change_7d: s.entry.change_7d,
    mcap_usd: s.entry.mcap_usd,
    listed_at: s.entry.listed_at,
    gecko_id: s.entry.gecko_id,
    symbol: s.entry.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4dp(s.growthMult),
      maturity_multiplier: round4dp(s.maturityMult),
      breadth_multiplier: round4dp(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: planSteps(s.entry, s.age).map(renderStep),
  }));
}

const round4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One step as a single string: the action, then its cost and time, inside the gate's 20..600 characters. */
export function renderStep(step: FarmAction): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function homeChain(p: ProtocolEntry): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** TVL floors and the stake each one calls for, largest first. */
const STAKE_TIERS: Array<[number, number]> = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeSize(p: ProtocolEntry): number {
  for (const [floor, stake] of STAKE_TIERS) {
    if (p.tvl_usd >= floor) return stake;
  }
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdLength(age: number | null): number {
  return age === null ? 30 : age < 180 ? 60 : age < 365 ? 45 : 30;
}

/** One category's action, as a table of keyword sets and sentence builders, first match wins. */
const ACTION_RULES: Array<{ keys: string[]; line: (name: string, capital: number, chain: string) => string }> = [
  { keys: ['lend', 'cdp', 'collateral'], line: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.` },
  { keys: ['dex', 'yield', 'leveraged farm'], line: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.` },
  { keys: ['bridge'], line: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.` },
  { keys: ['staking', 'restak'], line: (name, capital, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.` },
  { keys: ['perpetual', 'derivative'], line: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.` },
  { keys: ['prediction'], line: (name, capital) => `Fund $${capital} and place one market position on ${name}.` },
  { keys: ['curator', 'allocator', 'risk'], line: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.` },
  { keys: ['stable'], line: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.` },
  { keys: ['rwa'], line: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.` },
  { keys: ['insurance'], line: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.` },
  { keys: ['launchpad'], line: (name, capital) => `Stake $${capital} of the launchpad's asset on ${name} and join one sale.` },
  { keys: ['farm'], line: (name, capital, chain) => `Deposit $${capital} of USDC into ${name}'s farm on ${chain} and harvest weekly.` },
];

/** The category's one action, in the words a farmer can follow. */
function actionLine(p: ProtocolEntry, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.keys.some((key) => category.includes(key))) return rule.line(p.name, capital, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names. Multi-chain protocols get a bridging step; single-chain
 * ones get a second on-chain action.
 */
export function planSteps(p: ProtocolEntry, age: number | null): FarmAction[] {
  const chain = homeChain(p);
  const capital = stakeSize(p);
  const hold = holdLength(age);
  const action = actionLine(p, capital, chain);
  const multi = p.chains.length > 1;
  const secondChain = multi ? p.chains[1]! : chain;
  const steps: FarmAction[] = [];
  steps.push({
    text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
    cost: 'under $3 of gas for the first transaction',
    time: '5 minutes',
  });
  steps.push({
    text: action,
    cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
    time: '15 minutes to set up',
  });
  steps.push(
    multi
      ? {
          text: `Repeat the same position on ${secondChain} so the activity is recorded on a second chain.`,
          cost: `about $${Math.round(capital / 2)} of capital and $3 of gas`,
          time: '10 minutes',
        }
      : {
          text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
          cost: 'about $2 of gas a week',
          time: '10 minutes a week',
        },
  );
  steps.push({
    text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
    cost: `the $${capital} stays in the position`,
    time: `${hold} days`,
  });
  steps.push({
    text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
    cost: 'no fee to check, and never pay to claim',
    time: '10 minutes',
  });
  steps.push({
    text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
    cost: 'nothing but the log',
    time: '5 minutes',
  });
  return steps;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveEntries(snapshot: SealedSnapshot): LiveEntry[] {
  const live = snapshot.protocols.filter((p) => !lacksToken(p) && p.category !== 'CEX');
  live.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return live.slice(0, LIVE_VIEW_SIZE).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function compactRow(row: RankedRow): BoardViewRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: SealedSnapshot, model: ModelParams = DEFAULT_MODEL): { board: RankedRow[]; radar: DashboardData } {
  const board = assembleBoard(snapshot, model);
  const live = liveEntries(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const radar: DashboardData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_TAG,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(compactRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): SealedSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotProblem('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotProblem('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const asOf = doc.as_of;
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new SnapshotProblem('snapshot.json has no as_of date');
  if (typeof doc.source !== 'string') throw new SnapshotProblem('snapshot.json has no source');
  const floor = doc.floor_usd;
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor <= 0) throw new SnapshotProblem('snapshot.json has no floor_usd');
  if (!Array.isArray(doc.protocols)) throw new SnapshotProblem('snapshot.json has no protocols array');
  const watchlist = doc.watchlist;
  if (!Array.isArray(watchlist) || watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotProblem('snapshot.json has no watchlist of slugs');
  }
  const protocols = doc.protocols.map((value, i) => parseProtocol(value, i));
  return { as_of: asOf, source: doc.source, floor_usd: floor, protocols, watchlist: watchlist as string[] };
}

/** One protocol record out of a raw value, refused unless it carries a slug, a name and a TVL. */
function parseProtocol(value: unknown, i: number): ProtocolEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotProblem(`snapshot.json's protocol ${i} is not an object`);
  }
  const p = value as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotProblem(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: asFiniteOrNull(p.change_7d),
    mcap_usd: asFiniteOrNull(p.mcap_usd),
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: RankedRow[], snapshot: SealedSnapshot): string | null {
  const onBoard = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !onBoard.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: DashboardData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
