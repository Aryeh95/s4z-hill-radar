// Zwift video routes (course 18) from Hill Radar's own copy of their roads, for when Sauce
// doesn't have them. Pure module (no Sauce imports).

import {videoCourseId, videoRoads} from './video-roads.mjs';

export {videoCourseId};

/**
 * Whether the rider is on a video road Hill Radar knows. Video road ids (20000+) overlap the
 * Climb Portal's (10000+), so this needs the course too.
 */
export function isVideoRoad(courseId, roadId) {
    return courseId === videoCourseId && Object.hasOwn(videoRoads, roadId);
}

function decode(s) {
    const out = [];
    let x = 0;
    for (const v of s.split(',')) {
        x += Number(v);
        out.push(x / 10);
    }
    return out;
}

const cache = new Map();

/**
 * {id, name, distances, elevations, segments: [{start, end}]} for a video road, or null.
 * distances/elevations are the road's control points (m), in road order.
 */
export function videoRoad(roadId) {
    if (!Object.hasOwn(videoRoads, roadId)) {
        return null;
    }
    if (!cache.has(roadId)) {
        const r = videoRoads[roadId];
        const distances = decode(r.distances);
        const elevations = decode(r.elevations);
        if (distances.length !== elevations.length || distances.length < 4) {
            cache.set(roadId, null);
        } else {
            cache.set(roadId, {
                id: Number(roadId),
                name: r.name,
                distances,
                elevations,
                segments: r.segments.map(([start, end]) => ({start, end})),
            });
        }
    }
    return cache.get(roadId);
}

/**
 * Road percent (road time 0-1) -> control point offset, like Sauce: road time spans the
 * control points except the first and last.
 */
export function videoRoadOffset(road, p) {
    return p * (road.distances.length - 3) + 1;
}
