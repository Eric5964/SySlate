export function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Independent weighted pick per slot, WITH replacement. Unlike
// shuffleArray's Fisher-Yates shuffle (every song exactly once per round),
// this can repeat a song sooner or skip one entirely in a round, so Random,
// Smart and Dumb never "cycle" through the whole playlist. The same song is
// never picked twice in a row (when there is more than one song). With
// every weight equal this is True Random.
function weightedPicks(arr, weightOf) {
  const n = arr.length;
  if (n === 0) return [];
  const w = arr.map(weightOf);
  const total = w.reduce((a, b) => a + b, 0);
  const pick = (skip) => {
    let totalNow = total - (skip >= 0 ? w[skip] : 0);
    let r = Math.random() * totalNow;
    for (let i = 0; i < n; i++) {
      if (i === skip) continue;
      r -= w[i];
      if (r <= 0) return i;
    }
    return skip === n - 1 ? n - 2 : n - 1;
  };
  const out = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : pick(prev);
    out.push(arr[idx]);
    prev = idx;
  }
  return out;
}

export function trueRandomArray(arr) {
  return weightedPicks(arr, () => 1);
}

// Smart shuffle: random picks that gently favor songs you've played less.
// Each song's weight is 1 / (1 + plays)^0.4, so a song played 10 times is
// still about 40% as likely as a never-played one. `counts` is
// { [song.id]: playCount }; without it this is plain random.
export function smartShuffle(tracks, counts = {}) {
  return weightedPicks(tracks, t => 1 / Math.pow(1 + Math.max(0, counts[t.id] || 0), 0.4));
}

// "Dumb" shuffle: the mirror image. Songs you have played more get the
// bigger weight, (1 + plays)^0.4, so your most-played songs come up more.
export function dumbShuffle(tracks, counts = {}) {
  return weightedPicks(tracks, t => Math.pow(1 + Math.max(0, counts[t.id] || 0), 0.4));
}

// Weighted order WITHOUT replacement: every song exactly once per round, but
// heavier songs tend to come earlier (Efraimidis-Spirakis keys).
function weightedOrder(arr, weightOf) {
  return arr
    .map(t => ({ t, k: Math.pow(Math.random(), 1 / Math.max(1e-6, weightOf(t))) }))
    .sort((a, b) => b.k - a.k)
    .map(x => x.t);
}

// A shuffle mode is a weighting (normal / smart / dumb) and an order:
//   cycle  = every song once per round ("shuffle")
//   random = each pick is independent, repeats possible, no cycle
// The saved ids are the older ones so nothing stored breaks:
//   full_cycle  normal + cycle     true_random  normal + random
//   smart_cycle smart  + cycle     smart        smart  + random
//   dumb_cycle  dumb   + cycle     dumb         dumb   + random
export const MODE_PARTS = {
  full_cycle: { weight: 'normal', order: 'cycle' },
  true_random: { weight: 'normal', order: 'random' },
  smart_cycle: { weight: 'smart', order: 'cycle' },
  smart: { weight: 'smart', order: 'random' },
  dumb_cycle: { weight: 'dumb', order: 'cycle' },
  dumb: { weight: 'dumb', order: 'random' },
};
export const modeId = (weight, order) => Object.keys(MODE_PARTS).find(k => MODE_PARTS[k].weight === weight && MODE_PARTS[k].order === order) || 'full_cycle';
export const modeNeedsCounts = (mode) => (MODE_PARTS[mode]?.weight ?? 'normal') !== 'normal';

export function buildQueue(tracks, mode, counts = {}) {
  if (mode === 'off') return [...tracks];
  const m = MODE_PARTS[mode] || MODE_PARTS.full_cycle;
  const c = (t) => Math.max(0, counts[t.id] || 0);
  const weightOf = m.weight === 'smart' ? (t => 1 / Math.pow(1 + c(t), 0.4))
    : m.weight === 'dumb' ? (t => Math.pow(1 + c(t), 0.4))
    : (() => 1);
  if (m.order === 'random') return weightedPicks(tracks, weightOf);
  return m.weight === 'normal' ? shuffleArray(tracks) : weightedOrder(tracks, weightOf);
}
