import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProfile, detectClimbs, riderProgress, climbChunks, currentOrNextClimb,
        autoChunkLength, portalClimbStart, portalClimbEnd, DETECTION_SCORES} from '../pages/src/climbs.mjs';
import {gradeColor, SCHEMES} from '../pages/src/colors.mjs';
import {routeKey, fallbackClimbName} from '../pages/src/names.mjs';
import {formatDistance, formatElevation, formatGrade, resolveImperial, toText} from '../pages/src/units.mjs';


// Build a profile from [length (m), grade] pieces, sampled every `res` meters,
// with optional deterministic noise (meters).
function makeProfile(pieces, {res=10, noise=0, startElevation=100}={}) {
    const distances = [0];
    const elevations = [startElevation];
    let d = 0;
    let el = startElevation;
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
    for (const [length, grade] of pieces) {
        const steps = Math.round(length / res);
        for (let i = 0; i < steps; i++) {
            d += res;
            el += grade * res;
            distances.push(d);
            elevations.push(el + (noise ? rand() * noise : 0));
        }
    }
    return {distances, elevations};
}

function detect(pieces, opts={}, profileOpts={}) {
    const {distances, elevations} = makeProfile(pieces, profileOpts);
    const profile = buildProfile(distances, elevations);
    return {profile, climbs: detectClimbs(profile, opts)};
}

const near = (actual, expected, tol, msg) =>
    assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} ± ${tol}, got ${actual}`);


test('Alpe du Zwift style climb is one HC climb', () => {
    // 12.2 km at ~8.5% with flatter hairpins
    const alpe = [];
    for (let i = 0; i < 21; i++) {
        alpe.push([500, 0.092], [80, 0.03]);
    }
    const {climbs} = detect([[2000, 0], ...alpe, [2000, 0]], {}, {noise: 1});
    assert.equal(climbs.length, 1);
    const c = climbs[0];
    near(c.length, 12180, 300, 'length');
    near(c.gain, 1016, 30, 'gain');
    assert.equal(c.category.label, 'HC');
});

test('climb with a dip in the middle stays one climb and counts the re-climb', () => {
    // 2 km @ 5%, 400 m @ -4% dip, 2 km @ 5%
    const {profile, climbs} = detect([[1000, 0], [2000, 0.05], [400, -0.04], [2000, 0.05], [1000, 0]]);
    assert.equal(climbs.length, 1, JSON.stringify(climbs.map(x => [x.start, x.end])));
    const c = climbs[0];
    near(c.length, 4400, 200, 'length');
    near(c.gain, 184, 10, 'net gain');
    near(c.ascent, 200, 10, 'total ascent');
    // At the start, everything is left to climb, including the dip's re-climb.
    const atStart = riderProgress(profile, c, c.start);
    near(atStart.remainingAscent, 200, 10, 'remaining ascent at start');
    // Halfway down the dip: 100 m (2nd ramp) + the part of the dip already lost.
    const inDip = riderProgress(profile, c, 3200);
    near(inDip.remainingAscent, 108, 10, 'remaining ascent inside dip');
    assert.ok(inDip.remainingAscent > inDip.remainingGain, 'ascent includes dip recovery');
});

test('climb with several small dips stays one climb', () => {
    const pieces = [[500, 0]];
    for (let i = 0; i < 4; i++) {
        pieces.push([800, 0.06], [150, -0.05]);
    }
    pieces.push([800, 0.06], [500, 0]);
    const {climbs} = detect(pieces);
    assert.equal(climbs.length, 1);
    near(climbs[0].ascent, 240, 12, 'ascent');
});

test('two climbs separated by a long descent are separate', () => {
    const {climbs} = detect([[500, 0], [2000, 0.05], [3000, -0.03], [2000, 0.06], [500, 0]]);
    assert.equal(climbs.length, 2);
    near(climbs[0].gain, 100, 10, 'first gain');
    near(climbs[1].gain, 120, 10, 'second gain');
});

test('two climbs separated by a long flat are separate', () => {
    const {climbs} = detect([[500, 0], [2000, 0.05], [2500, 0], [2000, 0.06], [500, 0]]);
    assert.equal(climbs.length, 2);
});

test('flat noisy road and gentle 2% ramp have no climbs', () => {
    assert.equal(detect([[20000, 0]], {}, {noise: 3}).climbs.length, 0);
    assert.equal(detect([[10000, 0.02]]).climbs.length, 0);
});

test('detection size thresholds (small / medium / large)', () => {
    // 600 m @ 4% = 24 m gain = score 2400 -> small only
    const small = [[1000, 0], [600, 0.04], [1000, 0]];
    assert.equal(detect(small, {minScore: DETECTION_SCORES.small}).climbs.length, 1);
    assert.equal(detect(small, {minScore: DETECTION_SCORES.medium}).climbs.length, 0);
    // 1.5 km @ 4% = 60 m -> score 6000 -> medium, not large
    const medium = [[1000, 0], [1500, 0.04], [1000, 0]];
    assert.equal(detect(medium, {minScore: DETECTION_SCORES.medium}).climbs.length, 1);
    assert.equal(detect(medium, {minScore: DETECTION_SCORES.large}).climbs.length, 0);
    // 3 km @ 4.3% = 129 m -> large
    const large = [[1000, 0], [3000, 0.043], [1000, 0]];
    assert.equal(detect(large, {minScore: DETECTION_SCORES.large}).climbs.length, 1);
});

test('short steep ramp under 500 m is not a climb', () => {
    assert.equal(detect([[1000, 0], [300, 0.1], [1000, 0]]).climbs.length, 0);
});

test('gentle approach is trimmed off (Box Hill style)', () => {
    // 2 km @ 1% approach then 3.02 km @ 4.3%
    const {climbs} = detect([[2000, 0.01], [3020, 0.043], [1000, -0.01]]);
    assert.equal(climbs.length, 1);
    near(climbs[0].length, 3020, 250, 'length');
    near(climbs[0].avgGrade, 0.043, 0.004, 'avg grade');
});

test('steep climb inside a long gentle rise is found', () => {
    // 3 km @ 1.5%, 1.2 km @ 7%, 3 km @ 1.5%: no new-high gaps so one candidate
    const {climbs} = detect([[3000, 0.015], [1200, 0.07], [3000, 0.015]]);
    assert.equal(climbs.length, 1);
    near(climbs[0].avgGrade, 0.07, 0.012, 'grade');
    near(climbs[0].length, 1200, 300, 'length');
});

test('progress, current/next climb and chunks', () => {
    const {profile, climbs} = detect([[1000, 0], [2000, 0.05], [2000, 0], [1000, 0.06], [500, 0]]);
    assert.equal(climbs.length, 2);
    const [c1, c2] = climbs;
    assert.equal(currentOrNextClimb(climbs, 0), c1);
    assert.equal(currentOrNextClimb(climbs, c1.start + 100), c1);
    assert.equal(currentOrNextClimb(climbs, c1.end + 1), c2);
    assert.equal(currentOrNextClimb(climbs, c2.end + 1), null);
    const before = riderProgress(profile, c1, 500);
    assert.equal(before.state, 'approaching');
    near(before.toStart, c1.start - 500, 0.01, 'to start');
    const mid = riderProgress(profile, c1, (c1.start + c1.end) / 2);
    assert.equal(mid.state, 'climbing');
    near(mid.remaining, c1.length / 2, 1, 'remaining');
    near(mid.done, 0.5, 0.01, 'done');
    const chunks = climbChunks(profile, c1, autoChunkLength(c1.length));
    assert.equal(chunks[0].start, c1.start);
    assert.equal(chunks.at(-1).end, c1.end);
    for (const x of chunks.slice(1, -1)) {
        near(x.grade, 0.05, 0.005, 'chunk grade');
    }
});

test('handles empty or tiny input', () => {
    assert.equal(buildProfile([], []), null);
    assert.deepEqual(detectClimbs(null), []);
    const p = buildProfile([0, 10], [0, 1]);
    assert.deepEqual(detectClimbs(p), []);
});

test('long multi-lap course is fast enough', () => {
    const lap = [[3000, 0], [5000, 0.06], [5000, -0.06], [7000, 0.005]];
    const pieces = [];
    for (let i = 0; i < 10; i++) {
        pieces.push(...lap);
    }
    const t = Date.now();
    const {climbs} = detect(pieces, {}, {noise: 2});
    assert.equal(climbs.length, 10);
    assert.ok(Date.now() - t < 2000, 'took too long');
});

test('every color scheme returns CSS colors', () => {
    for (const {id} of SCHEMES) {
        for (const g of [-0.3, -0.05, 0, 0.02, 0.05, 0.08, 0.11, 0.2, 0.5, NaN]) {
            assert.match(gradeColor(g, id, 0.8), /^hsl\(\d+ \d+% \d+% \/ 0\.8\)$/, `${id} ${g}`);
        }
    }
    assert.notEqual(gradeColor(0.02), gradeColor(0.13));
});

test('units', () => {
    assert.equal(resolveImperial('auto', true), true);
    assert.equal(resolveImperial('auto', false), false);
    assert.equal(resolveImperial('metric', true), false);
    assert.equal(resolveImperial('imperial', false), true);
    assert.equal(toText(formatDistance(2345, false)), '2.35 km');
    assert.equal(toText(formatDistance(850, false)), '850 m');
    assert.equal(toText(formatDistance(16093.44, true)), '10.0 mi');
    assert.equal(toText(formatDistance(100, true)), '328 ft');
    assert.equal(toText(formatElevation(100, true)), '328 ft');
    assert.equal(toText(formatGrade(0.0849)), '8.5%');
    assert.equal(toText(formatGrade(-0.0001)), '0.0%');
});

test('official climb segment sets the climb start and end', () => {
    // Climb 1000-3000 m at 5%, then 500 m flat top included in the segment
    const {distances, elevations} = makeProfile([[1000, 0], [2000, 0.05], [1500, 0]]);
    const profile = buildProfile(distances, elevations);
    const segments = [{name: 'Test KOM', start: 900, end: 3500}];
    const climbs = detectClimbs(profile, {segments});
    assert.equal(climbs.length, 1);
    assert.equal(climbs[0].start, 900);
    assert.equal(climbs[0].end, 3500);
    assert.equal(climbs[0].segment.name, 'Test KOM');
});

test('official segment rescues a borderline climb and joins a split one', () => {
    // 1 km @ 5%, 600 m flat, 1 km @ 5%: terrain alone gives two climbs
    const {distances, elevations} = makeProfile([[500, 0], [1000, 0.05], [600, 0], [1000, 0.05], [500, 0]]);
    const profile = buildProfile(distances, elevations);
    assert.equal(detectClimbs(profile).length, 2);
    const climbs = detectClimbs(profile, {segments: [{name: 'KOM', start: 500, end: 3100}]});
    assert.equal(climbs.length, 1);
    assert.equal(climbs[0].segment.name, 'KOM');
});

test('segments that are not climbs are ignored', () => {
    const {distances, elevations} = makeProfile([[1000, 0], [2000, 0.05], [3000, 0]]);
    const profile = buildProfile(distances, elevations);
    const segments = [
        {name: 'Sprint', start: 4000, end: 4400},         // flat
        {name: 'Lap', start: 0, end: 6000},               // whole loop, under 3%
    ];
    const climbs = detectClimbs(profile, {segments});
    assert.equal(climbs.length, 1);
    assert.equal(climbs[0].segment, null);
});

test('a segment only extends a climb, never shortens it', () => {
    // 2 km @ 6% then 1.5 km @ 6%; segment only covers the second part
    const {distances, elevations} = makeProfile([[500, 0], [2000, 0.06], [1500, 0.06], [500, 0]]);
    const profile = buildProfile(distances, elevations);
    const plain = detectClimbs(profile);
    const climbs = detectClimbs(profile, {segments: [{name: 'Top KOM', start: 2500, end: 4000}]});
    assert.equal(climbs.length, 1);
    assert.equal(climbs[0].segment.name, 'Top KOM');
    assert.equal(climbs[0].start, plain[0].start);
    assert.ok(climbs[0].end >= 4000);
});

test('route names match despite small differences', () => {
    assert.equal(routeKey('2022 gran fondo'), routeKey('Zwift Gran Fondo 2022'));
    assert.equal(routeKey('2015 uci worlds course'), routeKey('2015 Worlds Course'));
    assert.equal(routeKey('braekfast crits and grits'), routeKey('BRAEk-fast Crits and Grits'));
    assert.equal(routeKey('yorkshire double loops'), routeKey('Yorkshire Double Loop'));
    assert.notEqual(routeKey('Gran Fondo'), routeKey('Gran Fondo 2022'));
});

test('fallback names for unofficial climbs', () => {
    // San Luca on the Bologna Time Trial
    assert.equal(fallbackClimbName('Bologna Time Trial', {start: 5900, end: 7920, length: 2020}), 'San Luca');
    // Brian Mudge's Governor St Climb at 15.3 km on the 2015 Worlds Course
    assert.equal(fallbackClimbName('2015 Worlds Course', {start: 15250, end: 15900, length: 650}), 'Governor St Climb');
    // Wrong place or unknown route: no name
    assert.equal(fallbackClimbName('Bologna Time Trial', {start: 1000, end: 2000, length: 1000}), null);
    assert.equal(fallbackClimbName('No Such Route', {start: 5900, end: 7920, length: 2020}), null);
    // Repeats on later laps
    const laps = [{lapStart: 0}, {lapStart: 10000}];
    assert.equal(fallbackClimbName('Bologna Time Trial', {start: 15900, end: 17920, length: 2020}, laps), 'San Luca');
});

test('short official KOM under 500 m counts if steep enough (23rd St style)', () => {
    // 284 m at 9.3% on flat roads
    const {distances, elevations} = makeProfile([[2000, 0], [284, 0.093], [2000, 0]]);
    const profile = buildProfile(distances, elevations);
    assert.equal(detectClimbs(profile).length, 0, 'too short without a segment');
    const seg = {name: '23RD ST.', start: 2000, end: 2284};
    const climbs = detectClimbs(profile, {segments: [seg]});
    assert.equal(climbs.length, 1);
    assert.equal(climbs[0].segment.name, '23RD ST.');
    // Still needs the score for the chosen size
    assert.equal(detectClimbs(profile, {segments: [seg], minScore: DETECTION_SCORES.medium}).length, 0);
    // A short gentle segment does not count
    const flat = makeProfile([[2000, 0], [300, 0.02], [2000, 0]]);
    const p2 = buildProfile(flat.distances, flat.elevations);
    assert.equal(detectClimbs(p2, {segments: [{name: 'Kicker', start: 2000, end: 2300}]}).length, 0);
});

test('unit formatting edge cases', () => {
    assert.equal(toText(formatDistance(996, false)), '1.00\u202fkm');
    assert.equal(toText(formatDistance(994, false)), '990\u202fm');
    assert.equal(toText(formatDistance(9.999 * 1609.344, true)), '10.0\u202fmi');
    assert.equal(toText(formatGrade(-0.003, 0)), '0%');
    assert.equal(toText(formatGrade(-0.0004, 1)), '0.0%');
    assert.equal(toText(formatGrade(-0.006, 0)), '-1%');
});

test('lead-in climb names are not repeated on later laps', () => {
    // Pen to Village Climb starts at 0 on Makuri 40 (in the lead-in)
    const laps = [{lapStart: 1000}, {lapStart: 20000}];
    assert.equal(fallbackClimbName('Makuri 40', {start: 0, end: 1400, length: 1400}, laps), 'Pen to Village Climb (Makuri)');
    assert.equal(fallbackClimbName('Makuri 40', {start: 19000, end: 20400, length: 1400}, laps), null);
});

test('gentle official KOMs count down to 2%, other gentle segments do not', () => {
    // 2.6 km at 2.2% (Titans Grove style), flat around it
    const {distances, elevations} = makeProfile([[2000, 0], [2600, 0.022], [2000, 0]]);
    const profile = buildProfile(distances, elevations);
    assert.equal(detectClimbs(profile).length, 0, 'not a climb by terrain alone');
    const kom = detectClimbs(profile, {segments: [{name: 'Titans Grove KOM', start: 2000, end: 4600}]});
    assert.equal(kom.length, 1);
    assert.equal(kom[0].segment.name, 'Titans Grove KOM');
    near(kom[0].length, 2600, 1, 'length');
    // Same shape but not named as a KOM (e.g. a whole TT course segment): not a climb
    assert.equal(detectClimbs(profile, {segments: [{name: 'Bologna TT', start: 2000, end: 4600}]}).length, 0);
    // Under 2% is still not a climb, even as a KOM
    const flat = makeProfile([[2000, 0], [4000, 0.015], [2000, 0]]);
    const p2 = buildProfile(flat.distances, flat.elevations);
    assert.equal(detectClimbs(p2, {segments: [{name: 'Connector KOM', start: 2000, end: 6000}]}).length, 0);
});

test('gentle climbs are found only with a lower minimum grade', () => {
    // Desert drag: 1.8 km at 1.7% between flats
    const {distances, elevations} = makeProfile([[3000, 0], [1800, 0.017], [3000, 0]]);
    const profile = buildProfile(distances, elevations);
    assert.equal(detectClimbs(profile).length, 0);
    assert.equal(detectClimbs(profile, {minGrade: undefined}).length, 0, 'undefined keeps the default');
    const gentle = detectClimbs(profile, {minGrade: 0.015});
    assert.equal(gentle.length, 1);
    near(gentle[0].length, 1800, 250, 'length');
    near(gentle[0].avgGrade, 0.017, 0.003, 'grade');
});

import {ClimbEffort, formatDuration} from '../pages/src/effort.mjs';

function ride(effort, {from, to, speed, power, hr, cadence, weight=75, t0=1000, step=1}) {
    // speed in m/s; one sample per `step` seconds
    let done = false;
    for (let t = 0, pos = from; !done && pos <= to + speed; t += step, pos += speed * step) {
        done = effort.add({t: t0 + t, pos, power, hr, cadence, weight});
    }
    return done;
}

test('climb effort: time, power, HR and VAM over a full climb', () => {
    const climb = {start: 1000, end: 3000, length: 2000, ascent: 100};
    const effort = new ClimbEffort(climb);
    // 5 m/s from before the climb to past the top -> 2000 m in 400 s
    const done = ride(effort, {from: 0, to: 3500, speed: 5, power: 250, hr: 150, cadence: 85});
    assert.ok(done, 'finished at the top');
    const s = effort.summary(pos => 100 * (climb.end - pos) / climb.length);
    near(s.time, 400, 1.5, 'climb time');
    near(s.avgPower, 250, 0.5, 'avg power');
    near(s.wkg, 250 / 75, 0.01, 'w/kg');
    near(s.avgHR, 150, 0.5, 'avg HR');
    assert.equal(s.maxHR, 150);
    near(s.avgCadence, 85, 0.5, 'cadence');
    near(s.avgSpeed, 18, 0.1, 'avg speed kph');
    near(s.vam, 900, 5, 'VAM m/h');
    assert.equal(s.partial, false);
});

test('climb effort: joined mid-climb is partial; no HR stays empty', () => {
    const climb = {start: 1000, end: 3000, length: 2000, ascent: 100};
    const effort = new ClimbEffort(climb);
    ride(effort, {from: 2000, to: 3200, speed: 4, power: 200, hr: 0, cadence: 0});
    const s = effort.summary();
    assert.equal(s.partial, true);
    near(s.distance, 1000, 5, 'distance tracked');
    near(s.time, 250, 2, 'time');
    assert.equal(s.avgHR, null);
    assert.equal(s.maxHR, null);
    assert.equal(s.avgCadence, null);
});

test('climb effort: not finished before the top, duplicates ignored', () => {
    const climb = {start: 1000, end: 3000, length: 2000, ascent: 100};
    const effort = new ClimbEffort(climb);
    assert.equal(effort.add({t: 1, pos: 900, power: 200}), false);
    assert.equal(effort.add({t: 2, pos: 1100, power: 200}), false);
    assert.equal(effort.add({t: 2, pos: 1100, power: 999}), false);
    assert.equal(effort.summary(), null, 'no summary before the top');
    near(effort.powerSum / effort.time, 200, 0.01, 'duplicate sample ignored');
});

test('duration formatting', () => {
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(3725), '1:02:05');
    assert.equal(formatDuration(NaN), '-');
});

test('an always-shown climb (Climb Portal) covers the whole road whatever its grade', () => {
    // 3 km at 1.5% (e.g. a portal climb at low difficulty)
    const {distances, elevations} = makeProfile([[3000, 0.015]]);
    const profile = buildProfile(distances, elevations);
    assert.equal(detectClimbs(profile).length, 0);
    const climbs = detectClimbs(profile, {segments: [{name: 'Eazy Rider', start: 0, end: 3000, always: true}],
                                          minScore: DETECTION_SCORES.large});
    assert.equal(climbs.length, 1);
    assert.equal(climbs[0].segment.name, 'Eazy Rider');
    near(climbs[0].length, 3000, 20, 'whole road');
});

test('a Climb Portal climb ends at the top, not on the flat run-out past the finish', () => {
    // 2 km at 6.5% then 300 m flat (rising 0.3 m), like Mur de Bretagne
    const distances = [], elevations = [];
    for (let d = 0; d <= 2300; d += 10) {
        distances.push(d);
        elevations.push(d <= 2000 ? d * 0.065 : 130 + (d - 2000) * 0.001);
    }
    near(portalClimbEnd(distances, elevations), 2000, 20, 'finish');
    // Scaled by 125% difficulty with a 1.25 m tolerance: same finish
    near(portalClimbEnd(distances, elevations.map(x => x * 1.25), 1.25), 2000, 20, 'finish at 125%');
    // A road that climbs to the very end keeps its full length
    assert.equal(portalClimbEnd([0, 1000], [0, 50]), 1000);
});

test('a Climb Portal climb starts at the bottom even when the road data begins with a drop', () => {
    // Like Col de Sarenne: the data starts 150 m up and drops straight down, then climbs
    const distances = [], elevations = [];
    for (let d = 0; d <= 3000; d += 10) {
        distances.push(d);
        elevations.push(d <= 150 ? 150 - d : d <= 2650 ? (d - 150) * 0.06 : 150);
    }
    assert.equal(portalClimbStart(distances, elevations, 2650), 150);
    near(portalClimbEnd(distances, elevations), 2650, 20, 'top');
    // A small dip after the start (under 50 m) keeps the road start
    assert.equal(portalClimbStart([0, 100, 1000], [10, 0, 80], 1000), 0);
});
