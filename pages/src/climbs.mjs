// Climb detection for elevation profiles.
//
// Pure module (no Sauce imports) so it can be unit tested with node.
//
// Rules follow the climb detection used by common bike computers:
//   - a climb is at least 500 m long with an average grade of at least 3%
//   - climb score = length (m) x average grade (%)  (which equals net gain (m) x 100)
//   - detection size: small >= 1500, medium >= 3500, large >= 8000
// Climbs may contain dips/short descents; the "ascent" of a climb counts all
// of the climbing (including re-climbing dips), not just the net gain.

export const DETECTION_SCORES = {
    small: 1500,
    medium: 3500,
    large: 8000,
};

export const CATEGORIES = [
    {id: 'hc', label: 'HC', minScore: 80000},
    {id: 'cat1', label: 'Cat 1', minScore: 64000},
    {id: 'cat2', label: 'Cat 2', minScore: 32000},
    {id: 'cat3', label: 'Cat 3', minScore: 16000},
    {id: 'cat4', label: 'Cat 4', minScore: 8000},
    {id: 'uncat', label: '', minScore: 0},
];

const DEFAULTS = {
    minScore: DETECTION_SCORES.small,
    minLength: 500,         // m
    minGrade: 0.03,         // 3%
    komMinGrade: 0.02,      // official segments named "KOM" count down to 2%
    step: 20,               // m, resample resolution
    smoothDistance: 100,    // m, moving average window for elevation
    dipGap: 400,            // m, max distance without a new high point before a climb part ends
    mergeGap: 400,          // m, gap allowed between two climb parts that get merged...
    mergeGapPerDipMeter: 40, // ...plus this many m per m of dip (a real dip takes longer to ride)
    flatSplitLength: 500,   // m, a flat section at least this long inside a climb splits it...
    flatSplitGrade: 0.015,  // ...when flatter than this...
    flatSplitRange: 8,      // ...and its height varies less than this (m), so dips are not flats
    trimWindow: 100,        // m, window used to trim flat ends off a climb
    trimGrade: 0.02,        // ends flatter than this (or half the climb's grade) are trimmed
};


export function climbCategory(score) {
    return CATEGORIES.find(x => score >= x.minScore);
}


/**
 * Resample a (distances, elevations) profile to a fixed step, smooth it and
 * precompute cumulative ascent.
 */
export function buildProfile(distances, elevations, {step=DEFAULTS.step,
                                                     smoothDistance=DEFAULTS.smoothDistance,
                                                     colorSmoothDistance=40}={}) {
    if (!distances || distances.length < 2 || distances.length !== elevations.length) {
        return null;
    }
    const start = distances[0];
    const end = distances[distances.length - 1];
    const n = Math.max(2, Math.floor((end - start) / step) + 1);
    const raw = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
        const x = start + i * step;
        while (j < distances.length - 2 && distances[j + 1] < x) {
            j++;
        }
        const d0 = distances[j];
        const d1 = distances[j + 1];
        let t = d1 > d0 ? (x - d0) / (d1 - d0) : 0;
        t = Math.min(1, Math.max(0, t));
        raw[i] = elevations[j] + (elevations[j + 1] - elevations[j]) * t;
    }
    // Centered moving average (shrinking window at the edges)
    const half = Math.max(0, Math.round(smoothDistance / step / 2));
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
        prefix[i + 1] = prefix[i] + raw[i];
    }
    const e = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - half);
        const hi = Math.min(n - 1, i + half);
        e[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
    // Light smoothing for coloring; climbing (asc) is summed from the unsmoothed data.
    const colorHalf = Math.max(0, Math.round(colorSmoothDistance / step / 2));
    const fine = new Float64Array(n);
    const asc = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - colorHalf);
        const hi = Math.min(n - 1, i + colorHalf);
        fine[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
        if (i) {
            asc[i] = asc[i - 1] + Math.max(0, raw[i] - raw[i - 1]);
        }
    }
    // e: smoothed, for detecting climbs. raw: unsmoothed, for every number shown
    // (gain, grades, climbing left) so they match the game. fine: lightly smoothed,
    // for coloring. asc: cumulative climbing from raw.
    return {start, end, step, e, raw, fine, asc, length: end - start};
}


function interp(arr, profile, distance) {
    const f = (distance - profile.start) / profile.step;
    if (f <= 0) {
        return arr[0];
    }
    if (f >= arr.length - 1) {
        return arr[arr.length - 1];
    }
    const i = Math.floor(f);
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}

// Unsmoothed elevation (what the game reports) at `distance`.
export function elevationAt(profile, distance) {
    return interp(profile.raw, profile, distance);
}

export function ascentAt(profile, distance) {
    return interp(profile.asc, profile, distance);
}

// Detailed grade around `distance` (lightly smoothed), for coloring the profile.
export function gradeAt(profile, distance, window=40) {
    const h = window / 2;
    return (interp(profile.fine, profile, distance + h) - interp(profile.fine, profile, distance - h)) / window;
}


function findCandidates(e, step, o) {
    const out = [];
    let s = 0;
    let pk = 0;
    for (let i = 1; i < e.length; i++) {
        if (e[i] > e[pk]) {
            pk = i;
            continue;
        }
        if (pk === s) {
            if (e[i] <= e[s]) {
                s = pk = i;
            }
            continue;
        }
        const gain = e[pk] - e[s];
        const drop = e[pk] - e[i];
        const dropTol = Math.min(40, Math.max(10, gain * 0.25));
        if (drop > dropTol || (i - pk) * step > o.dipGap) {
            out.push([s, pk]);
            let m = pk;
            for (let k = pk; k <= i; k++) {
                if (e[k] < e[m]) {
                    m = k;
                }
            }
            s = pk = m;
            for (let k = m; k <= i; k++) {
                if (e[k] > e[pk]) {
                    pk = k;
                }
            }
        }
    }
    if (pk > s) {
        out.push([s, pk]);
    }
    return out;
}


// Join climb parts that are separated by a dip, as long as the climb carries on
// higher afterwards and the dip is small compared to what was already climbed.
// Long flat sections keep parts separate; dips get more room the deeper they are.
function mergeDips(cands, e, step, o) {
    let merged = true;
    while (merged && cands.length > 1) {
        merged = false;
        for (let i = 0; i < cands.length - 1; i++) {
            const [s1, p1] = cands[i];
            const [s2, p2] = cands[i + 1];
            const gain1 = e[p1] - e[s1];
            const dip = e[p1] - e[s2];
            const climbStart2 = trim(e, step, s2, p2, o)[0];
            const gapAllowed = o.mergeGap + Math.max(0, dip) * o.mergeGapPerDipMeter;
            if (e[p2] > e[p1] &&
                dip <= Math.max(15, gain1 * 0.5) &&
                (climbStart2 - p1) * step <= gapAllowed) {
                cands.splice(i, 2, [s1, p2]);
                merged = true;
                break;
            }
        }
    }
    return cands;
}


// Trim flat-ish ends. "Flat" is relative to the climb: an end is trimmed when it
// is flatter than trimGrade or half of the climb's average grade.
function trim(e, step, a, b, o) {
    const w = Math.max(1, Math.round(o.trimWindow / step));
    for (let pass = 0; pass < 2; pass++) {
        const avg = b > a ? (e[b] - e[a]) / ((b - a) * step) : 0;
        const minGrade = Math.max(o.trimGrade, avg * 0.5);
        while (b - a > w && (e[a + w] - e[a]) / (w * step) < minGrade) {
            a++;
        }
        while (b - a > w && (e[b] - e[b - w]) / (w * step) < minGrade) {
            b--;
        }
    }
    return [a, b];
}


function passes(e, step, a, b, o) {
    const length = (b - a) * step;
    if (length < o.minLength) {
        return false;
    }
    const gain = e[b] - e[a];
    const grade = gain / length;
    return grade >= o.minGrade && gain * 100 >= o.minScore;
}


// Best (largest gain) sub-interval of [a, b] that qualifies as a climb.
function bestSubInterval(e, step, a, b, o) {
    const minPts = Math.ceil(o.minLength / step);
    let best = null;
    let bestGain = o.minScore / 100;
    for (let i = a; i <= b - minPts; i++) {
        for (let j = i + minPts; j <= b; j++) {
            const gain = e[j] - e[i];
            if (gain >= bestGain && gain / ((j - i) * step) >= o.minGrade) {
                if (gain > bestGain || !best || (j - i) < (best[1] - best[0])) {
                    best = [i, j];
                    bestGain = gain;
                }
            }
        }
    }
    return best;
}


// Flattest long, near-level window strictly inside [a, b], if any.
function findFlat(e, step, a, b, o) {
    const w = Math.round(o.flatSplitLength / step);
    let best = null;
    let bestGrade = Infinity;
    for (let i = a + 1; i + w < b; i++) {
        const grade = Math.abs(e[i + w] - e[i]) / (w * step);
        if (grade >= o.flatSplitGrade || grade >= bestGrade) {
            continue;
        }
        let min = Infinity;
        let max = -Infinity;
        for (let k = i; k <= i + w; k++) {
            min = Math.min(min, e[k]);
            max = Math.max(max, e[k]);
        }
        if (max - min < o.flatSplitRange) {
            best = i;
            bestGrade = grade;
        }
    }
    return best;
}


function extract(e, step, a, b, o, out, depth=0) {
    if ((b - a) * step < o.minLength || depth > 20) {
        return;
    }
    const flat = findFlat(e, step, a, b, o);
    if (flat != null) {
        // Split in the middle of the flat; trimming removes the flat halves
        // without cutting into a ramp.
        const mid = flat + Math.round(o.flatSplitLength / step / 2);
        extract(e, step, a, mid, o, out, depth + 1);
        extract(e, step, mid, b, o, out, depth + 1);
        return;
    }
    const [ta, tb] = trim(e, step, a, b, o);
    if (passes(e, step, ta, tb, o)) {
        out.push([ta, tb]);
        return;
    }
    const best = bestSubInterval(e, step, a, b, o);
    if (!best) {
        return;
    }
    const [i, j] = trim(e, step, best[0], best[1], o);
    extract(e, step, a, best[0], o, out, depth + 1);
    if (passes(e, step, i, j, o)) {
        out.push([i, j]);
    }
    extract(e, step, best[1], b, o, out, depth + 1);
}


function maxGradeOver(e, step, a, b, window=100) {
    const w = Math.max(1, Math.round(window / step));
    if (b - a <= w) {
        return (e[b] - e[a]) / ((b - a) * step || 1);
    }
    let max = -Infinity;
    for (let i = a; i + w <= b; i++) {
        max = Math.max(max, (e[i + w] - e[i]) / (w * step));
    }
    return max;
}


// Official climb segments (e.g. Zwift KOM segments): a segment that is a climb
// by the rules becomes a climb, joined with any detected climbing it overlaps.
// Official segments don't need the 500 m minimum length (e.g. Innsbruck's Leg
// Snapper KOM, 422 m at 6.9%), and ones named as a KOM count down to 2% average
// (e.g. Titans Grove KOM, 2.6 km at 2.2%). Others, such as a whole time-trial
// course segment, still need 3%. All need the score for the chosen size.
function segmentMinGrade(seg, o) {
    return /\bKOM\b/i.test(seg.name || '') ? Math.min(o.komMinGrade, o.minGrade) : o.minGrade;
}

// Segments only ever extend a climb, never shorten it. Segments that are not
// climbs (sprints, loops, very gentle segments) are ignored. Where qualifying
// segments overlap each other, the longest one is used.
function applySegments(ranges, segments, profile, o) {
    const {e, step} = profile;
    const n = e.length;
    const candidates = [];
    for (const seg of segments) {
        const a = Math.max(0, Math.round((seg.start - profile.start) / step));
        const b = Math.min(n - 1, Math.round((seg.end - profile.start) / step));
        if (b > a && passes(e, step, a, b, {...o, minLength: 0, minGrade: segmentMinGrade(seg, o)})) {
            candidates.push({a, b, seg});
        }
    }
    candidates.sort((x, y) => (y.b - y.a) - (x.b - x.a));
    const accepted = [];
    for (const c of candidates) {
        if (!accepted.some(x => Math.min(x.b, c.b) - Math.max(x.a, c.a) > 0)) {
            accepted.push(c);
        }
    }
    for (const {a, b, seg} of accepted) {
        const touching = ranges.filter(r => Math.min(r[1], b) - Math.max(r[0], a) > 0);
        const keepSeg = touching.find(r => r[2]);
        ranges = ranges.filter(r => !touching.includes(r));
        ranges.push([
            Math.min(a, ...touching.map(r => r[0])),
            Math.max(b, ...touching.map(r => r[1])),
            keepSeg ? keepSeg[2] : seg,
        ]);
    }
    return ranges;
}


/**
 * Detect climbs in a profile made by buildProfile().
 * options.segments: [{start, end, ...}] official climb segments (e.g. Zwift KOMs) on
 * the same distance scale. Climbs from a segment carry it as `climb.segment`.
 * Returns climbs sorted by start distance.
 */
export function detectClimbs(profile, options={}) {
    if (!profile) {
        return [];
    }
    const o = {...DEFAULTS, ...options};
    const {e, step} = profile;
    const cands = mergeDips(findCandidates(e, step, o), e, step, o);
    let ranges = [];
    for (const [a, b] of cands) {
        extract(e, step, a, b, o, ranges);
    }
    if (o.segments && o.segments.length) {
        ranges = applySegments(ranges, o.segments, profile, o);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    return ranges.map(([a, b, segment], index) => {
        const length = (b - a) * step;
        // Reported numbers use the unsmoothed elevation to match the game.
        const {raw} = profile;
        const gain = raw[b] - raw[a];
        const avgGrade = gain / length;
        const score = length * avgGrade * 100;
        return {
            index,
            start: profile.start + a * step,
            end: profile.start + b * step,
            length,
            gain,
            ascent: profile.asc[b] - profile.asc[a],
            avgGrade,
            maxGrade: maxGradeOver(raw, step, a, b),
            score,
            category: climbCategory(score),
            startElevation: raw[a],
            endElevation: raw[b],
            segment: segment || null,
        };
    }).filter(c => {
        // Found on the smoothed profile; make sure the shown (unsmoothed) numbers
        // also meet the rules, so a listed climb never shows e.g. 2.9%.
        return c.avgGrade >= (c.segment ? segmentMinGrade(c.segment, o) : o.minGrade) && c.score >= o.minScore &&
            (c.segment || c.length >= o.minLength);
    }).map((c, index) => ({...c, index}));
}


/**
 * Live numbers for a rider at `distance` relative to a climb.
 */
export function riderProgress(profile, climb, distance) {
    if (distance < climb.start) {
        return {
            state: 'approaching',
            toStart: climb.start - distance,
            remaining: climb.length,
            remainingAscent: climb.ascent,
            remainingGain: climb.gain,
            remainingGrade: climb.avgGrade,
            done: 0,
        };
    }
    const d = Math.min(distance, climb.end);
    const remaining = climb.end - d;
    const remainingGain = climb.endElevation - elevationAt(profile, d);
    return {
        state: 'climbing',
        toStart: 0,
        remaining,
        remainingAscent: Math.max(0, ascentAt(profile, climb.end) - ascentAt(profile, d)),
        remainingGain,
        remainingGrade: remaining > 0 ? remainingGain / remaining : 0,
        done: (d - climb.start) / climb.length,
    };
}


/**
 * The climb being ridden at `distance`, or else the next one ahead.
 */
export function currentOrNextClimb(climbs, distance) {
    return climbs.find(x => distance <= x.end) || null;
}


export function autoChunkLength(climbLength) {
    if (climbLength <= 1500) {
        return 100;
    } else if (climbLength <= 4000) {
        return 250;
    } else if (climbLength <= 10000) {
        return 500;
    }
    return 1000;
}


/**
 * Split a climb into roughly equal pieces about `chunkLength` long, each with its grade.
 */
export function climbChunks(profile, climb, chunkLength) {
    const count = Math.max(1, Math.round(climb.length / chunkLength));
    const size = climb.length / count;
    const chunks = [];
    for (let i = 0; i < count; i++) {
        const start = climb.start + i * size;
        const end = i === count - 1 ? climb.end : start + size;
        const grade = (elevationAt(profile, end) - elevationAt(profile, start)) / (end - start);
        chunks.push({start, end, grade});
    }
    return chunks;
}
