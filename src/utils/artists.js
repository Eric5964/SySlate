// Splits a single artist tag string into individual artists using the
// user's configured separator(s) (see getArtistSeparator/setArtistSeparator
// in storage.js). `separators` is an array of separator strings — a song
// can legitimately use more than one at once (e.g. a library tagged with
// both "A; B" and "C & D" style credits). A falsy/empty array, or one
// containing only 'none', means "don't split" — returns the whole string
// as a single-item array, matching pre-feature behavior exactly for anyone
// who hasn't touched the setting or whose library doesn't use multi-artist
// tags at all. Also accepts a bare string for backward compatibility with
// values saved before multi-select existed.
export function splitArtists(artistStr, separators) {
    const s = artistStr || '';
    const seps = (typeof separators === 'string' ? [separators] : (separators || [])).filter(sep => sep && sep !== 'none');
    if (!s || seps.length === 0) return s ? [s] : [];
    // Escape each separator for use inside a regex, then split on any of
    // them at once — so "A; B / C" with both ';' and '/' configured splits
    // into three artists in one pass, not just whichever separator happens
    // to run first.
    const pattern = new RegExp(seps.map(sep => sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
    return s.split(pattern).map(a => a.trim()).filter(Boolean);
}

// Re-joins with a consistent ", " for display, regardless of what the
// raw tag's actual separator character was — this also means a song
// tagged with, say, "Artist A;Artist B" (no space after the semicolon)
// and one tagged "Artist A; Artist B" (with a space) display identically,
// instead of one looking inconsistent next to the other.
export function formatArtists(artistStr, separators) {
    const parts = splitArtists(artistStr, separators);
    return parts.length ? parts.join(', ') : (artistStr || '');
}

// True if `query` matches the whole artist string OR any individual
// artist within it — used by search so "Artist B" finds a song tagged
// "Artist A; Artist B" even though it's not a leading substring of the
// raw combined string.
export function artistMatches(artistStr, separators, query) {
    const q = query.toLowerCase();
    if ((artistStr || '').toLowerCase().includes(q)) return true;
    return splitArtists(artistStr, separators).some(a => a.toLowerCase().includes(q));
}
