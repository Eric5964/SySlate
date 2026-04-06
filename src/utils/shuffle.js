export function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
    case 'true_random': return shuffleArray(tracks);
    case 'smart':       return smartShuffle(tracks);
    case 'off':         return [...tracks];
    default:            return shuffleArray(tracks); // full_cycle
  }
}