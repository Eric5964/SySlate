// Splits a single artist tag string into individual artists using the
// user's configured separator (see getArtistSeparator/setArtistSeparator in
// storage.js). separator === 'none' or falsy means "don't split" — returns
// the whole string as a single-item array, matching pre-feature behavior
// exactly for anyone who hasn't touched the setting or whose library
// doesn't use multi-artist tags at all.
export function splitArtists(artistStr, separator) {
    const s = artistStr || '';
    if (!s || !separator || separator === 'none') return s ? [s] : [];
    return s.split(separator).map(a => a.trim()).filter(Boolean);
}

// Re-joins with a consistent ", " for display, regardless of what the
// raw tag's actual separator character was — this also means a song
// tagged with, say, "Artist A;Artist B" (no space after the semicolon)
// and one tagged "Artist A; Artist B" (with a space) display identically,
// instead of one looking inconsistent next to the other.
export function formatArtists(artistStr, separator) {
    const parts = splitArtists(artistStr, separator);
    return parts.length ? parts.join(', ') : (artistStr || '');
}

// True if `query` matches the whole artist string OR any individual
// artist within it — used by search so "Artist B" finds a song tagged
// "Artist A; Artist B" even though it's not a leading substring of the
// raw combined string.
export function artistMatches(artistStr, separator, query) {
    const q = query.toLowerCase();
    if ((artistStr || '').toLowerCase().includes(q)) return true;
    return splitArtists(artistStr, separator).some(a => a.toLowerCase().includes(q));
}
