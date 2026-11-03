import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProfile, detectClimbs, DETECTION_SCORES} from '../pages/src/climbs.mjs';
import {isVideoRoad, videoRoad, videoRoadOffset, videoCourseId} from '../pages/src/video.mjs';
import {videoRoads} from '../pages/src/video-roads.mjs';


test('video roads: only on the video course', () => {
    assert.equal(videoCourseId, 18);
    assert.equal(isVideoRoad(18, 27091), true);
    assert.equal(isVideoRoad(6, 27091), false);  // same id on another course
    assert.equal(isVideoRoad(18, 10000), false);
    assert.equal(isVideoRoad(18, undefined), false);
    assert.equal(videoRoad(12345), null);
});

test('video roads: Galibier decodes to the road from Zwift', () => {
    const r = videoRoad(27091);
    assert.equal(r.name, 'Col du Galibier, Lautaret');
    assert.equal(r.distances.length, r.elevations.length);
    assert.equal(r.distances[0], 0);
    assert.ok(Math.abs(r.distances.at(-1) - 16780) < 20, `length ${r.distances.at(-1)}`);
    assert.ok(Math.abs(Math.max(...r.elevations) - 2639) < 1);
    assert.equal(r.segments.length, 1);
    // Road time spans the control points except the first and last
    assert.equal(videoRoadOffset(r, 0), 1);
    assert.equal(videoRoadOffset(r, 1), r.distances.length - 2);
});

test('video roads: every road decodes and its timed segment is found as the climb', () => {
    for (const id of Object.keys(videoRoads)) {
        const r = videoRoad(Number(id));
        assert.ok(r, id);
        for (let i = 1; i < r.distances.length; i++) {
            assert.ok(r.distances[i] >= r.distances[i - 1], `${r.name}: distance goes back at ${i}`);
        }
        const total = r.distances.at(-1);
        const segments = r.segments.map(x => ({name: r.name, ...x}));
        for (const s of segments) {
            assert.ok(s.start >= 0 && s.end <= total && s.end > s.start, `${r.name}: segment ${s.start}-${s.end}`);
        }
        for (const minGrade of [undefined, 0.015]) {
            const climbs = detectClimbs(buildProfile(r.distances, r.elevations),
                                        {segments, minGrade, minScore: DETECTION_SCORES.small});
            for (const s of segments) {
                assert.ok(climbs.some(c => c.segment && c.segment.start === s.start), `${r.name}: segment climb`);
            }
        }
    }
});
