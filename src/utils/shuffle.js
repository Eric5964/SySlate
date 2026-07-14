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

export function smartShuffle(tracks) {
  const shuffled = shuffleArray(tracks);
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

export function buildQueue(tracks, mode) {
  switch (mode) {
    case 'true_random': return trueRandomArray(tracks);
    case 'smart':       return smartShuffle(tracks);
    case 'off':         return [...tracks];
    default:            return shuffleArray(tracks); // full_cycle
  }
}