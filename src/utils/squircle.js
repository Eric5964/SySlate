// One shared proportion for every rounded cover/art element in the app
// (mini player, full player, playlist cover, playlist grid/list art) so the
// "roundedness" reads consistently regardless of how big the element is,
// instead of each screen picking its own fixed pixel radius.
export const squircle = (size) => Math.round(size * 0.22);
