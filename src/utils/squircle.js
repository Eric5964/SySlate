// One shared proportion for every rounded cover/art element in the app
// (mini player, full player, playlist cover, playlist grid/list art) so the
// "roundedness" reads consistently regardless of how big the element is,
// instead of each screen picking its own fixed pixel radius.
// `shape` (from the "Cover Shape" setting) is 'rounded' (default, matches
// the app's original look everywhere) or 'square' — passing 'square'
// collapses every one of these calls to 0 with no other changes needed at
// each call site's layout.
export const squircle = (size, shape = 'rounded') => shape === 'square' ? 0 : Math.round(size * 0.22);
