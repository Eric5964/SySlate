// Deterministic color per playlist name — shared so PlaylistsScreen, the mini
// player, and the full player all agree on the same "cover" tint for a given
// playlist, even when no custom cover image has been set.
const PALETTE = ['#7c3aed', '#2563eb', '#0891b2', '#16a34a', '#eab308', '#ea580c', '#dc2626', '#db2777', '#9ca3af'];

export function playlistColor(name = '') {
    let h = 5381;
    for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
    return PALETTE[Math.abs(h) % PALETTE.length];
}

function hexToRgb(hex) {
    const m = hex.replace('#', '');
    const bigint = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}

// Layered rgba stops to fake a top-down gradient without adding a native
// gradient dependency. Returns an array of {height, color} bands, darkest/
// most opaque at the very top, fading to fully transparent.
export function gradientBands(hex, opacities = [0.55, 0.4, 0.26, 0.14, 0.06, 0]) {
    const { r, g, b } = hexToRgb(hex);
    return opacities.map(a => `rgba(${r},${g},${b},${a})`);
}

// Blend two #rrggbb colors: t = 0 gives `a`, t = 1 gives `b`. Anything that is not a plain
// hex color comes back as `a` untouched.
export function mixHex(a, b, t) {
    try {
        if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(a) || !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(b)) return a;
        const x = hexToRgb(a), y = hexToRgb(b);
        const ch = (p, q) => Math.round(p + (q - p) * t).toString(16).padStart(2, '0');
        return `#${ch(x.r, y.r)}${ch(x.g, y.g)}${ch(x.b, y.b)}`;
    } catch { return a; }
}
