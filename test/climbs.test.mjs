import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProfile, detectClimbs, riderProgress, climbChunks, currentOrNextClimb,
        autoChunkLength, DETECTION_SCORES} from '../pages/src/climbs.mjs';
import {gradeColor, SCHEMES} from '../pages/src/colors.mjs';
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
