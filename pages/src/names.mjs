// Fallback names for detected climbs that have no official segment.
// Pure module (no Sauce imports).

import {brianMudgeClimbs, extraClimbs} from './climb-names.mjs';

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
