import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleRoute, baseKey, sectionDistance, routePosition, roadCoursePosition, otherRiderPosition,
        segmentForClimb, segmentFlags, lapOf, shownClimbs, routeListClimbs, climbNumberText,
        isOpenEnded, afterFinish} from '../pages/src/course.mjs';


// A road section as Sauce gives it: the part [start, end] (road percent) of a road, `distance`
// m long, `offset` m into the lap (lead-in sections: into the ride). Distance along the road
// is linear in road percent here.
function section(roadId, start, end, distance, offset, {leadin=false, reverse=false}={}) {
    return {roadId, start, end, distance, blockOffsetDistance: offset, leadin, reverse, weld: false,
            roadCurvePath: {distanceAtRoadPercent: p => (p - start) / (end - start) * distance * 100}};
}

// A route like Downtown Eruption: the lead-in (1 km) is on the same part of road 5 as the end of
// the lap. Lap (6 km): road 7 (4 km), then road 5 from 60% to 100% (2 km) to the finish.
// Checkpoints 1-3 are in the lead-in, 4-10 on road 7, 11-14 on road 5.
function downtownRoute({supportedLaps=true, segments=[]}={}) {
    const sections = [
        section(5, 0.8, 1.0, 1000, 0, {leadin: true}),
        section(7, 0.0, 1.0, 4000, 0),
        section(5, 0.6, 1.0, 2000, 4000),
    ];
    const total = 7000;
    const distances = [], elevations = [];
    for (let d = 0; d <= total; d += 10) {
        distances.push(d);
        elevations.push(100 + (d > 3000 && d < 4000 ? (d - 3000) * 0.06 : d >= 4000 ? 60 : 0));
    }
    return {
        id: 1, supportedLaps, distances, elevations, segments,
        sections,
        // curvePath nodes: section index per point (the lap starts at node 100 = 1000 m)
        curvePath: {nodes: distances.map((d, i) => ({index: d < 1000 ? 0 : d < 5000 ? 1 : 2}))},
        manifest: [{checkpoints: [1, 3]}, {checkpoints: [4, 10]}, {checkpoints: [11, 14]}],
    };
}

function routeCourse(route, opts) {
    return {key: 'route:1:2', mode: 'route', routeId: 1, ...assembleRoute(route, opts)};
}

const at = (roadId, p, extra={}) => ({roadId, roadTime: 5000 + p * 1e6, reverse: false, laps: 0, ...extra});
const round = r => ({...r, pos: r.pos == null ? r.pos : Math.round(r.pos)});


test('assembleRoute: lead-in once, then laps', () => {
    const c = routeCourse(downtownRoute(), {minLaps: 3});
    assert.equal(c.laps.length, 3);
    assert.deepEqual(c.laps.map(l => [l.offset, l.lapStart]), [[0, 1000], [7000, 7000], [13000, 13000]]);
    assert.equal(c.lapLength, 6000);
    assert.equal(c.distances.at(-1), 19000);  // 1 km lead-in + 3 x 6 km
    assert.equal(c.finish, null);
});

test('assembleRoute: events finish at their last lap or distance, and go on past it', () => {
    const laps = routeCourse(downtownRoute(), {eventLaps: 2, minLaps: 2});
    assert.equal(laps.finish, 13000);
    const more = routeCourse(downtownRoute(), {eventLaps: 2, minLaps: 4});  // riding on, lap 3
    assert.equal(more.finish, 13000);
    assert.equal(more.laps.length, 4);
    const dist = routeCourse(downtownRoute(), {distance: 10000, minLaps: 2});
    assert.equal(dist.finish, 10000);
    assert.ok(dist.distances.at(-1) > 10000, 'the course goes on past the finish');
    // A route without laps: one lap, finish capped at its end
    const single = routeCourse(downtownRoute({supportedLaps: false}), {distance: 50000});
    assert.equal(single.laps.length, 1);
    assert.equal(single.finish, 7000);
});

test('assembleRoute: named segments on every lap, lead-in-only ones once', () => {
    const route = downtownRoute({segments: [
        {id: 1, offset: 2000, distance: 1000},
        {id: 2, offset: -500, distance: 300, leadinOnly: true},
        {id: 3, offset: 100, distance: 100},  // no name: not used
    ]});
    const c = routeCourse(route, {minLaps: 2, segmentNames: new Map([[1, 'KOM'], [2, 'Sprint']])});
    assert.deepEqual(c.segments.map(s => [s.name, s.start]), [['KOM', 3000], ['Sprint', 500], ['KOM', 9000]]);
});

test('baseKey: the same ride whatever the planned laps', () => {
    assert.equal(baseKey('route:123:4'), 'route:123');
    assert.equal(baseKey('event:55:3'), 'event:55');
    assert.equal(baseKey('road:6:5:false'), 'road:6:5:false');
});

test('sectionDistance: on the section, with a little slack at its ends', () => {
    const s = section(5, 0.2, 0.6, 4000, 0);
    assert.equal(Math.round(sectionDistance(s, at(5, 0.4))), 2000);
    assert.equal(sectionDistance(s, at(5, 0.2 - 1e-3)), 0);  // just before: clamped
    assert.equal(sectionDistance(s, at(5, 0.7)), undefined);
    assert.equal(sectionDistance(s, at(6, 0.4)), undefined);
    assert.equal(sectionDistance(s, at(5, 0.4, {reverse: true})), undefined);
});

test('routePosition: Sauce\'s route distance comes first, by the distance left in the lap', () => {
    const c = routeCourse(downtownRoute(), {minLaps: 3});
    assert.deepEqual(routePosition(c, {routeId: 1, laps: 0, routeDistance: 2500, routeEnd: 7000}),
                     {pos: 2500, source: 'sauce'});
    // Lap 2: 1 km left of a 6 km lap
    assert.equal(routePosition(c, {routeId: 1, laps: 1, routeDistance: 5000, routeEnd: 6000}).pos, 12000);
});

test('routePosition: before the first checkpoint, at the start (not the end of the lap on the same road)', () => {
    const c = routeCourse(downtownRoute(), {minLaps: 2});
    // Road 5 at 90%: 500 m into the lead-in, or 1.5 km into the lap's road 5 part (6.5 km)
    assert.deepEqual(round(routePosition(c, at(5, 0.9))), {pos: 500, source: 'road match (route start)'});
});

test('routePosition: the checkpoint picks the right use of a shared road, even when it lags', () => {
    const c = routeCourse(downtownRoute(), {minLaps: 2});
    const near = cp => round(routePosition(c, at(5, 0.9, {routeCheckpointIndex: cp})));
    // Still in the lead-in's checkpoints: the lead-in
    assert.deepEqual(near(2), {pos: 500, source: 'road match (checkpoint)'});
    // In the lap's road 5 checkpoints: the end of the lap
    assert.deepEqual(near(12), {pos: 6500, source: 'road match (checkpoint)'});
    // The checkpoint still says road 7 (it lags): the next section on, not back to the lead-in
    assert.deepEqual(near(10), {pos: 6500, source: 'road match (checkpoint)'});
});

test('routePosition: with no checkpoint, the match nearest to where the rider just was', () => {
    const c = routeCourse(downtownRoute(), {minLaps: 2});
    delete c.checkpoints;
    // Shared road 5 at 90%: the lead-in (500 m) or the lap's end (6.5 km); nearest to where the
    // rider just was, else (first lap, nothing else to go on) the lead-in
    assert.equal(Math.round(routePosition(c, at(5, 0.9), 6400).pos), 6500);
    assert.equal(Math.round(routePosition(c, at(5, 0.9), 300).pos), 500);
    assert.equal(Math.round(routePosition(c, at(5, 0.9)).pos), 500);
    assert.equal(Math.round(routePosition(c, at(5, 0.9, {eventDistance: 6300})).pos), 6500);
    assert.equal(Math.round(routePosition(c, at(7, 0.5), 3200).pos), 3000);
    assert.deepEqual(routePosition(c, {roadId: 99, roadTime: 0, laps: 0}), {pos: null, source: 'unknown'});
    // Only the game's lap progress
    assert.deepEqual(routePosition(c, {roadId: 99, roadTime: 0, laps: 0, progress: 0.5}),
                     {pos: 3500, source: 'lap progress'});
});

test('roadCoursePosition: along the road, in the riding direction only', () => {
    const c = {mode: 'road', reverse: false, distances: [0, 100, 200, 300],
               road: {id: 9, curvePath: {roadPercentToOffset: p => p * 3}}};
    assert.equal(roadCoursePosition(c, at(9, 0.5)), 150);
    assert.equal(roadCoursePosition(c, at(8, 0.5)), null);
    assert.equal(roadCoursePosition(c, at(9, 0.5, {reverse: true})), null);
});

test('otherRiderPosition: the lap nearest to where Sauce\'s gap puts them', () => {
    const c = routeCourse(downtownRoute(), {minLaps: 3});
    const s = at(7, 0.5);  // 2 km into road 7: 3 km on lap 1, 9 km on lap 2, 15 km on lap 3
    assert.equal(otherRiderPosition(c, s, 3500), 3000);
    assert.equal(otherRiderPosition(c, s, 8000), 9000);
    assert.equal(otherRiderPosition(c, s, 16000), 15000);
});

test('segmentForClimb: a segment mostly inside the climb, else a longer KOM around it', () => {
    const climb = {start: 1000, end: 2000, length: 1000};
    assert.equal(segmentForClimb(climb, [{name: 'KOM', start: 1100, end: 1900}]).name, 'KOM');
    // Mostly outside the climb: no
    assert.equal(segmentForClimb(climb, [{name: 'Long', start: 1500, end: 4000}]), null);
    // Climb inside a long KOM (e.g. Titans Grove): yes; inside a long sprint or lap: no
    assert.equal(segmentForClimb(climb, [{name: 'Titans Grove KOM', start: 0, end: 3000}]).name, 'Titans Grove KOM');
    assert.equal(segmentForClimb(climb, [{name: 'Watopia Sprint', start: 0, end: 3000}]), null);
});

test('segmentFlags: where the timed segment starts or ends inside a longer climb', () => {
    const seg = {start: 1300, end: 2000};
    assert.deepEqual(segmentFlags({start: 1000, end: 2000, length: 1000, segment: seg}),
                     [{kind: 'start', distance: 1300}]);
    assert.deepEqual(segmentFlags({start: 1000, end: 2000, length: 1000, segment: {start: 1005, end: 1995}}), []);
    assert.deepEqual(segmentFlags({start: 1000, end: 2000, length: 1000}), []);
});

test('shown climbs and numbering: free ride laps, events, and riding on after the finish', () => {
    const climbsOn = c => [1, 2].flatMap(lap => [2000, 4500].map(x => c.laps[lap - 1].lapStart + x - 1000))
        .map((start, index) => ({start, end: start + 500, index}));
    // Free ride, 3 laps planned: only up to the lap being ridden
    const free = routeCourse(downtownRoute(), {minLaps: 3});
    const fc = climbsOn(free);
    assert.ok(isOpenEnded(free));
    assert.deepEqual(shownClimbs(free, fc, 2500).map(c => c.index), [0, 1]);
    assert.deepEqual(shownClimbs(free, fc, 8000).map(c => c.index), [0, 1, 2, 3]);
    assert.equal(climbNumberText(free, fc, fc[1], 2500), '2/2 · lap 1');
    assert.deepEqual(routeListClimbs(free, fc, 8000, false), {lap: 1, list: [fc[2], fc[3]]});
    // A 1-lap event on a lapped route, planned past the finish
    const ev = {...routeCourse(downtownRoute(), {eventLaps: 1, minLaps: 2}), key: 'event:5:2'};
    const ec = climbsOn(ev);
    assert.ok(!isOpenEnded(ev));
    assert.deepEqual(shownClimbs(ev, ec, 2500).map(c => c.index), [0, 1]);
    assert.equal(climbNumberText(ev, ec, ec[0], 2500), '1/2 · lap 1/1');
    // Past the finish: the next lap's climbs as you ride on, no lap total
    assert.ok(afterFinish(ev, 8000));
    assert.deepEqual(shownClimbs(ev, ec, 8000).map(c => c.index), [0, 1, 2, 3]);
    assert.equal(climbNumberText(ev, ec, ec[2], 8000), '3/4 · lap 2');
    assert.equal(lapOf(ev, 6999), 0);
    assert.equal(lapOf(ev, 7000), 1);
});
