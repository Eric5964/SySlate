export function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Independent random pick per slot, WITH replacement — unlike shuffleArray's
// Fisher-Yates shuffle (which guarantees every song plays exactly once
// before any repeats), this can repeat a song sooner or skip one entirely in
// a given pass. That's what actually distinguishes "True Random" from "Full
// Cycle" — previously both modes called shuffleArray and were identical.
export function trueRandomArray(arr) {
  if (arr.length === 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    out.push(arr[Math.floor(Math.random() * arr.length)]);
  }
  return out;
}

// Smart shuffle: a random order that gently favors songs you've played less.
// Each song gets a weight of 1 / (1 + plays)^0.4, so a song played 10 times
// is still about 40% as likely to land early as a never-played one. It's a
// nudge, not a rule. Uses weighted random sampling (Efraimidis-Spirakis):
// sorting by random^(1/weight). Then swaps apart same-artist neighbors.
// `counts` is an object of { [song.id]: playCount }; without it this is
// just a plain shuffle plus the artist spacing.
export function smartShuffle(tracks, counts = {}) {
  const keyed = tracks.map(t => {
    const plays = Math.max(0, counts[t.id] || 0);
    const weight = 1 / Math.pow(1 + plays, 0.4);
    return { t, k: Math.pow(Math.random() || 1e-9, 1 / weight) };
  });
  keyed.sort((a, b) => b.k - a.k);
  const shuffled = keyed.map(x => x.t);
  for (let i = 1; i < shuffled.length - 1; i++) {
    if (shuffled[i].artist === shuffled[i - 1].artist) {
      for (let j = i + 1; j < shuffled.length; j++) {
        if (shuffled[j].artist !== shuffled[i - 1].artist) {
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          break;
        }
      }
    }
  }
  return shuffled;
}

export function buildQueue(tracks, mode, counts) {
  switch (mode) {
    case 'true_random': return trueRandomArray(tracks);
    case 'smart':       return smartShuffle(tracks, counts);
    case 'off':         return [...tracks];
    default:            return shuffleArray(tracks); // full_cycle
  }
}