// Title ordering used everywhere (library scan, All Songs, playlist screens).
//  - Locale-aware: accents sort next to their base letter (é with e), not after z.
//  - Titles that start with something other than a letter or digit (emoji, punctuation,
//    symbols) go after everything else, so "A to Z" ends with them.
//  - Number-aware: any run of digits is compared as a number, and any non-digit
//    character separates numbers. "Song 2" comes before "Song 10", "2-b" before "10-a".
// Intl.Collator is created once; calling it is much cheaper than String.localeCompare,
// which builds a collator on every call.
let collator = null;
try { collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }); } catch { collator = null; }

let LETTER_OR_DIGIT;
try { LETTER_OR_DIGIT = new RegExp('^[\\p{L}\\p{N}]', 'u'); } catch { LETTER_OR_DIGIT = /^[A-Za-z0-9\u00C0-\u024F\u0370-\u1FFF\u3040-\u9FFF]/; }

// Computed once per song (not inside the sort comparator).
export function titleKey(title) {
    const t = String(title ?? '').replace(/^\s+/, '');
    return { t, g: LETTER_OR_DIGIT.test(t) ? 0 : 1 };
}

export function compareKeys(a, b) {
    if (a.g !== b.g) return a.g - b.g;
    if (collator) return collator.compare(a.t, b.t);
    return naturalCompare(a.t.toLowerCase(), b.t.toLowerCase());
}

// Used only when Intl.Collator is missing: splits into digit and non-digit chunks,
// compares digit chunks as numbers.
function naturalCompare(x, y) {
    const a = x.match(/\d+|\D+/g) || [];
    const b = y.match(/\d+|\D+/g) || [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const p = a[i], q = b[i];
        const pd = p.charCodeAt(0) >= 48 && p.charCodeAt(0) <= 57;
        const qd = q.charCodeAt(0) >= 48 && q.charCodeAt(0) <= 57;
        if (pd && qd) {
            const pn = p.replace(/^0+/, ''), qn = q.replace(/^0+/, '');
            if (pn.length !== qn.length) return pn.length < qn.length ? -1 : 1;
            if (pn !== qn) return pn < qn ? -1 : 1;
        } else if (p !== q) {
            return p < q ? -1 : 1;
        }
    }
    return a.length - b.length;
}

export function compareTitles(a, b) {
    return compareKeys(titleKey(a), titleKey(b));
}
