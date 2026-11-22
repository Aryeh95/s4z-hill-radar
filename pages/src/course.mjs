// The course being ridden (route laps, event finish, road sections) and where riders are on it.
// Pure module (no Sauce imports), so it can be tested in Node.

/**
 * Lay out a route as ridden: the first lap with its lead-in, then further laps (with the weld
 * between laps, if any). Free rides are planned `minLaps` ahead; events to their finish (laps or
 * distance), then on past it the same way, for riding on after the event ends.
 *
 * route: Sauce's getRoute() result. segmentNames: Map of segment id -> name (named ones only).
 * Returns {distances, elevations, laps, finish, segments, sections, checkpoints, lapLength}.
 */
export function assembleRoute(route, {eventLaps=null, distance=null, minLaps=1, segmentNames=new Map()}={}) {
    let laps;
    if (distance) {
        laps = route.supportedLaps ? 1000 : 1;
    } else if (eventLaps) {
        laps = route.supportedLaps ? Math.max(eventLaps, minLaps) : eventLaps;
    } else {
        laps = minLaps;
    }
    const distances = Array.from(route.distances);
    const elevations = Array.from(route.elevations);
    let lapStartIndex = 0;
    if (route.sections && route.curvePath && route.curvePath.nodes) {
        const lapSectIdx = route.sections.findIndex(x => !x.leadin && !x.weld);
        const idx = route.curvePath.nodes.findIndex(x => x.index === lapSectIdx);
        if (idx > 0) {
            lapStartIndex = idx;
        }
    }
    const preludeDist = distances[lapStartIndex];
    const lapDistances = distances.slice(lapStartIndex).map(x => x - preludeDist);
    const lapElevations = elevations.slice(lapStartIndex);
    const weld = route.lapWeldData;
    const weldLength = weld && weld.distances ? weld.distances[weld.distances.length - 1] : 0;
    const lapList = [{offset: 0, distance: distances[distances.length - 1], lapStart: preludeDist}];
    for (let lap = 1; lap < laps && !(distance && distances[distances.length - 1] >= distance && lap >= minLaps); lap++) {
        const offset = distances[distances.length - 1];
        if (weld && weld.distances) {
            for (let i = 0; i < weld.distances.length; i++) {
                distances.push(offset + weld.distances[i]);
                elevations.push(weld.elevations[i]);
            }
        }
        const lapOffset = distances[distances.length - 1];
        for (let i = 0; i < lapDistances.length; i++) {
            distances.push(lapOffset + lapDistances[i]);
            elevations.push(lapElevations[i]);
        }
        lapList.push({offset, distance: distances[distances.length - 1] - offset,
                      lapStart: offset + weldLength});
    }
    for (const lap of lapList) {
        lap.fullDistance = lap.distance;  // untruncated, for positioning by distance left in the lap
    }
    // Where the event finishes. The course goes on past it, for riding on after the event ends.
    let finish = null;
    if (distance) {
        finish = Math.min(distance, distances[distances.length - 1]);
    } else if (eventLaps) {
        const last = lapList[Math.min(eventLaps, lapList.length) - 1];
        finish = last.offset + last.distance;
    }
    // Named segments (KOMs etc.) for naming climbs, on every lap
    const routeSegments = (route.segments || []).filter(x => !x.weldOnly);
    const segments = [];
    for (const [i, lap] of lapList.entries()) {
        for (const x of routeSegments) {
            if (i > 0 && x.leadinOnly) {
                continue;
            }
            const start = lap.lapStart + x.offset;
            if (segmentNames.has(x.id) && start < distances[distances.length - 1]) {
                segments.push({name: segmentNames.get(x.id), start, end: start + x.distance});
            }
        }
    }
    // Road sections (index = the route manifest entry), and which section each of the game's
    // route checkpoints is in, like Sauce uses to place the rider.
    const sections = (route.sections || []).map((x, index) => ({...x, index}))
        .filter(x => x.roadCurvePath && !x.weld);
    const checkpoints = new Map();
    for (const [i, m] of (route.manifest || []).entries()) {
        if (m.checkpoints) {
            for (let idx = m.checkpoints[0]; idx <= m.checkpoints[1]; idx++) {
                checkpoints.set(idx, i);
            }
        }
    }
    return {distances, elevations, laps: lapList, finish, segments, sections, checkpoints,
            lapLength: lapDistances[lapDistances.length - 1]};
}


/** Course key without the planned lap count (same route, same ride). */
export function baseKey(key) {
    return key ? key.replace(/^((?:route|event):[^:]+):\d+$/, '$1') : key;
}


/** Rider's distance along a route section, like Sauce does it, or undefined. */
export function sectionDistance(section, state) {
    if (section.roadId !== state.roadId || !section.reverse !== !state.reverse) {
        return;
    }
    const p = (state.roadTime - 5000) / 1e6;
    if (!(p - section.start > -2e-3 && section.end - p > -2e-3)) {
        return;
    }
    const rcp = section.roadCurvePath;
    if (typeof rcp.distanceAtRoadPercent !== 'function') {
        return;
    }
    const clamped = Math.min(section.end, Math.max(section.start, p));
    const d = rcp.distanceAtRoadPercent(clamped) / 100;
    return section.reverse ? section.distance - d : d;
}


/**
 * The watched rider's distance along a route course: {pos, source}, pos null if unknown.
 * recent: where the rider was a moment ago on this course (or null), to choose between places
 * where the route uses the same road more than once.
 */
export function routePosition(course, state, recent=null) {
    const lapIdx = Math.min(state.laps || 0, course.laps.length - 1);
    const lap = course.laps[lapIdx];
    // 1. Sauce's own route distance
    if (state.routeDistance != null && state.routeEnd != null &&
        (!state.routeId || state.routeId === course.routeId)) {
        // The lap finish line is fixed, so use the distance left in the lap.
        return {pos: lap.offset + lap.fullDistance - (state.routeEnd - state.routeDistance), source: 'sauce'};
    }
    // 2. Estimate from the game's lap progress (0-1)
    let estimate;
    if (Number.isFinite(state.progress) && state.progress > 0) {
        estimate = lapIdx === 0 ?
            state.progress * lap.distance :
            lap.lapStart + state.progress * course.lapLength;
    }
    // 3. Find the rider's road section on the route. The same road can be used more
    //    than once (e.g. the lead-in often runs on the road the lap finishes on).
    const candidates = [];
    for (const section of course.sections) {
        if (section.leadin && lapIdx > 0) {
            continue;
        }
        const d = sectionDistance(section, state);
        if (d != null && Number.isFinite(d)) {
            candidates.push({
                pos: (section.leadin ? 0 : lap.lapStart) + section.blockOffsetDistance + d,
                leadin: section.leadin,
                index: section.index,
            });
        }
    }
    // The game's route checkpoint says which part of the lap the rider is in: before the
    // first checkpoint they're at the start (e.g. Downtown Eruption starts on the road it
    // finishes on); otherwise in the checkpoint's section or one just after it (it can lag).
    const cpSection = state.routeCheckpointIndex ? course.checkpoints?.get(state.routeCheckpointIndex) : null;
    if (cpSection != null && candidates.length > 1) {
        const after = candidates.filter(x => x.index >= cpSection && x.index <= cpSection + 6);
        if (after.length) {
            return {pos: after.reduce((a, b) => b.index < a.index ? b : a).pos, source: 'road match (checkpoint)'};
        }
    } else if (!state.routeCheckpointIndex && lapIdx === 0 && course.checkpoints?.size && candidates.length) {
        const first = candidates.reduce((a, b) => b.pos < a.pos ? b : a).pos;
        // Only the end of the route matched: the rider is just behind the start line
        return {pos: first > lap.distance / 2 ? 0 : first, source: 'road match (route start)'};
    }
    if (candidates.length) {
        const source = `road match (${candidates.length})`;
        // Pick the match nearest to: where the rider just was, else (first lap) the
        // distance ridden, else the lap progress estimate.
        let ref = recent;
        if (ref == null && lapIdx === 0) {
            if (Number.isFinite(state.eventDistance) && state.eventDistance >= 0 && state.eventDistance < 500000) {
                ref = state.eventDistance;
            } else {
                const leadin = candidates.find(x => x.leadin);
                if (leadin) {
                    return {pos: leadin.pos, source};
                }
            }
        }
        if (ref == null) {
            ref = estimate;
        }
        if (ref == null) {
            return {pos: candidates[0].pos, source};
        }
        return {pos: candidates.reduce((a, b) => Math.abs(b.pos - ref) < Math.abs(a.pos - ref) ? b : a).pos, source};
    }
    return {pos: estimate ?? null, source: estimate != null ? 'lap progress' : 'unknown'};
}


/** Road mode (no route, Climb Portal, video routes): same approach as Sauce's own elevation profile. */
export function roadCoursePosition(course, state) {
    if (state.roadId !== course.road.id || !!state.reverse !== course.reverse ||
        !course.road.curvePath || typeof course.road.curvePath.roadPercentToOffset !== 'function') {
        return null;
    }
    const p = (state.roadTime - 5000) / 1e6;
    const idx = course.road.curvePath.roadPercentToOffset(state.reverse ? 1 - p : p);
    if (!Number.isFinite(idx)) {
        return null;
    }
    const d = course.distances;
    const i = Math.min(d.length - 2, Math.max(0, Math.floor(idx)));
    return d[i] + (d[i + 1] - d[i]) * Math.min(1, Math.max(0, idx - i));
}


/**
 * Another rider's position on the course from their own road position, the same way as the
 * watched rider's. Where the route uses their road more than once (laps, shared roads), the
 * match nearest `ref` (where Sauce's gap puts them, else the watched rider) is used.
 */
export function otherRiderPosition(course, state, ref) {
    if (course.mode !== 'route') {
        return roadCoursePosition(course, state);
    }
    let best = null;
    for (const [i, lap] of course.laps.entries()) {
        for (const section of course.sections) {
            if (section.leadin && i > 0) {
                continue;
            }
            const d = sectionDistance(section, state);
            if (d != null && Number.isFinite(d)) {
                const p = (section.leadin ? 0 : lap.lapStart) + section.blockOffsetDistance + d;
                if (best == null || Math.abs(p - ref) < Math.abs(best - ref)) {
                    best = p;
                }
            }
        }
    }
    return best;
}


/**
 * The official segment (e.g. a KOM) that names a climb with no segment of its own, or null: a
 * segment mostly inside the climb and covering a good part of it, else a longer named KOM the
 * climb is inside (e.g. Titans Grove KOM, which isn't a climb by itself).
 */
export function segmentForClimb(climb, segments) {
    let best = null;
    let bestOverlap = 0;
    for (const s of segments) {
        const overlap = Math.min(climb.end, s.end) - Math.max(climb.start, s.start);
        const segLen = s.end - s.start;
        if (overlap > 0 && overlap >= segLen * 0.6 && overlap >= climb.length * 0.3 && overlap > bestOverlap) {
            best = s;
            bestOverlap = overlap;
        }
    }
    if (!best) {
        for (const s of segments) {
            const overlap = Math.min(climb.end, s.end) - Math.max(climb.start, s.start);
            if (overlap >= climb.length * 0.8 && overlap > bestOverlap && !/lap|loop|sprint/i.test(s.name)) {
                best = s;
                bestOverlap = overlap;
            }
        }
    }
    return best;
}


/**
 * Where the climb's official segment starts or finishes inside the climb, because the climb
 * was found to start earlier or end later than the timed segment.
 */
export function segmentFlags(climb) {
    const seg = climb.segment;
    if (!seg || seg.always) {
        return [];
    }
    const flags = [];
    const tolerance = Math.max(20, climb.length * 0.01);
    if (seg.start - climb.start > tolerance && seg.start < climb.end) {
        flags.push({kind: 'start', distance: seg.start});
    }
    if (climb.end - seg.end > tolerance && seg.end > climb.start) {
        flags.push({kind: 'finish', distance: seg.end});
    }
    return flags;
}


/** Which lap (0 = first) a distance on the course is in. */
export function lapOf(course, distance) {
    if (!course || !course.laps) {
        return 0;
    }
    let lap = 0;
    for (const [i, x] of course.laps.entries()) {
        if (distance >= x.offset) {
            lap = i;
        }
    }
    return lap;
}


/** Free ride on a lapped route: the course is planned a few laps ahead with no end. */
export function isOpenEnded(course) {
    return !!(course && course.key?.startsWith('route:') && course.laps && course.laps.length > 1);
}

/** Past the finish of an event (riding on after it ended). */
export function afterFinish(course, pos) {
    return course?.finish != null && pos != null && pos > course.finish + 1;
}

/** Riding with no set end: free ride on a lapped route, or on after an event's finish. */
export function noSetEnd(course, pos) {
    return isOpenEnded(course) || afterFinish(course, pos);
}


/**
 * The climbs to show. Events: the event's climbs (every lap, to the finish). Free ride on a
 * lapped route, or riding on after an event: the climbs up to the end of the lap being ridden;
 * the next lap's show once it starts.
 */
export function shownClimbs(course, climbs, pos) {
    if (!course) {
        return climbs;
    }
    if (course.finish != null && !afterFinish(course, pos)) {
        return climbs.filter(c => c.start < course.finish);
    }
    if (pos != null && noSetEnd(course, pos)) {
        const lap = lapOf(course, pos);
        return climbs.filter(c => lapOf(course, c.start) <= lap);
    }
    return climbs;
}


/**
 * Climbs for the route climbs list: {lap, list}. With no set end, the lap being ridden (lap is
 * its index); otherwise all the climbs shown (lap is null).
 */
export function routeListClimbs(course, climbs, pos, positionUnknown) {
    const known = pos != null && !positionUnknown;
    if (isOpenEnded(course) || (known && afterFinish(course, pos))) {
        const lap = known ? lapOf(course, pos) : 0;
        return {lap, list: climbs.filter(c => lapOf(course, c.start) === lap)};
    }
    return {lap: null, list: shownClimbs(course, climbs, known ? pos : 0)};
}


/**
 * "3/5 · lap 2/3" for a climb. Climbs are numbered from the start of the ride, counting every
 * lap. The total is the climbs shown at `pos`; laps show a total when there's a finish ahead.
 */
export function climbNumberText(course, climbs, c, pos) {
    const n = c.index + 1;
    const total = shownClimbs(course, climbs, pos).length;
    let lap = '';
    if (course && course.laps && course.laps.length > 1) {
        const lapTotal = course.finish != null && !afterFinish(course, pos) ? lapOf(course, course.finish - 1) + 1 : null;
        lap = ` · lap ${lapOf(course, c.start) + 1}${lapTotal ? `/${lapTotal}` : ''}`;
    }
    return `${n}/${Math.max(n, total)}` + lap;
}
