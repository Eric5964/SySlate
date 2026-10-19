// Where the restored song was when the app was last closed, known the moment a
// session is restored (long before the player has reported anything). The mini
// player reads it so its progress bar is drawn on its very first frame instead
// of popping in once the first position reading arrives.
let seed = null;
export const setProgressSeed = (s) => { seed = s; };
export const getProgressSeed = () => seed;
