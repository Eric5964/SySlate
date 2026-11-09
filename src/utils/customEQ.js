// Custom (parametric) EQ: 10 bands, each with its own frequency, gain, Q and filter type.
// Kept apart from eq.js (the 10 fixed-frequency presets). Pure functions only, no storage here.

export const CUSTOM_BAND_COUNT = 10;
export const FREQ_MIN = 20;
export const FREQ_MAX = 20000;
export const GAIN_MIN = -12;
export const GAIN_MAX = 12;
export const Q_MIN = 0.1;
export const Q_MAX = 10;
export const FILTER_TYPES = ['peak', 'lowshelf', 'highshelf'];
export const FILTER_LABELS = { peak: 'Peak', lowshelf: 'Low shelf', highshelf: 'High shelf' };

const DEFAULT_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const DEFAULT_Q = 1.41;   // one octave wide, the same width the fixed presets use

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d) => { const m = Math.pow(10, d); return Math.round(v * m) / m; };

export const defaultCustomEQ = () => ({
    enabled: false,
    bands: DEFAULT_FREQS.map(f => ({ f, g: 0, q: DEFAULT_Q, t: 'peak' })),
});

// Anything that is not a clean custom EQ object comes back null; out-of-range numbers are clamped.
export function sanitizeCustomEQ(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.bands) || o.bands.length < 1 || o.bands.length > 64) return null;
    const base = defaultCustomEQ();
    const bands = base.bands.map((d, i) => {
        const b = o.bands[i];
        if (!b || typeof b !== 'object') return d;
        const f = Number(b.f), g = Number(b.g), q = Number(b.q);
        return {
            f: Number.isFinite(f) ? round(clamp(f, FREQ_MIN, FREQ_MAX), 1) : d.f,
            g: Number.isFinite(g) ? round(clamp(g, GAIN_MIN, GAIN_MAX), 2) : 0,
            q: Number.isFinite(q) ? round(clamp(q, Q_MIN, Q_MAX), 3) : d.q,
            t: FILTER_TYPES.includes(b.t) ? b.t : 'peak',
        };
    });
    return { enabled: !!o.enabled, bands };
}

// AVAudioUnitEQ's parametric filter takes a bandwidth in octaves, not a Q.
export const qToBandwidth = (q) => (2 / Math.LN2) * Math.asinh(1 / (2 * clamp(q, Q_MIN, Q_MAX)));

export function toNativeArrays(custom) {
    const c = sanitizeCustomEQ(custom) || defaultCustomEQ();
    return {
        freqs: c.bands.map(b => b.f),
        gains: c.bands.map(b => b.g),
        bws: c.bands.map(b => qToBandwidth(b.q)),
        types: c.bands.map(b => (b.t === 'lowshelf' ? 1 : b.t === 'highshelf' ? 2 : 0)),
    };
}

// The 10 fixed bands of a preset, written as custom bands (same frequencies, one octave wide).
export const bandsFromPreset = (gains) => DEFAULT_FREQS.map((f, i) => ({
    f, g: round(clamp(Number(gains?.[i]) || 0, GAIN_MIN, GAIN_MAX), 2), q: DEFAULT_Q, t: 'peak',
}));

// A saved parametric EQ lives in the normal custom preset list: { id, name, bands, param }.
// `bands` is the 10 gains clamped to the fixed presets' +-6 dB range (what an older build or the preset
// validators see), `param` is the full set of { f, g, q, t } bands the engine actually uses.
export function makeParamPreset(id, name, bands) {
    const clean = (sanitizeCustomEQ({ bands }) || defaultCustomEQ()).bands;
    return { id, name, bands: clean.map(b => round(clamp(b.g, -6, 6), 2)), param: clean };
}
export const presetParamBands = (preset) => (preset && Array.isArray(preset.param) ? (sanitizeCustomEQ({ bands: preset.param }) || null)?.bands ?? null : null);

// Slider mapping: frequency and Q move on a log scale (0..1 on the slider).
export const freqToPos = (f) => Math.log(clamp(f, FREQ_MIN, FREQ_MAX) / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN);
export const posToFreq = (p) => round(FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, clamp(p, 0, 1)), 1);
export const qToPos = (q) => Math.log(clamp(q, Q_MIN, Q_MAX) / Q_MIN) / Math.log(Q_MAX / Q_MIN);
export const posToQ = (p) => round(Q_MIN * Math.pow(Q_MAX / Q_MIN, clamp(p, 0, 1)), 2);
export const formatFreq = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz` : `${Math.round(f)} Hz`);

// ---- Frequency response (RBJ biquads, 48 kHz), used to turn bands into a GraphicEQ curve ----
function biquadMagDb(b, f) {
    const fs = 48000;
    const A = Math.pow(10, b.g / 40);
    const w0 = 2 * Math.PI * clamp(b.f, FREQ_MIN, FREQ_MAX) / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (b.t === 'lowshelf' || b.t === 'highshelf') {
        const alpha = sw / 2 * Math.SQRT2;   // slope 1
        const sA = 2 * Math.sqrt(A) * alpha;
        if (b.t === 'lowshelf') {
            b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
            a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
        } else {
            b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
            a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
        }
    } else {
        const alpha = sw / (2 * clamp(b.q, Q_MIN, Q_MAX));
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    }
    const w = 2 * Math.PI * f / fs;
    const c1 = Math.cos(w), c2 = Math.cos(2 * w);
    const num = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * c1 + 2 * b0 * b2 * c2;
    const den = a0 * a0 + a1 * a1 + a2 * a2 + 2 * (a0 * a1 + a1 * a2) * c1 + 2 * a0 * a2 * c2;
    return 10 * Math.log10(Math.max(num, 1e-12) / Math.max(den, 1e-12));
}
export const responseDb = (bands, f) => bands.reduce((sum, b) => sum + biquadMagDb(b, f), 0);

const GRAPHIC_POINTS = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

// ---- Export ----
const num = (v, d = 1) => (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toString();

// Equalizer APO / AutoEq "GraphicEQ" line, sampled from the bands' real response.
export function exportGraphicEQ(bands, preAmpDb = 0) {
    const pts = GRAPHIC_POINTS.map(f => `${f} ${num(responseDb(bands, f), 1)}`).join('; ');
    return `# SySlate EQ (Equalizer APO GraphicEQ)\nPreamp: ${num(preAmpDb, 1)} dB\nGraphicEQ: ${pts}\n`;
}

// Equalizer APO parametric filter list.
export function exportParametricEQ(bands, preAmpDb = 0) {
    const lines = bands.map((b, i) => {
        const type = b.t === 'lowshelf' ? 'LSC' : b.t === 'highshelf' ? 'HSC' : 'PK';
        return `Filter ${i + 1}: ON ${type} Fc ${num(b.f, 1)} Hz Gain ${num(b.g, 2)} dB Q ${num(b.q, 3)}`;
    });
    return `# SySlate EQ (Equalizer APO parametric)\nPreamp: ${num(preAmpDb, 1)} dB\n${lines.join('\n')}\n`;
}

export function exportSySlateEQ({ customPresets = [], overrides = {}, preAmp = 0 }) {
    return JSON.stringify({ syslateEQ: 1, preAmp, customPresets, overrides }, null, 2);
}

// ---- Import ----
function interpGraphic(points, f) {
    if (!points.length) return 0;
    if (f <= points[0][0]) return points[0][1];
    if (f >= points[points.length - 1][0]) return points[points.length - 1][1];
    for (let i = 1; i < points.length; i++) {
        if (f <= points[i][0]) {
            const [f0, g0] = points[i - 1], [f1, g1] = points[i];
            const t = f1 === f0 ? 0 : Math.log(f / f0) / Math.log(f1 / f0);
            return g0 + (g1 - g0) * t;
        }
    }
    return 0;
}

// Returns { kind, ... } or { kind: 'error', message }.
//   kind 'syslate'    : { customPresets, overrides, custom, preAmp }
//   kind 'graphic'    : { bands (custom bands), preAmp, points }
//   kind 'parametric' : { bands (custom bands), preAmp, skipped }
export function parseEQText(text) {
    if (typeof text !== 'string' || !text.trim()) return { kind: 'error', message: 'Nothing to import.' };
    if (text.length > 2 * 1024 * 1024) return { kind: 'error', message: 'That is too large to be an EQ file.' };
    const t = text.trim();
    const preM = t.match(/Preamp:\s*(-?[\d.]+)\s*dB/i);
    const preAmp = preM ? clamp(parseFloat(preM[1]) || 0, -12, 12) : null;

    if (t[0] === '{') {
        let obj;
        try { obj = JSON.parse(t); } catch { return { kind: 'error', message: 'That looks like JSON but could not be read.' }; }
        if (!obj || obj.syslateEQ !== 1) return { kind: 'error', message: 'That JSON is not a SySlate EQ export.' };
        const customPresets = Array.isArray(obj.customPresets)
            ? obj.customPresets.filter(p => p && typeof p.name === 'string' && p.name.length <= 80 && Array.isArray(p.bands) && p.bands.length === 10 && p.bands.every(v => Number.isFinite(v))).slice(0, 100)
                .map(p => {
                    const param = Array.isArray(p.param) ? sanitizeCustomEQ({ bands: p.param })?.bands : null;
                    const out = { id: String(p.id || ''), name: p.name, bands: p.bands.map(v => clamp(v, -6, 6)) };
                    if (param) out.param = param;
                    return out;
                })
            : [];
        const overrides = {};
        if (obj.overrides && typeof obj.overrides === 'object') {
            for (const [k, v] of Object.entries(obj.overrides)) {
                if (k.length <= 40 && Array.isArray(v) && v.length === 10 && v.every(x => Number.isFinite(x))) overrides[k] = v.map(x => clamp(x, -6, 6));
            }
        }
        const custom = sanitizeCustomEQ(obj.customEQ);
        const pa = Number.isFinite(Number(obj.preAmp)) ? clamp(Number(obj.preAmp), -12, 12) : null;
        return { kind: 'syslate', customPresets, overrides, custom, preAmp: pa };
    }

    const g = t.match(/GraphicEQ:\s*([^\n\r]+)/i);
    if (g) {
        const points = g[1].split(';').map(p => p.trim().split(/\s+/).map(Number)).filter(p => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > 0).sort((a, b) => a[0] - b[0]);
        if (points.length < 2) return { kind: 'error', message: 'No usable GraphicEQ points found.' };
        const bands = DEFAULT_FREQS.map(f => ({ f, g: round(clamp(interpGraphic(points, f), GAIN_MIN, GAIN_MAX), 2), q: DEFAULT_Q, t: 'peak' }));
        return { kind: 'graphic', bands, preAmp, points: points.length };
    }

    // Equalizer APO / Peace / AutoEq filter lines. Tolerates a decimal comma ("Fc 1000,5 Hz"), a missing
    // index, and a width given as "BW Oct 0.5" (octaves) instead of Q.
    const filterRe = /Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Za-z]+)\s+Fc\s+([\d.,]+)\s*(?:Hz)?(?:\s+Gain\s+(-?[\d.,]+)\s*(?:dB)?)?(?:\s+Q\s+([\d.,]+))?(?:\s+BW\s+Oct\s+([\d.,]+))?/gi;
    const nf = (x) => parseFloat(String(x).replace(',', '.'));
    const found = [];
    let skipped = 0, m;
    while ((m = filterRe.exec(t)) !== null) {
        if (m[1].toUpperCase() !== 'ON') continue;
        const kind = m[2].toUpperCase();
        const ft = kind === 'PK' || kind === 'PEQ' || kind === 'MODAL' ? 'peak' : /^LS/.test(kind) ? 'lowshelf' : /^HS/.test(kind) ? 'highshelf' : null;
        if (!ft) { skipped++; continue; }
        let q = m[5] != null ? nf(m[5]) : 0.707;
        if (m[5] == null && m[6] != null) { const bw = nf(m[6]); if (bw > 0) q = 1 / (2 * Math.sinh((Math.LN2 / 2) * bw)); }
        found.push({ f: round(clamp(nf(m[3]), FREQ_MIN, FREQ_MAX), 1), g: round(clamp(nf(m[4] ?? '0') || 0, GAIN_MIN, GAIN_MAX), 2), q: round(clamp(q || 0.707, Q_MIN, Q_MAX), 3), t: ft });
    }
    if (found.length) {
        const extra = Math.max(0, found.length - CUSTOM_BAND_COUNT);
        const chosen = found.slice(0, CUSTOM_BAND_COUNT);
        const defaults = defaultCustomEQ().bands;
        const bands = [...chosen, ...defaults.slice(chosen.length)];
        return { kind: 'parametric', bands, preAmp, skipped: skipped + extra, count: chosen.length };
    }

    // Generic tables: "freq gain" per line (REW, Poweramp, spreadsheets; space, tab, comma or semicolon).
    const rows = t.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[#*;/]/.test(l)).map(l => l.split(/[\s,;\t]+/).map(Number));
    const pairs = rows.filter(r => r.length === 2 && r.every(Number.isFinite) && r[0] >= 10 && r[0] <= 40000);
    if (pairs.length >= 3 && pairs.length >= rows.length - 2) {
        const points = pairs.sort((a, b) => a[0] - b[0]);
        const bands = DEFAULT_FREQS.map(f => ({ f, g: round(clamp(interpGraphic(points, f), GAIN_MIN, GAIN_MAX), 2), q: DEFAULT_Q, t: 'peak' }));
        return { kind: 'graphic', bands, preAmp, points: points.length };
    }
    // Just ten gains (one per band), as a list: "[1, 2, 0, ...]" or ten numbers separated by anything.
    const nums = (t.match(/-?\d+(?:[.,]\d+)?/g) || []).map(nf);
    if (nums.length === 10 && !/[A-DF-Za-df-z]/.test(t.replace(/[eE]\d/g, ''))) {
        return { kind: 'graphic', bands: bandsFromPreset(nums), preAmp, points: 10 };
    }
    return { kind: 'error', message: 'Not recognised. Paste a SySlate EQ export, a GraphicEQ line, APO / AutoEq "Filter 1: ON PK Fc ..." lines, a "frequency gain" table, or ten band gains.' };
}
