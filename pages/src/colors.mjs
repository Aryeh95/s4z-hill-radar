// Gradient color schemes.
//
// "sauce", "vv", "cvdBuRd", "cvdPRGn" and "cvdSunset" follow the schemes in
// Zenmaster's S4Z mods (https://github.com/Zenmaster28/Zenmaster-s4z-mods, GPL-3.0).
// "classic" uses the familiar green / yellow / orange / red / dark red bands.
// "barberfish" is the grade palette of the Barberfish Karoo extension
// (https://github.com/jpweytjens/barberfish, Apache-2.0).
// Grades are fractions (0.05 = 5%).

export const SCHEMES = [
    {id: 'classic', label: 'Classic (green to dark red)'},
    {id: 'sauce', label: 'Sauce'},
    {id: 'vv', label: 'Veloviewer (ish)'},
    {id: 'cvdBuRd', label: 'CVD-BuRd'},
    {id: 'cvdPRGn', label: 'CVD-PRGn'},
    {id: 'cvdSunset', label: 'CVD-Sunset'},
    {id: 'barberfish', label: 'Barberfish'},
];

function hsl(h, s, l, a=1) {
    const clamp = x => Math.min(1, Math.max(0, x));
    return `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp(s) * 100)}% ` +
           `${Math.round(clamp(l) * 100)}% / ${clamp(a)})`;
}

function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) {
        return {h: 0, s: 0, l};
    }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) {
        h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
        h = (b - r) / d + 2;
    } else {
        h = (r - g) / d + 4;
    }
    return {h: h * 60, s, l};
}

// Classic: blends from green (flat) through yellow (~4.5%), orange (~7.5%),
// red (~10.5%) to dark red (14%+). Descents go from pale blue-grey through
// blue to deep navy (14%+ down), getting darker as they get steeper.
const classicStops = [
    [-0.14, 240, 0.55, 0.28],
    [-0.10, 228, 0.6, 0.36],
    [-0.07, 215, 0.65, 0.44],
    [-0.04, 205, 0.6, 0.5],
    [-0.02, 198, 0.45, 0.55],
    [-0.005, 195, 0.2, 0.6],
    [0.0, 125, 0.55, 0.4],
    [0.025, 95, 0.65, 0.42],
    [0.045, 52, 0.95, 0.5],
    [0.075, 30, 0.95, 0.5],
    [0.105, 0, 0.85, 0.48],
    [0.14, -15, 0.85, 0.28],
];

function classicColor(grade) {
    const st = classicStops;
    const g = Math.min(st[st.length - 1][0], Math.max(st[0][0], grade));
    let i = 0;
    while (i < st.length - 2 && g >= st[i + 1][0]) {
        i++;
    }
    const lo = st[i];
    const hi = st[i + 1];
    const f = (g - lo[0]) / (hi[0] - lo[0]);
    const mix = k => lo[k] + (hi[k] - lo[k]) * f;
    return {h: mix(1), s: mix(2), l: mix(3)};
}

const vvRanges = [
    {min: -1, max: -0.17, hMin: 250, hMax: 250, s: 1, l: 0.5},
    {min: -0.17, max: -0.09, hMin: 250, hMax: 200, s: 1, l: 0.5},
    {min: -0.09, max: -0.04, hMin: 200, hMax: 190, s: 1, l: 0.5},
    {min: -0.04, max: 0.00, hMin: 190, hMax: 175, s: 1, l: 0.5},
    {min: 0.00, max: 0.025, hMin: 100, hMax: 60, s: 0.75, l: 0.5},
    {min: 0.025, max: 0.085, hMin: 60, hMax: 40, s: 1, l: 0.5},
    {min: 0.085, max: 0.105, hMin: 39, hMax: 20, s: 1, l: 0.5},
    {min: 0.105, max: 0.15, hMin: 19, hMax: 0, s: 1, l: 0.4},
    {min: 0.15, max: 0.25, hMin: 1, hMax: 0, s: 1, l: 0.25},
    {min: 0.25, max: 1, hMin: 0, hMax: 0, s: 1, l: 0.25},
];

const cvdRanges = {
    cvdBuRd: [
        [-0.5, 33, 102, 172], [-0.17, 67, 147, 195], [-0.09, 146, 197, 222], [-0.04, 209, 229, 240],
        [0.00, 247, 247, 247], [0.015, 253, 219, 199], [0.055, 244, 165, 130], [0.105, 214, 96, 77],
        [0.17, 178, 24, 43], [0.5, 255, 238, 153],
    ],
    cvdPRGn: [
        [-0.5, 118, 42, 131], [-0.17, 153, 112, 171], [-0.09, 194, 165, 207], [-0.04, 231, 212, 232],
        [0.00, 247, 247, 247], [0.015, 217, 240, 211], [0.055, 172, 211, 158], [0.105, 90, 174, 97],
        [0.17, 27, 120, 55], [0.5, 255, 238, 153],
    ],
    cvdSunset: [
        [-0.5, 54, 75, 154], [-0.17, 74, 123, 183], [-0.09, 152, 202, 225], [-0.04, 194, 228, 239],
        [0.00, 255, 255, 191], [0.015, 254, 218, 139], [0.055, 246, 126, 75], [0.105, 221, 61, 45],
        [0.17, 165, 0, 38], [0.5, 255, 255, 255],
    ],
};

// Barberfish: fixed bands (lowest grade of each band, color), from navy descents through a
// flat green band (-2% to 2%) to purple at 20%+. The text colors are Barberfish's own
// lighter versions for reading on a dark background.
const barberfishBands = [
    [0.20, 0x7404A8, 0xC06FFE],
    [0.14, 0xD7040A, 0xFE5A5B],
    [0.11, 0xEA6607, 0xF26A08],
    [0.08, 0xEC990C, 0xEC990C],
    [0.05, 0xF5E313, 0xF5E313],
    [0.02, 0xB2D40F, 0xB2D40F],
    [-0.02, 0x5CC066, 0x5CC066],
    [-0.06, 0x3298C4, 0x359FCC],
    [-0.10, 0x1A74B3, 0x269AEB],
    [-Infinity, 0x104F89, 0x3397FA],
];

function barberfishHsl(grade, text) {
    const band = barberfishBands.find(([min]) => grade >= min - 1e-9);
    const rgb = band[text ? 2 : 1];
    return rgbToHsl((rgb >> 16) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255);
}

function interpolateRanges(grade, ranges) {
    const g = Math.min(ranges[ranges.length - 1][0], Math.max(ranges[0][0], grade));
    let i = 0;
    while (i < ranges.length - 2 && g >= ranges[i + 1][0]) {
        i++;
    }
    const lo = ranges[i];
    const hi = ranges[i + 1];
    const f = (g - lo[0]) / (hi[0] - lo[0]);
    const c = k => (lo[k] + (hi[k] - lo[k]) * f) / 255;
    return rgbToHsl(c(1), c(2), c(3));
}


function gradeHsl(grade, scheme, text=false) {
    if (!Number.isFinite(grade)) {
        grade = 0;
    }
    if (scheme === 'sauce') {
        const steep = Math.min(1, Math.abs(grade) / 0.12);
        const c = rgbToHsl(steep, 0.4, 0.5 * steep);
        return {h: c.h, s: c.s + steep - 0.33, l: c.l - 0.25};
    } else if (scheme === 'vv') {
        const g = Math.min(0.999, Math.max(-0.999, grade));
        const r = vvRanges.find(x => g >= x.min && g < x.max) || vvRanges[4];
        const f = (g - r.min) / (r.max - r.min);
        return {h: r.hMin + f * (r.hMax - r.hMin), s: r.s, l: r.l};
    } else if (cvdRanges[scheme]) {
        return interpolateRanges(grade, cvdRanges[scheme]);
    } else if (scheme === 'barberfish') {
        return barberfishHsl(grade, text);
    }
    return classicColor(grade);
}

/**
 * Returns a CSS color for a grade (fraction) in the given scheme.
 */
export function gradeColor(grade, scheme='classic', alpha=1) {
    const c = gradeHsl(grade, scheme);
    return hsl(c.h, c.s, c.l, alpha);
}

// HSL (0-360, 0-1, 0-1) to RGB (0-1)
function hslToRgb(h, s, l) {
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return [0, 8, 4].map(n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
}

function luminance([r, g, b]) {
    const f = c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio between two RGB (0-1) colors (1 to 21). */
export function contrastRatio(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

/**
 * The color seen through a CSS rgb()/rgba() background (e.g. from getComputedStyle) as RGB
 * (0-1), or null. A see-through panel shows the game behind it, taken as mid grey; a mostly
 * see-through one (alpha under minAlpha) gives null, as what's behind it can't be known.
 */
export function parseRgb(css, minAlpha=0.35, behind=0.45) {
    const m = String(css || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
    const a = m && m[4] != null ? Number(m[4]) : 1;
    if (!m || a < minAlpha) {
        return null;
    }
    return [m[1], m[2], m[3]].map(x => x / 255 * a + behind * (1 - a));
}

const minTextContrast = 4.5;  // WCAG AA for normal text; the panel is often see-through

/**
 * The grade's color for text (e.g. the grade number). On a known background (RGB 0-1) the
 * scheme's color keeps its hue and only its lightness moves, as little as needed to read at
 * 4.5:1 or better: darker on light themes, lighter on dark ones. Without one, a dark background
 * is assumed.
 */
export function gradeTextColor(grade, scheme='classic', background=null) {
    const c = gradeHsl(grade, scheme, true);
    const s = Math.min(1, c.s);
    if (!background) {
        return hsl(c.h, s, scheme === 'barberfish' ? c.l : Math.max(0.55, c.l));
    }
    // Checked as written (whole-number hue and percentages), so rounding can't tip it under
    const r = x => Math.round(x * 100) / 100;
    const ok = l => contrastRatio(hslToRgb(Math.round(c.h), r(s), r(l)), background) >= minTextContrast;
    if (ok(c.l)) {
        return hsl(c.h, s, c.l);
    }
    // Lighter on backgrounds white reads better on, else darker; the other way if that can't work
    const lighter = contrastRatio([1, 1, 1], background) >= contrastRatio([0, 0, 0], background);
    for (const dir of lighter ? [1, -1] : [-1, 1]) {
        for (let d = 0.01; d <= 1; d += 0.01) {
            const l = c.l + dir * d;
            if (l < 0 || l > 1) {
                break;
            }
            if (ok(l)) {
                return hsl(c.h, s, l);
            }
        }
    }
    return lighter ? hsl(0, 0, 1) : hsl(0, 0, 0);
}
