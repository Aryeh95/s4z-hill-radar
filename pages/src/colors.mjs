// Gradient color schemes.
//
// "sauce", "vv", "cvdBuRd", "cvdPRGn" and "cvdSunset" follow the schemes in
// Zenmaster's S4Z mods (https://github.com/Zenmaster28/Zenmaster-s4z-mods, GPL-3.0).
// "classic" uses the familiar green / yellow / orange / red / dark red bands.
// Grades are fractions (0.05 = 5%).

export const SCHEMES = [
    {id: 'classic', label: 'Classic (green to dark red)'},
    {id: 'sauce', label: 'Sauce'},
    {id: 'vv', label: 'Veloviewer (ish)'},
    {id: 'cvdBuRd', label: 'CVD-BuRd'},
    {id: 'cvdPRGn', label: 'CVD-PRGn'},
    {id: 'cvdSunset', label: 'CVD-Sunset'},
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
// red (~10.5%) to dark red (14%+). Descents are blue-grey.
const classicStops = [
    [-0.06, 210, 0.3, 0.5],
    [-0.005, 200, 0.15, 0.55],
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


/**
 * Returns a CSS color for a grade (fraction) in the given scheme.
 */
export function gradeColor(grade, scheme='classic', alpha=1) {
    if (!Number.isFinite(grade)) {
        grade = 0;
    }
    if (scheme === 'sauce') {
        const steep = Math.min(1, Math.abs(grade) / 0.12);
        const c = rgbToHsl(steep, 0.4, 0.5 * steep);
        return hsl(c.h, c.s + steep - 0.33, c.l - 0.25, alpha);
    } else if (scheme === 'vv') {
        const g = Math.min(0.999, Math.max(-0.999, grade));
        const r = vvRanges.find(x => g >= x.min && g < x.max) || vvRanges[4];
        const f = (g - r.min) / (r.max - r.min);
        return hsl(r.hMin + f * (r.hMax - r.hMin), r.s, r.l, alpha);
    } else if (cvdRanges[scheme]) {
        const c = interpolateRanges(grade, cvdRanges[scheme]);
        return hsl(c.h, c.s, c.l, alpha);
    }
    const c = classicColor(grade);
    return hsl(c.h, c.s, c.l, alpha);
}
