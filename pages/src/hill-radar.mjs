import * as common from '/pages/src/common.mjs';
import {buildProfile, detectClimbs, riderProgress, currentOrNextClimb, climbChunks,
        autoChunkLength, elevationAt, gradeAt, ascentAt, DETECTION_SCORES} from './climbs.mjs';
import {ClimbEffort, formatDuration} from './effort.mjs';
import {gradeColor} from './colors.mjs';
import {fallbackClimbName} from './names.mjs';
import {portalClimbs} from './climb-names.mjs';
import {resolveImperial, formatDistance, formatElevation, formatGrade, toText, metersPerMile} from './units.mjs';

const doc = document.documentElement;
const GENTLE_MIN_GRADE = 0.015;  // "Include gentle climbs": 1.5% instead of 3%
const svgNS = 'http://www.w3.org/2000/svg';

common.settingsStore.setDefault({
    detection: 'small',
    gentleClimbs: false,
    units: 'auto',
    approachDistance: 0,
    hideWhenIdle: false,
    upcomingCount: 2,
    colorScheme: 'classic',
    colorMode: 'smooth',
    gradientOpacity: 0.9,
    chunkLength: 'auto',
    showGradeLabels: true,
    dimCompleted: true,
    fontScale: 1,
    solidBackground: false,
    backgroundColor: '#00ff00',
    dataTransparency: 0.7,
    showDebug: false,
    climbSummary: true,
    summarySeconds: 12,
});

const settings = () => common.settingsStore.get();

let course;         // {key, mode, distances, elevations, laps, segments}
let profile;        // buildProfile() result for the course
let climbs = [];
let lastState;
let building;
let showList = false;       // route climbs list open
let effort = null;          // ClimbEffort for the climb being ridden (or just ahead)
let summary = null;         // {stats, until}: summary shown after topping a climb
let lastSampleTime = null;
let lastWeight = null;
let previewIndex = null;    // climb being previewed (index into climbs)


function isImperial() {
    let sauceImperial = common.settingsStore.get('/imperialUnits');
    if (sauceImperial == null) {
        sauceImperial = common.imperialUnits;
    }
    return resolveImperial(settings().units, sauceImperial);
}


// ---------- Course (the road ahead) ----------

function neededLaps(route, state) {
    return route?.supportedLaps ? Math.max(2, (state.laps || 0) + 2) : 1;
}

// Zwift/Sauce sometimes drop the routeId for a moment (e.g. when Sauce can't place
// the rider on the route), so keep using the last route for a while.
let lastRoute = null;
const routeMemoryMs = 120000;

// routeId -> whether the route supports laps (learned when the route loads)
const routeLapsSupport = new Map();

// Climb Portal: portal roads are numbered from 10000 and live in Sauce's 'portal' road set.
function isPortal(state) {
    return !!state.portal || state.roadId >= 10000;
}

// Climb Portal difficulty as a factor (1 = 100%); it scales the gradient like Sauce does.
function portalScale(state) {
    const s = state.portalElevationScale;
    return Number.isFinite(s) && s > 0 ? s / 100 : 1;
}

function courseKey(state) {
    if (isPortal(state) && state.roadId != null) {
        return `portal:${state.roadId}:${!!state.reverse}:${Math.round(portalScale(state) * 100)}`;
    }
    if (state.eventSubgroupId) {
        return `event:${state.eventSubgroupId}`;
    }
    let routeId = state.routeId;
    if (routeId) {
        lastRoute = {routeId, seen: Date.now()};
    } else if (lastRoute && Date.now() - lastRoute.seen < routeMemoryMs) {
        routeId = lastRoute.routeId;
    }
    if (routeId) {
        const laps = routeLapsSupport.get(routeId) === false ? 1 : Math.max(2, (state.laps || 0) + 2);
        return `route:${routeId}:${laps}`;
    } else if (state.roadId != null) {
        return `road:${state.courseId}:${state.roadId}:${!!state.reverse}`;
    }
    return null;
}

async function getSegmentNames(ids) {
    const names = new Map();
    if (!ids.length) {
        return names;
    }
    try {
        for (const x of await common.getSegments(ids)) {
            if (x && x.name) {
                names.set(x.id, x.name);
            }
        }
    } catch(e) {
        console.warn('Hill Radar: segment lookup failed', e);
    }
    return names;
}

async function buildRouteCourse(state, key) {
    let routeId = state.routeId || (lastRoute && lastRoute.routeId);
    let laps = null;
    let distance = null;
    if (state.eventSubgroupId) {
        const sg = await common.getEventSubgroup(state.eventSubgroupId);
        if (sg && sg.routeId) {
            routeId = sg.routeId;
            laps = sg.laps || 1;
            distance = sg.distanceInMeters || null;
        }
    }
    if (!routeId) {
        return null;
    }
    const route = await common.getRoute(routeId);
    if (!route || !route.distances || !route.elevations) {
        return null;
    }
    if (!state.eventSubgroupId) {
        routeLapsSupport.set(routeId, !!route.supportedLaps);
        key = courseKey(state);
    }
    if (laps == null) {
        laps = neededLaps(route, state);
    }
    if (distance) {
        laps = route.supportedLaps ? 1000 : 1;
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
    for (let lap = 1; lap < laps && !(distance && distances[distances.length - 1] >= distance); lap++) {
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
    if (distance) {
        while (distances.length > 2 && distances[distances.length - 1] > distance) {
            distances.pop();
            elevations.pop();
        }
        const end = distances[distances.length - 1];
        while (lapList.length > 1 && lapList[lapList.length - 1].offset >= end) {
            lapList.pop();
        }
        const last = lapList[lapList.length - 1];
        last.distance = end - last.offset;
    }
    // Named segments (KOMs etc.) for naming climbs
    const routeSegments = (route.segments || []).filter(x => !x.weldOnly);
    const names = await getSegmentNames(Array.from(new Set(routeSegments.map(x => x.id))));
    const segments = [];
    for (const [i, lap] of lapList.entries()) {
        for (const x of routeSegments) {
            if (i > 0 && x.leadinOnly) {
                continue;
            }
            const start = lap.lapStart + x.offset;
            if (names.has(x.id) && start < distances[distances.length - 1]) {
                segments.push({name: names.get(x.id), start, end: start + x.distance});
            }
        }
    }
    const sections = (route.sections || []).filter(x => x.roadCurvePath && !x.weld);
    return {key, mode: 'route', routeId, name: route.name, distances, elevations, laps: lapList, segments,
            sections, lapLength: lapDistances[lapDistances.length - 1]};
}

async function buildRoadCourse(state, key) {
    if (typeof common.getRoad !== 'function') {
        return null;
    }
    const road = await common.getRoad(state.courseId, state.roadId);
    if (!road || !road.distances || !road.elevations) {
        return null;
    }
    let distances = Array.from(road.distances);
    let elevations = Array.from(road.elevations);
    if (state.reverse) {
        const total = distances[distances.length - 1];
        distances = distances.reverse().map(x => total - x);
        elevations = elevations.reverse();
    }
    return {key, mode: 'road', road, reverse: !!state.reverse, distances, elevations, segments: []};
}

async function buildPortalCourse(state, key) {
    if (typeof common.getRoad !== 'function') {
        return null;
    }
    const road = await common.getRoad('portal', state.roadId);
    if (!road || !road.distances || !road.elevations) {
        return null;
    }
    let distances = Array.from(road.distances);
    let elevations = Array.from(road.elevations);
    if (state.reverse) {
        const total = distances[distances.length - 1];
        distances = distances.reverse().map(x => total - x);
        elevations = elevations.reverse();
    }
    // Difficulty scales the gradient, so scale the height gained from the bottom.
    const scale = portalScale(state);
    const base = elevations[0];
    elevations = elevations.map(x => base + (x - base) * scale);
    // The portal climb road is shown as one whole climb, like Zwift does. Known climbs
    // have names; newer ones (not in the list yet) are recognised by actually climbing.
    // Other portal roads, e.g. a flat lead-in, get normal detection.
    const info = portalClimbs[state.roadId];
    const length = distances[distances.length - 1] - distances[0];
    const gain100 = (elevations[elevations.length - 1] - base) / scale;  // at 100% difficulty
    const isClimb = !!info || (gain100 >= 10 && length > 0 && gain100 / length >= 0.01);
    const name = info ? info[0] : isClimb ? 'Climb Portal climb' : 'Climb Portal';
    const segments = isClimb ?
        [{name, start: distances[0], end: distances[distances.length - 1], always: true}] :
        [];
    return {key, mode: 'road', portal: true, portalClimb: isClimb, scale, name, road, reverse: !!state.reverse,
            distances, elevations, segments};
}

async function buildCourse(state, key) {
    if (key.startsWith('portal:')) {
        return await buildPortalCourse(state, key);
    }
    if (key.startsWith('road:')) {
        return await buildRoadCourse(state, key);
    }
    return await buildRouteCourse(state, key);
}

let lastPosition = null;  // {pos, time}
let positionSource = null;

// Rider's distance along a route section, like Sauce does it, or undefined.
function sectionDistance(section, state) {
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

function routePosition(state) {
    const lapIdx = Math.min(state.laps || 0, course.laps.length - 1);
    const lap = course.laps[lapIdx];
    // 1. Sauce's own route distance
    if (state.routeDistance != null && state.routeEnd != null &&
        (!state.routeId || state.routeId === course.routeId)) {
        // The lap finish line is fixed, so use the distance left in the lap.
        positionSource = 'sauce';
        return lap.offset + lap.fullDistance - (state.routeEnd - state.routeDistance);
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
            });
        }
    }
    if (candidates.length) {
        positionSource = `road match (${candidates.length})`;
        // Pick the match nearest to: where the rider just was, else (first lap) the
        // distance ridden, else the lap progress estimate.
        let ref = lastPosition && lastPosition.base === baseKey(course.key) &&
            Date.now() - lastPosition.time < 30000 ? lastPosition.pos : null;
        if (ref == null && lapIdx === 0) {
            if (Number.isFinite(state.eventDistance) && state.eventDistance >= 0 && state.eventDistance < 500000) {
                ref = state.eventDistance;
            } else {
                const leadin = candidates.find(x => x.leadin);
                if (leadin) {
                    return leadin.pos;
                }
            }
        }
        if (ref == null) {
            ref = estimate;
        }
        if (ref == null) {
            return candidates[0].pos;
        }
        return candidates.reduce((a, b) => Math.abs(b.pos - ref) < Math.abs(a.pos - ref) ? b : a).pos;
    }
    positionSource = estimate != null ? 'lap progress' : 'unknown';
    return estimate ?? null;
}

// Distance along the course for the watched rider.
function coursePosition(state) {
    if (!course) {
        return null;
    }
    if (course.mode === 'route') {
        const pos = routePosition(state);
        if (pos != null && Number.isFinite(pos)) {
            lastPosition = {pos, time: Date.now(), base: baseKey(course.key)};
            return pos;
        }
        return null;
    }
    // Road mode (no route): same approach as Sauce's own elevation profile.
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

function nameClimbs() {
    for (const c of climbs) {
        if (c.segment) {
            c.name = c.segment.name;
            continue;
        }
        let best;
        let bestOverlap = 0;
        for (const s of course.segments) {
            const overlap = Math.min(c.end, s.end) - Math.max(c.start, s.start);
            const segLen = s.end - s.start;
            // Segment mostly inside the climb and covering a good part of it
            if (overlap > 0 && overlap >= segLen * 0.6 && overlap >= c.length * 0.3 && overlap > bestOverlap) {
                best = s;
                bestOverlap = overlap;
            }
        }
        if (!best) {
            // Climb inside a longer named KOM that isn't a climb by itself (e.g. Titans Grove KOM)
            for (const s of course.segments) {
                const overlap = Math.min(c.end, s.end) - Math.max(c.start, s.start);
                if (overlap >= c.length * 0.8 && overlap > bestOverlap && !/lap|loop|sprint/i.test(s.name)) {
                    best = s;
                    bestOverlap = overlap;
                }
            }
        }
        c.name = best ? best.name : null;
        if (!c.name && course.mode === 'route') {
            c.name = fallbackClimbName(course.name, c, course.laps);
        }
    }
}

function detect() {
    if (!course) {
        profile = null;
        climbs = [];
        previewIndex = null;
        return;
    }
    profile = buildProfile(course.distances, course.elevations);
    const previewStart = previewIndex != null && climbs[previewIndex] ? climbs[previewIndex].start : null;
    climbs = detectClimbs(profile, {
        minScore: DETECTION_SCORES[settings().detection] || DETECTION_SCORES.small,
        minGrade: settings().gentleClimbs ? GENTLE_MIN_GRADE : undefined,
        segments: course.segments,
    });
    nameClimbs();
    if (previewStart != null) {
        const same = climbs.find(c => Math.abs(c.start - previewStart) < 1);
        previewIndex = same ? same.index : null;
    }
}

// Course key without the planned lap count (same route, same ride)
function baseKey(key) {
    return key ? key.replace(/^(route:[^:]+):\d+$/, '$1') : key;
}

let failedBuild = null;   // {key, time}: don't retry a failed load every update
let lastAthleteId = null;
let lastBaseKey = null;

async function onWatching(ad) {
    const state = ad && ad.state;
    if (!state) {
        return;
    }
    lastState = state;
    if (ad.athlete && ad.athlete.weight > 0) {
        lastWeight = ad.athlete.weight;
    }
    if (ad.athleteId !== lastAthleteId) {
        // Watching someone else: forget where the previous rider was
        lastAthleteId = ad.athleteId;
        lastPosition = null;
        previewIndex = null;
        effort = null;
        summary = null;
        lastWeight = ad.athlete && ad.athlete.weight > 0 ? ad.athlete.weight : null;
    }
    const key = courseKey(state);
    if (baseKey(key) !== lastBaseKey) {
        lastBaseKey = baseKey(key);
        lastPosition = null;
        previewIndex = null;
        effort = null;
    }
    const recentlyFailed = failedBuild && failedBuild.key === key && Date.now() - failedBuild.time < 15000;
    if (!key) {
        if (course) {
            course = null;
            detect();
        }
    } else if ((!course || course.key !== key) && !building && !recentlyFailed) {
        building = buildCourse(state, key).then(c => {
            course = c;
            failedBuild = c ? null : {key, time: Date.now()};
            detect();
        }).catch(e => {
            console.error('Hill Radar: failed to load course', e);
            failedBuild = {key, time: Date.now()};
            course = null;
            detect();
        }).finally(() => {
            building = null;
            render();
        });
    }
    render();
}


// ---------- Rendering ----------

function setStat(i, label, f) {
    const el = document.querySelector(`.stat[data-stat="${i}"]`);
    el.querySelector('.label').textContent = label;
    el.querySelector('.num').textContent = typeof f === 'string' ? f : f.value;
    el.querySelector('.unit').textContent = typeof f === 'string' ? '' : f.unit;
}

// Free ride on a lapped route: the course is planned a few laps ahead with no end.
function isOpenEnded() {
    return !!(course && course.key.startsWith('route:') && course.laps && course.laps.length > 1);
}

// Climbs are numbered from the start of the ride, counting every lap, so the
// climbs already done are included. The course always starts at the beginning
// of the ride, so this also holds after reopening the window mid-ride.
function climbNumberText(c) {
    const n = c.index + 1;
    const lap = course && course.laps && course.laps.length > 1 ? ` · lap ${lapOf(c.start) + 1}` : '';
    return (isOpenEnded() ? `#${n}` : `${n}/${climbs.length}`) + lap;
}

function climbTitle(c) {
    return c.name || `Climb ${c.index + 1}`;
}

function setBadge(el, c) {
    el.className = `cat-badge ${c.category.id}`;
    el.textContent = c.category.label;
    el.hidden = !c.category.label;
}

function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    if (parent) {
        parent.appendChild(el);
    }
    return el;
}

function renderProfile(climb, pos, progress, positionUnknown) {
    const svg = document.querySelector('.profile svg');
    const box = svg.parentElement.getBoundingClientRect();
    const width = Math.max(10, box.width);
    const height = Math.max(10, box.height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.replaceChildren();
    const s = settings();
    const fontPx = parseFloat(getComputedStyle(svg.parentElement).fontSize) || 12;
    const labelSize = fontPx * 0.8;
    const step = Math.max(profile.step, climb.length / Math.max(50, width));
    const points = [];
    for (let d = climb.start; d < climb.end; d += step) {
        points.push([d, elevationAt(profile, d)]);
    }
    points.push([climb.end, elevationAt(profile, climb.end)]);
    let minE = Infinity;
    let maxE = -Infinity;
    for (const [, e] of points) {
        minE = Math.min(minE, e);
        maxE = Math.max(maxE, e);
    }
    const pad = Math.max(3, (maxE - minE) * 0.08);
    const top = labelSize * 1.3;
    const bottom = height - 1;
    const x = d => (d - climb.start) / climb.length * width;
    const y = e => bottom - (e - (minE - pad)) / ((maxE + pad) - (minE - pad)) * (bottom - top);
    const chunkLen = s.chunkLength === 'auto' ? autoChunkLength(climb.length) : Number(s.chunkLength) || 250;
    const chunks = climbChunks(profile, climb, chunkLen);
    const opacity = Number(s.gradientOpacity) || 0.9;
    if (s.colorMode === 'sections') {
        for (const c of chunks) {
            const pts = points.filter(([d]) => d > c.start && d < c.end);
            pts.unshift([c.start, elevationAt(profile, c.start)]);
            pts.push([c.end, elevationAt(profile, c.end)]);
            const poly = pts.map(([d, e]) => `${x(d).toFixed(1)},${y(e).toFixed(1)}`);
            poly.push(`${x(c.end).toFixed(1)},${bottom}`, `${x(c.start).toFixed(1)},${bottom}`);
            svgEl('polygon', {points: poly.join(' '), fill: gradeColor(c.grade, s.colorScheme, opacity)}, svg);
        }
        for (const c of chunks.slice(1)) {
            svgEl('line', {class: 'chunk-sep', x1: x(c.start), x2: x(c.start),
                           y1: y(elevationAt(profile, c.start)), y2: bottom}, svg);
        }
    } else {
        // High resolution: a color stop every couple of pixels from the detailed grade.
        const defs = svgEl('defs', {}, svg);
        const gradId = 'hr-grade-fill';
        const grad = svgEl('linearGradient', {id: gradId, gradientUnits: 'userSpaceOnUse',
                                              x1: 0, y1: 0, x2: width, y2: 0}, defs);
        const stops = Math.max(2, Math.min(600, Math.round(width / 2)));
        const gradeWindow = Math.max(40, climb.length / stops * 2);
        for (let i = 0; i <= stops; i++) {
            const d = climb.start + climb.length * i / stops;
            svgEl('stop', {offset: (i / stops).toFixed(4),
                           'stop-color': gradeColor(gradeAt(profile, d, gradeWindow), s.colorScheme, 1)}, grad);
        }
        const poly = points.map(([d, e]) => `${x(d).toFixed(1)},${y(e).toFixed(1)}`);
        poly.push(`${width},${bottom}`, `0,${bottom}`);
        svgEl('polygon', {points: poly.join(' '), fill: `url(#${gradId})`, 'fill-opacity': opacity}, svg);
    }
    svgEl('polyline', {
        class: 'outline',
        points: points.map(([d, e]) => `${x(d).toFixed(1)},${y(e).toFixed(1)}`).join(' '),
    }, svg);
    if (s.showGradeLabels) {
        for (const c of chunks) {
            const w = x(c.end) - x(c.start);
            const g = Math.round(c.grade * 100);
            const text = w >= labelSize * 2.6 ? `${g}%` : w >= labelSize * 1.5 ? `${g}` : null;
            if (text) {
                const t = svgEl('text', {class: 'grade-label', x: x(c.start) + w / 2,
                                         y: bottom - labelSize * 0.4, 'font-size': labelSize}, svg);
                t.textContent = text;
            }
        }
    }
    const imperial = isImperial();
    const summit = svgEl('text', {class: 'summit-label', x: width - 2, y: labelSize, 'font-size': labelSize * 0.9}, svg);
    summit.textContent = `▲ ${toText(formatElevation(climb.endElevation, imperial))}`;
    if (progress.state === 'climbing') {
        const px = x(pos);
        if (s.dimCompleted && px > 0) {
            svgEl('rect', {class: 'completed', x: 0, y: 0, width: px, height}, svg);
        }
        const py = y(elevationAt(profile, pos));
        svgEl('line', {class: 'rider-line', x1: px, x2: px, y1: py, y2: bottom}, svg);
        svgEl('circle', {class: 'rider-dot', cx: px, cy: py, r: Math.max(3, labelSize * 0.4)}, svg);
    } else {
        const t = svgEl('text', {class: 'base-label', x: 2, y: labelSize, 'font-size': labelSize * 0.9}, svg);
        t.textContent = positionUnknown ?
            `at ${toText(formatDistance(climb.start, imperial))}` :
            `▶ ${toText(formatDistance(progress.toStart, imperial))}`;
    }
}

// One row of a climb list (upcoming climbs and the route climbs list).
function climbRow(c, {title, where, classes=[]}) {
    const s = settings();
    const imperial = isImperial();
    const row = document.createElement('div');
    row.className = ['row', ...classes].join(' ');
    row.dataset.index = c.index;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = gradeColor(c.avgGrade, s.colorScheme, 1);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = title;
    const badge = document.createElement('span');
    setBadge(badge, c);
    const info = document.createElement('span');
    info.textContent = `${where} · ${toText(formatDistance(c.length, imperial))} · ` +
        `${toText(formatGrade(c.avgGrade))} · ${toText(formatElevation(c.ascent, imperial))}`;
    row.append(swatch, name, badge, info);
    return row;
}

// Replace a list's rows only when they changed, so a click isn't lost to an update.
function setRows(el, rows) {
    const sig = rows.map(x => x.outerHTML).join('');
    if (el._sig !== sig) {
        el._sig = sig;
        el.replaceChildren(...rows);
    }
}

function renderUpcoming(list, positionUnknown) {
    const imperial = isImperial();
    setRows(document.querySelector('.upcoming'), list.map(({climb: c, toStart}) => climbRow(c, {
        title: climbTitle(c),
        where: `${positionUnknown ? 'at' : 'in'} ${toText(formatDistance(toStart, imperial))}`,
    })));
}

function preview(index) {
    previewIndex = index;
    showList = false;
    render();
}

function lapOf(distance) {
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

// Climbs to list for the route: free rides are planned a few laps ahead, so list
// the lap being ridden; events list everything.
function routeListClimbs(pos, positionUnknown) {
    if (isOpenEnded()) {
        const lap = pos != null && !positionUnknown ? lapOf(pos) : 0;
        return {lap, list: climbs.filter(c => lapOf(c.start) === lap)};
    }
    return {lap: null, list: climbs};
}

function renderRouteList(pos, positionUnknown) {
    const el = document.querySelector('.route-list');
    const imperial = isImperial();
    const {lap, list} = routeListClimbs(pos, positionUnknown);
    const multiLap = course && !isOpenEnded() && course.laps && course.laps.length > 1;
    el.querySelector('.route-list-title').textContent =
        `${course?.name || 'Road ahead'}${lap != null ? ` · lap ${lap + 1}` : ''} · ` +
        `${list.length} climb${list.length === 1 ? '' : 's'}`;
    const rows = list.map(c => {
        const classes = [];
        if (!positionUnknown && pos != null) {
            if (c.end < pos) {
                classes.push('passed');
            } else if (c.start <= pos) {
                classes.push('current');
            }
        }
        return climbRow(c, {
            title: `${c.index + 1}. ${climbTitle(c)}` + (multiLap ? ` (lap ${lapOf(c.start) + 1})` : ''),
            where: `at ${toText(formatDistance(c.start, imperial))}`,
            classes,
        });
    });
    if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'idle';
        empty.textContent = course ? 'No climbs on this route' : 'No route selected';
        rows.push(empty);
    }
    setRows(el.querySelector('.rows'), rows);
}

function renderDebug(state, pos, positionUnknown) {
    const el = document.querySelector('.debug');
    el.hidden = !settings().showDebug;
    if (el.hidden) {
        return;
    }
    const v = x => x == null ? '-' : (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
    const st = state || {};
    el.textContent = [
        `pos ${positionUnknown ? 'unknown' : v(pos)} (${positionSource || '-'})`,
        `course ${course ? course.key : '-'}`,
        `routeId ${v(st.routeId)}`,
        `routeDistance ${v(st.routeDistance)} / routeEnd ${v(st.routeEnd)}`,
        `laps ${v(st.laps)}`,
        `progress ${v(st.progress)}`,
        `eventDistance ${v(st.eventDistance)}`,
        `road ${v(st.roadId)}${st.reverse ? ' rev' : ''} @ ${v(st.roadTime)}`,
    ].join(' · ');
}

function render() {
    const content = document.getElementById('content');
    const climbEl = content.querySelector('.climb');
    const idleEl = content.querySelector('.idle');
    const s = settings();
    const imperial = isImperial();
    const state = lastState;
    let message = '';
    let climb = null;
    let pos = null;
    let progress = null;
    let positionUnknown = false;
    if (!state) {
        message = 'Waiting for rider data...';
    } else if (building && !course) {
        message = 'Loading route...';
    } else if (!course) {
        message = 'No route or road data';
    } else {
        pos = coursePosition(state);
        if (pos == null && course.mode === 'route') {
            // Position unknown (e.g. stopped off the route): show the route's climbs from the start.
            pos = 0;
            positionUnknown = true;
        }
        if (pos == null) {
            message = 'Waiting for position on road...';
        } else {
            climb = currentOrNextClimb(climbs, pos);
            if (climb) {
                progress = positionUnknown ?
                    {state: 'approaching', toStart: null} :
                    riderProgress(profile, climb, pos);
                const approach = Number(s.approachDistance) || 0;
                const approachMeters = approach * (imperial ? metersPerMile : 1000);
                if (!positionUnknown && progress.state === 'approaching' && approach > 0 &&
                    progress.toStart > approachMeters) {
                    message = `Next climb in ${toText(formatDistance(progress.toStart, imperial))}`;
                    climb = null;
                }
            } else {
                message = course.portal && !course.portalClimb ?
                    'Climb Portal: the climb shows when you reach it' :
                    climbs.length ? 'No more climbs' : 'No climbs on this route';
            }
        }
    }
    renderDebug(state, pos, positionUnknown);
    trackEffort(state, pos, positionUnknown);
    const summaryEl = content.querySelector('.summary');
    const showSummary = !!(summary && Date.now() < summary.until && previewIndex == null && !showList);
    summaryEl.hidden = !showSummary;
    if (showSummary) {
        renderSummary(summaryEl, summary.stats);
    }
    const listEl = content.querySelector('.route-list');
    listEl.hidden = !showList;
    if (showList) {
        climbEl.hidden = true;
        idleEl.textContent = '';
        content.classList.remove('hide-idle');
        renderUpcoming([], positionUnknown);
        renderRouteList(pos, positionUnknown);
        return;
    }
    const liveClimb = climb;
    let previewing = false;
    if (previewIndex != null && climbs[previewIndex]) {
        climb = climbs[previewIndex];
        previewing = true;
        const known = pos != null && !positionUnknown;
        if (known && pos >= climb.start && pos <= climb.end) {
            progress = riderProgress(profile, climb, pos);
        } else {
            progress = {state: 'approaching', toStart: known && pos < climb.start ? climb.start - pos : null};
        }
    }
    climbEl.hidden = !climb || showSummary;
    climbEl.classList.toggle('previewing', previewing);
    climbEl.querySelector('.preview-close').hidden = !previewing;
    idleEl.textContent = climb || showSummary ? '' : message;
    content.classList.toggle('hide-idle', !climb && !showSummary && !!s.hideWhenIdle);
    // Later climbs
    const upcoming = [];
    const count = Number(s.upcomingCount) || 0;
    if (pos != null && count > 0) {
        const after = liveClimb ? climbs.filter(x => x.start > liveClimb.end) : climbs.filter(x => x.start > pos);
        for (const c of after.slice(0, count)) {
            upcoming.push({climb: c, toStart: c.start - pos});
        }
    }
    renderUpcoming(upcoming, positionUnknown);
    if (!climb || showSummary) {
        return;
    }
    const header = climbEl.querySelector('.climb-header');
    setBadge(header.querySelector('.cat-badge'), climb);
    header.querySelector('.climb-name').textContent = climbTitle(climb);
    header.querySelector('.climb-meta').textContent =
        (previewing ? 'Preview · ' : '') +
        `${climbNumberText(climb)} · max ${toText(formatGrade(climb.maxGrade, 0))}` +
        (positionUnknown && !previewing ? ' · position unknown' : '');
    // "Starts at" (from the route start) when we can't say how far away it is
    const showAt = positionUnknown || (progress.state === 'approaching' && progress.toStart == null);
    if (progress.state === 'climbing') {
        setStat(0, 'To top', formatDistance(progress.remaining, imperial));
        setStat(1, 'Climb left', formatElevation(progress.remainingAscent, imperial));
        setStat(2, 'Grade', formatGrade(state.grade));
        setStat(3, 'Avg left', formatGrade(progress.remainingGrade));
    } else if (showAt) {
        setStat(0, 'Starts at', formatDistance(climb.start, imperial));
        setStat(1, 'Length', formatDistance(climb.length, imperial));
        setStat(2, 'Ascent', formatElevation(climb.ascent, imperial));
        setStat(3, 'Avg grade', formatGrade(climb.avgGrade));
    } else {
        setStat(0, 'Starts in', formatDistance(progress.toStart, imperial));
        setStat(1, 'Length', formatDistance(climb.length, imperial));
        setStat(2, 'Ascent', formatElevation(climb.ascent, imperial));
        setStat(3, 'Avg grade', formatGrade(climb.avgGrade));
    }
    renderProfile(climb, pos, progress, showAt);
}

// ---------- Climb summary ----------

function trackEffort(state, pos, positionUnknown) {
    if (!state || pos == null || positionUnknown || !climbs.length ||
        !(course?.mode === 'route' || course?.portal)) {
        return;
    }
    const t = Number.isFinite(state.worldTime) ? state.worldTime / 1000 : Date.now() / 1000;
    if (t === lastSampleTime) {
        return;  // same update drawn again (e.g. window resize)
    }
    lastSampleTime = t;
    const sample = {t, pos, power: state.power, hr: state.heartrate, cadence: state.cadence, weight: lastWeight};
    if (effort) {
        const stillThere = climbs.some(c => Math.abs(c.start - effort.climb.start) < 1);
        const jumped = effort.last && Math.abs(pos - effort.last.pos) > 2000;
        if (!stillThere || jumped || pos < effort.climb.start - 1500) {
            effort = null;  // route changed, climbs re-detected, teleport or turned back
        }
    }
    if (effort) {
        if (effort.add(sample)) {
            finishEffort(effort);
            effort = null;
        } else if (pos > effort.climb.end) {
            effort = null;
        }
        if (effort) {
            return;
        }
    }
    // Start following the climb being ridden, or the next one within 1 km
    const next = climbs.find(c => pos >= c.start - 1000 && pos < c.end);
    if (next) {
        effort = new ClimbEffort(next);
        effort.add(sample);
    }
}

function finishEffort(e) {
    const s = settings();
    if (s.climbSummary === false || e.coverage() < 0.5) {
        return;
    }
    const top = ascentAt(profile, e.climb.end);
    const stats = e.summary(pos => Math.max(0, top - ascentAt(profile, pos)));
    if (!stats) {
        return;
    }
    const seconds = Math.min(60, Math.max(3, Number(s.summarySeconds) || 12));
    summary = {stats, until: Date.now() + seconds * 1000};
    setTimeout(render, seconds * 1000 + 50);
}

function setSummaryStat(el, i, label, f) {
    const cell = el.querySelector(`.stat[data-sstat="${i}"]`);
    cell.querySelector('.label').textContent = label;
    cell.querySelector('.num').textContent = typeof f === 'string' ? f : f.value;
    cell.querySelector('.unit').textContent = typeof f === 'string' ? '' : f.unit;
}

function renderSummary(el, x) {
    const imperial = isImperial();
    const c = x.climb;
    el.querySelector('.climb-name').textContent = climbTitle(c);
    el.querySelector('.climb-meta').textContent =
        `${toText(formatDistance(x.distance, imperial))} · ${toText(formatGrade(c.avgGrade))}` +
        (x.partial ? ' · partial' : '');
    const num = v => v == null || !Number.isFinite(v) ? '-' : null;
    setSummaryStat(el, 0, 'Time', formatDuration(x.time));
    setSummaryStat(el, 1, 'Avg power', num(x.avgPower) ?? {value: Math.round(x.avgPower).toString(), unit: 'w'});
    setSummaryStat(el, 2, 'W/kg', num(x.wkg) ?? x.wkg.toFixed(1));
    setSummaryStat(el, 3, 'VAM', num(x.vam) ?? (imperial ?
        {value: Math.round(x.vam * 3.28084).toString(), unit: 'ft/h'} :
        {value: Math.round(x.vam).toString(), unit: 'm/h'}));
    setSummaryStat(el, 4, 'Avg HR', num(x.avgHR) ?? {value: Math.round(x.avgHR).toString(), unit: 'bpm'});
    setSummaryStat(el, 5, 'Max HR', num(x.maxHR) ?? {value: Math.round(x.maxHR).toString(), unit: 'bpm'});
    setSummaryStat(el, 6, 'Avg speed', num(x.avgSpeed) ?? (imperial ?
        {value: (x.avgSpeed / 1.609344).toFixed(1), unit: 'mph'} :
        {value: x.avgSpeed.toFixed(1), unit: 'kph'}));
    setSummaryStat(el, 7, 'Cadence', num(x.avgCadence) ?? {value: Math.round(x.avgCadence).toString(), unit: 'rpm'});
}


function applyAppearance() {
    const s = settings();
    doc.style.setProperty('--font-scale', s.fontScale || 1);
    doc.style.setProperty('--data-transparency', s.dataTransparency ?? 0.7);
    if (typeof common.setBackground === 'function') {
        common.setBackground(s);
    }
}


export async function main() {
    common.initInteractionListeners();
    applyAppearance();
    common.settingsStore.addEventListener('changed', ev => {
        const changed = ev.data && ev.data.changed;
        if (changed && (changed.has('detection') || changed.has('gentleClimbs'))) {
            detect();
        }
        applyAppearance();
        render();
    });
    new ResizeObserver(() => render()).observe(document.querySelector('.profile'));
    // Clicking any listed climb previews it. pointerdown on the list itself, so a
    // press is never lost when the rows update.
    for (const list of document.querySelectorAll('.upcoming, .route-list .rows')) {
        list.addEventListener('pointerdown', ev => {
            const row = ev.target.closest('.row[data-index]');
            if (row && ev.button === 0) {
                preview(Number(row.dataset.index));
            }
        });
    }
    document.getElementById('route-climbs-button').addEventListener('click', () => {
        showList = !showList;
        render();
    });
    document.querySelector('.route-list-close').addEventListener('click', () => {
        showList = false;
        render();
    });
    document.querySelector('.summary-close').addEventListener('click', () => {
        summary = null;
        render();
    });
    document.querySelector('.preview-close').addEventListener('click', () => {
        previewIndex = null;
        render();
    });
    common.subscribe('athlete/watching', onWatching);
    render();
}


// ---------- Settings page ----------

export async function settingsMain() {
    common.initInteractionListeners();
    await common.initSettingsForm('form#options')();
}
