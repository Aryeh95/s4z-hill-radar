// Fallback names for detected climbs that have no official segment.
// Pure module (no Sauce imports).

import {brianMudgeClimbs, extraClimbs, climbShapes} from './climb-names.mjs';

/**
 * Normalize a route name so small differences still match, e.g.
 * "2022 gran fondo" / "Zwift Gran Fondo 2022", "2015 uci worlds course" / "2015 Worlds Course",
 * "yorkshire double loops" / "Yorkshire Double Loop".
 */
export function routeKey(name) {
    let s = (name || '').toLowerCase();
    const year = (s.match(/\b20\d\d\b/) || [''])[0];
    s = s.replace(/\b20\d\d\b/g, '')
        .replace(/\b(zwift|uci)\b/g, '')
        .replace(/[^a-z0-9]/g, '')
        .replace(/s$/, '');
    return s + year;
}

const byRoute = new Map();
for (const [route, name, start, length] of [...extraClimbs, ...brianMudgeClimbs]) {
    const key = routeKey(route);
    if (!byRoute.has(key)) {
        byRoute.set(key, []);
    }
    byRoute.get(key).push({name, start, length});
}


/**
 * Name for `climb` ({start, end, length}) on the route `routeName`, or null.
 * `laps` is the course lap list ({lapStart}) so named climbs repeat on every lap;
 * entry starts are measured from the start of the ride (first lap).
 */
export function fallbackClimbName(routeName, climb, laps) {
    const list = byRoute.get(routeKey(routeName));
    if (!list) {
        return null;
    }
    const lapList = laps && laps.length ? laps : [{lapStart: 0}];
    const firstLapStart = lapList[0].lapStart || 0;
    let best = null;
    let bestOverlap = 0;
    for (const [i, lap] of lapList.entries()) {
        for (const x of list) {
            if (i > 0 && x.start < firstLapStart) {
                continue;  // in the lead-in, which is only ridden once
            }
            const a = i === 0 ? x.start : lap.lapStart + (x.start - firstLapStart);
            const b = a + x.length;
            const overlap = Math.min(b, climb.end) - Math.max(a, climb.start);
            if (overlap > 0 && overlap >= 0.5 * Math.min(x.length, climb.length) && overlap > bestOverlap) {
                best = x.name;
                bestOverlap = overlap;
            }
        }
    }
    return best;
}


// The same climb looks the same on every route: start and end elevation, length and the shape
// of the climb (elevation gained at each tenth). Matching that against the named climbs'
// fingerprints names a climb on routes the name list doesn't cover (e.g. new routes). Only a
// single clear match counts: two names for the same shape (the same road both ways, or names
// that differ between routes) leave the climb unnamed rather than guess.
const shapeTolerance = {elevation: 3, length: 0.10, shape: 1};

/**
 * climb: {startElevation, endElevation, length, shape: [11 elevations gained, from 0 to the top]}
 */
export function climbNameByShape(courseId, climb, shapes=climbShapes) {
    if (courseId == null || !climb || !Array.isArray(climb.shape) || climb.shape.length !== 11) {
        return null;
    }
    const names = new Set();
    for (const [course, name, start, end, length, shape] of shapes) {
        if (course !== courseId ||
            Math.abs(start - climb.startElevation) > shapeTolerance.elevation ||
            Math.abs(end - climb.endElevation) > shapeTolerance.elevation ||
            Math.abs(length - climb.length) / length > shapeTolerance.length) {
            continue;
        }
        let sq = 0;
        for (let i = 0; i < 11; i++) {
            sq += (shape[i] - climb.shape[i]) ** 2;
        }
        if (Math.sqrt(sq / 11) <= shapeTolerance.shape) {
            names.add(name);
        }
    }
    return names.size === 1 ? names.values().next().value : null;
}
