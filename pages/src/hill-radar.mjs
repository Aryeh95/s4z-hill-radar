import * as common from '/pages/src/common.mjs';
import {buildProfile, detectClimbs, riderProgress, currentOrNextClimb, climbChunks,
        autoChunkLength, elevationAt, gradeAt, ascentAt, portalClimbStart, portalClimbEnd, climbsFromStart,
        detectClimbsSplit,
        DETECTION_SCORES} from './climbs.mjs';
import {ClimbEffort, ClimbHistory, formatDuration, formatDelta, estimateTimeLeft} from './effort.mjs';
import {gradeColor, gradeTextColor, parseRgb} from './colors.mjs';
import {fallbackClimbName, climbNameByShape} from './names.mjs';
import {portalClimbs} from './climb-names.mjs';
import {isVideoRoad, videoRoad, videoRoadOffset, videoCourseId} from './video.mjs';
import * as C from './course.mjs';
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
    zoomProfile: 'off',
    zoomMinLength: 3,  // km or mi
    showGradeLabels: true,
    dimCompleted: true,
    showSegmentFlags: true,
    showRiders: false,
    colorGradeNumber: false,
    fontScale: 1,
    solidBackground: false,
    backgroundColor: '#00ff00',
    dataTransparency: 0.7,
    showDebug: false,
    climbSummary: true,
    summarySeconds: 12,
    summaryProfile: true,
    summaryStat1: 'time',
    summaryStat2: 'avgPower',
    summaryStat3: 'wkg',
    summaryStat4: 'vam',
    summaryStat5: 'avgHR',
    summaryStat6: 'maxHR',
    summaryStat7: 'avgSpeed',
    summaryStat8: 'avgCadence',
    liveStats: false,
    liveStat1: 'time',
    liveStat2: 'avgPower',
    liveStat3: 'wkg',
    liveStat4: 'avgHR',
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
// Video route roads (course 18) are numbered from 20000 and aren't portal roads.
function isPortal(state) {
    return !!state.portal || (state.roadId >= 10000 && state.courseId !== videoCourseId);
}

// Climb Portal difficulty as a factor (1 = 100%); it scales the gradient like Sauce does.
function portalScale(state) {
    const s = state.portalElevationScale;
    return Number.isFinite(s) && s > 0 ? s / 100 : 1;
}

// Routes Sauce doesn't have yet (e.g. new routes on a new map before Sauce's data is
// updated): course key -> when that was found. Meanwhile the current road is shown.
const missingRoutes = new Map();
const missingRouteRetryMs = 10 * 60 * 1000;

function routeMissing(key) {
    const t = missingRoutes.get(key);
    return t != null && Date.now() - t < missingRouteRetryMs;
}

function courseKey(state) {
    // Video routes are one road each; Hill Radar has its own copy of the known ones.
    if (isVideoRoad(state.courseId, state.roadId)) {
        return `video:${state.roadId}`;
    }
    if (isPortal(state) && state.roadId != null) {
        return `portal:${state.roadId}:${!!state.reverse}:${Math.round(portalScale(state) * 100)}`;
    }
    const key = routeCourseKey(state);
    if (key && routeMissing(key) && state.roadId != null) {
        return `road:${state.courseId}:${state.roadId}:${!!state.reverse}`;
    }
    return key;
}

function routeCourseKey(state) {
    if (state.eventSubgroupId) {
        // Planned a lap or two past the rider, like free ride, to keep riding after the finish
        return `event:${state.eventSubgroupId}:${Math.max(2, (state.laps || 0) + 2)}`;
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
    let eventLaps = null;
    let distance = null;
    if (state.eventSubgroupId) {
        const sg = await common.getEventSubgroup(state.eventSubgroupId);
        if (sg && sg.routeId) {
            routeId = sg.routeId;
            eventLaps = sg.laps || 1;
            distance = sg.distanceInMeters || null;
        }
    }
    if (!routeId) {
        return null;
    }
    const route = await common.getRoute(routeId);
    if (!route || !route.distances || !route.elevations) {
        missingRoutes.set(key, Date.now());
        return null;
    }
    if (!state.eventSubgroupId) {
        routeLapsSupport.set(routeId, !!route.supportedLaps);
        key = courseKey(state);
    }
    const routeSegments = (route.segments || []).filter(x => !x.weldOnly);
    const segmentNames = await getSegmentNames(Array.from(new Set(routeSegments.map(x => x.id))));
    const layout = C.assembleRoute(route, {eventLaps, distance, minLaps: neededLaps(route, state), segmentNames});
    return {key, mode: 'route', routeId, name: route.name, courseId: route.courseId ?? state.courseId,
            eventLaps, ...layout};
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
    const routeKey = routeCourseKey(state);
    return {key, mode: 'road', road, reverse: !!state.reverse, courseId: state.courseId, distances, elevations,
            segments: await roadSegments(state, road, distances[distances.length - 1]),
            routeMissing: !!routeKey && routeMissing(routeKey)};
}

// Official segments (KOMs etc.) on this road in the riding direction, on the course's distance
// scale, so climbs get their names and full length without a route too.
async function roadSegments(state, road, total) {
    const rcp = road.curvePath;
    if (!common.rpc || typeof common.rpc.getSegmentsForRoad !== 'function' || !rcp ||
        typeof rcp.distanceAtRoadPercent !== 'function') {
        return [];
    }
    let list;
    try {
        list = await common.rpc.getSegmentsForRoad(state.courseId, state.roadId, !!state.reverse);
    } catch(e) {
        return [];
    }
    const segments = [];
    for (const x of list || []) {
        if (!x || !x.name || !Number.isFinite(x.roadStart) || !Number.isFinite(x.roadFinish)) {
            continue;
        }
        let a = rcp.distanceAtRoadPercent(x.roadStart) / 100;
        let b = rcp.distanceAtRoadPercent(x.roadFinish) / 100;
        if (state.reverse) {
            [a, b] = [total - a, total - b];
        }
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) {  // skips segments that wrap round a loop
            segments.push({name: x.name, start: a, end: b});
        }
    }
    return segments;
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
    // The climb runs from the bottom to Zwift's finish gate, not the flat run-out past it.
    // Sauce 2.3+ gives the gate's position and the climb's name; otherwise end at the top.
    const total = distances[distances.length - 1];
    let end = portalGateDistance(road, total, !!state.reverse);
    const gate = end != null;
    if (!gate) {
        end = portalClimbEnd(distances, elevations);
    }
    const start = portalClimbStart(distances, elevations, end);
    // Difficulty scales the gradient, so scale the height gained from the bottom.
    const scale = portalScale(state);
    const base = elevations[0];
    elevations = elevations.map(x => base + (x - base) * scale);
    // Older Sauce: known climbs are named from a list; newer ones are recognised by
    // actually climbing. Other portal roads get normal detection.
    const info = portalClimbs[state.roadId];
    const length = end - start;
    const top = Math.max(...elevations.filter((x, i) => distances[i] >= start && distances[i] <= end));
    const gain100 = (top - (elevations[distances.indexOf(start)] ?? base)) / scale;  // at 100% difficulty
    const isClimb = !!road.portalName || !!info || (gain100 >= 10 && length > 0 && gain100 / length >= 0.01);
    const name = road.portalName || (info ? info[0] : isClimb ? 'Climb Portal climb' : 'Climb Portal');
    const segments = isClimb ? [{name, start, end, always: true}] : [];
    return {key, mode: 'road', portal: true, portalClimb: isClimb, scale, name, road, reverse: !!state.reverse,
            gate, distances, elevations, segments};
}

// Distance along the portal road to Zwift's finish gate (Sauce 2.3+), or undefined.
function portalGateDistance(road, total, reverse) {
    const rp = road.portalRoadEndGateRoadTime;
    const rcp = road.curvePath;
    if (!(rp > 0 && rp < 1) || !rcp || typeof rcp.distanceAtRoadPercent !== 'function') {
        return;
    }
    let d = rcp.distanceAtRoadPercent(rp) / 100;
    if (reverse) {
        d = total - d;
    }
    // Sanity check: the finish is well into the road, not past its end
    return d > total * 0.25 && d <= total + 1 ? Math.min(d, total) : undefined;
}

// Video route: the whole road, from Hill Radar's copy (video-roads.mjs). Its timed segment
// (the main climb, where there is one) is named after the route.
function buildVideoCourse(state, key) {
    const road = videoRoad(state.roadId);
    if (!road) {
        return null;
    }
    return {key, mode: 'road', video: true, name: road.name, courseId: videoCourseId, reverse: false,
            road: {id: road.id, curvePath: {roadPercentToOffset: p => videoRoadOffset(road, p)}},
            distances: road.distances.slice(), elevations: road.elevations.slice(),
            segments: road.segments.map(x => ({name: road.name, start: x.start, end: x.end}))};
}

async function buildCourse(state, key) {
    if (key.startsWith('video:')) {
        return buildVideoCourse(state, key);
    }
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


function routePosition(state) {
    const recent = lastPosition && lastPosition.base === baseKey(course.key) &&
        Date.now() - lastPosition.time < 30000 ? lastPosition.pos : null;
    const {pos, source} = C.routePosition(course, state, recent);
    positionSource = source;
    return pos;
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
    return roadCoursePosition(state);
}

function roadCoursePosition(state) {
    return C.roadCoursePosition(course, state);
}

function nameClimbs() {
    for (const c of climbs) {
        if (c.segment) {
            c.name = c.segment.name;
            continue;
        }
        const best = C.segmentForClimb(c, course.segments);
        c.name = best ? best.name : null;
        if (!c.name && course.mode === 'route') {
            c.name = fallbackClimbName(course.name, c, course.laps);
        }
        if (!c.name && !course.portal) {
            // Same climb as a named one on another route (by elevation and shape)
            c.name = climbNameByShape(course.courseId, {
                startElevation: c.startElevation,
                endElevation: c.endElevation,
                length: c.length,
                shape: Array.from({length: 11}, (_, i) => elevationAt(profile, c.start + c.length * i / 10) - c.startElevation),
            });
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
    const options = {
        minScore: DETECTION_SCORES[settings().detection] || DETECTION_SCORES.small,
        minGrade: settings().gentleClimbs ? GENTLE_MIN_GRADE : undefined,
        segments: course.segments,
    };
    // Events: a climb that crosses the finish ends there; what's past it only counts if you ride on
    const found = course.finish != null ?
        detectClimbsSplit(course.distances, course.elevations, course.finish, options) :
        detectClimbs(profile, options);
    climbs = climbsFromStart(found, rideStart && rideStart.base === baseKey(course.key) ? rideStart.pos : 0);
    nameClimbs();
    if (previewStart != null) {
        const same = climbs.find(c => Math.abs(c.start - previewStart) < 1);
        previewIndex = same ? same.index : null;
    }
}

const baseKey = C.baseKey;

let failedBuild = null;   // {key, time}: don't retry a failed load every update
// Where the ride started on the route ({base, pos}), when Zwift put the rider past the start of
// the route's profile. Only learned at the start of a ride, so climbs are never renumbered mid-ride.
let rideStart = null;
const rideStartCheckMax = 1000;   // m ridden: later than this, it's not the start of the ride
const rideStartMin = 100;         // m past the profile's start before it counts
let lastRideDistance = null;
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
        rideStart = null;
        previewIndex = null;
        effort = null;
        summary = null;
        history.clear();
        lastWeight = ad.athlete && ad.athlete.weight > 0 ? ad.athlete.weight : null;
    }
    const key = courseKey(state);
    if (baseKey(key) !== lastBaseKey) {
        lastBaseKey = baseKey(key);
        lastPosition = null;
        previewIndex = null;
        effort = null;
    }
    // A new ride (Zwift's ride distance starts again): learn where it starts again
    if (Number.isFinite(state.distance)) {
        if (lastRideDistance != null && state.distance < lastRideDistance - 100 && rideStart) {
            rideStart = null;
            if (course) {
                detect();
            }
        }
        lastRideDistance = state.distance;
    }
    if (course && course.key === key) {
        learnRideStart(state);
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


// At the start of a ride on a route (first lap, little ridden yet), note where the rider is: a
// climb mostly behind that point is never ridden (see climbsFromStart). Decided once per route.
function learnRideStart(state) {
    const base = baseKey(course.key);
    if (course.mode !== 'route' || (rideStart && rideStart.base === base)) {
        return;
    }
    if ((state.laps || 0) > 0 || !Number.isFinite(state.distance) || state.distance < 0) {
        return;
    }
    const pos = coursePosition(state);
    if (pos == null || !Number.isFinite(pos)) {
        return;
    }
    const start = state.distance <= rideStartCheckMax ? pos - state.distance : 0;
    rideStart = {base, pos: start >= rideStartMin ? start : 0};
    if (rideStart.pos) {
        detect();
    }
}

// ---------- Rendering ----------

function setStat(i, label, f, color='') {
    const el = document.querySelector(`.stat[data-stat="${i}"]`);
    el.querySelector('.label').textContent = label;
    el.querySelector('.num').textContent = typeof f === 'string' ? f : f.value;
    el.querySelector('.unit').textContent = typeof f === 'string' ? '' : f.unit;
    el.querySelector('.value').style.color = color;
}

function isOpenEnded() {
    return C.isOpenEnded(course);
}

function afterFinish(pos) {
    return C.afterFinish(course, pos);
}


let renderPos = null;  // the rider's position as last rendered, for the climb and lap counts

function climbNumberText(c) {
    return C.climbNumberText(course, climbs, c, renderPos);
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

// The climb's terrain: gradient fill, outline, section grades, segment flags and summit height.
function drawTerrain(g, {climb, points, flags, flagH, labelSize, width, bottom, x, y, chunkLen, opacity, imperial}) {
    const s = settings();
    const chunks = climbChunks(profile, climb, chunkLen);
    if (s.colorMode === 'sections') {
        for (const c of chunks) {
            const pts = points.filter(([d]) => d > c.start && d < c.end);
            pts.unshift([c.start, elevationAt(profile, c.start)]);
            pts.push([c.end, elevationAt(profile, c.end)]);
            const poly = pts.map(([d, e]) => `${x(d).toFixed(1)},${y(e).toFixed(1)}`);
            poly.push(`${x(c.end).toFixed(1)},${bottom}`, `${x(c.start).toFixed(1)},${bottom}`);
            svgEl('polygon', {points: poly.join(' '), fill: gradeColor(c.grade, s.colorScheme, opacity)}, g);
        }
        for (const c of chunks.slice(1)) {
            svgEl('line', {class: 'chunk-sep', x1: x(c.start), x2: x(c.start),
                           y1: y(elevationAt(profile, c.start)), y2: bottom}, g);
        }
    } else {
        // High resolution: a color stop every couple of pixels from the detailed grade.
        const defs = svgEl('defs', {}, g);
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
        svgEl('polygon', {points: poly.join(' '), fill: `url(#${gradId})`, 'fill-opacity': opacity}, g);
    }
    svgEl('polyline', {
        class: 'outline',
        points: points.map(([d, e]) => `${x(d).toFixed(1)},${y(e).toFixed(1)}`).join(' '),
    }, g);
    if (s.showGradeLabels) {
        for (const c of chunks) {
            const w = x(c.end) - x(c.start);
            const pct = Math.round(c.grade * 100);
            const text = w >= labelSize * 2.6 ? `${pct}%` : w >= labelSize * 1.5 ? `${pct}` : null;
            if (text) {
                const t = svgEl('text', {class: 'grade-label', x: x(c.start) + w / 2,
                                         y: bottom - labelSize * 0.4, 'font-size': labelSize}, g);
                t.textContent = text;
            }
        }
    }
    for (const f of flags) {
        drawSegmentFlag(g, f, climb.segment.name, x(f.distance), y(elevationAt(profile, f.distance)), flagH, width);
    }
    const summit = svgEl('text', {class: 'summit-label', x: width - 2, y: labelSize, 'font-size': labelSize * 0.9}, g);
    summit.textContent = `▲ ${toText(formatElevation(climb.endElevation, imperial))}`;
}

function renderProfile(climb, pos, progress, positionUnknown) {
    const svg = document.querySelector('.profile svg');
    const box = svg.parentElement.getBoundingClientRect();
    const width = Math.max(10, box.width);
    const height = Math.max(10, box.height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const s = settings();
    const fontPx = parseFloat(getComputedStyle(svg.parentElement).fontSize) || 12;
    const labelSize = fontPx * 0.8;
    // Zoom on long climbs: while climbing, the profile shows the stretch ahead and the whole
    // climb is a strip underneath. It moves on in small steps, so the terrain is redrawn rarely.
    const full = climb;
    const zoomLen = Number(s.zoomProfile) || 0;
    const zoomMin = (Number(s.zoomMinLength) || 0) * (isImperial() ? metersPerMile : 1000);
    const zoom = zoomLen > 0 && progress.state === 'climbing' && pos != null &&
        full.length > Math.max(zoomMin, zoomLen * 1.1);
    if (zoom) {
        const q = zoomLen / 40;
        const v0 = Math.min(full.end - zoomLen, Math.max(full.start, Math.round((pos - zoomLen * 0.2) / q) * q));
        climb = {...full, start: v0, end: v0 + zoomLen, length: zoomLen};
    }
    const stripH = zoom ? Math.max(10, Math.round(height * 0.16)) : 0;
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
    const flags = segmentFlags(climb);
    const flagH = labelSize * 1.6;
    const top = labelSize * 1.3 + (flags.length ? flagH * 0.9 : 0);
    const bottom = height - 1 - stripH;
    const x = d => (d - climb.start) / climb.length * width;
    const y = e => bottom - (e - (minE - pad)) / ((maxE + pad) - (minE - pad)) * (bottom - top);
    const chunkLen = s.chunkLength === 'auto' ? autoChunkLength(climb.length) : Number(s.chunkLength) || 250;
    const opacity = Number(s.gradientOpacity) || 0.9;
    const imperial = isImperial();
    // The terrain only changes with the climb, the window size or the look, so it's kept between
    // updates; only the live layer (you, the dimmed part, other riders) is redrawn each time.
    const terrainKey = JSON.stringify([course?.key, full.start, climb.start, climb.end, width, height, fontPx,
        imperial, s.colorScheme, s.colorMode, opacity, chunkLen, !!s.showGradeLabels, flags.map(f => f.distance)]);
    let terrain = svg.querySelector(':scope > g.terrain');
    if (!terrain || terrain.dataset.key !== terrainKey) {
        svg.replaceChildren();
        terrain = svgEl('g', {class: 'terrain'}, svg);
        terrain.dataset.key = terrainKey;
        drawTerrain(terrain, {climb, points, flags, flagH, labelSize, width, bottom, x, y, chunkLen, opacity, imperial});
        if (zoom) {
            drawZoomStrip(terrain, full, climb, width, height, stripH, s.colorScheme, opacity);
        }
    }
    svg.querySelector(':scope > g.live')?.remove();
    const live = svgEl('g', {class: 'live'}, svg);
    if (s.showRiders && !positionUnknown && pos != null) {
        for (const r of ridersOnClimb(climb, pos)) {
            const dot = svgEl('circle', {class: `other-rider${r.marked ? ' marked' : ''}`, cx: x(r.distance),
                                         cy: y(elevationAt(profile, r.distance)), r: Math.max(2, labelSize * 0.32)}, live);
            const gap = toText(formatDistance(Math.abs(r.gap), isImperial()));
            svgEl('title', {}, dot).textContent = `${r.name ? r.name + ' · ' : ''}${gap} ${r.gap < 0 ? 'ahead' : 'behind'}`;
        }
    }
    if (progress.state === 'climbing') {
        const px = x(pos);
        if (s.dimCompleted && px > 0) {
            // Only the profile itself, up to where you are
            const done = points.filter(([d]) => d < pos).map(([d, e]) => `${x(d).toFixed(1)},${y(e).toFixed(1)}`);
            done.push(`${px.toFixed(1)},${y(elevationAt(profile, pos)).toFixed(1)}`,
                      `${px.toFixed(1)},${bottom}`, `0,${bottom}`);
            svgEl('polygon', {class: 'completed', points: done.join(' ')}, live);
        }
        // An arrow just above the line, so the gradient colour where you are stays visible
        const tip = y(elevationAt(profile, pos)) - Math.max(2, labelSize * 0.3);
        const w = Math.max(5, labelSize * 0.75);
        const h = Math.max(7, labelSize * 1.1);
        const ax = Math.min(width - w, Math.max(w, px));  // whole arrow inside the window at either end
        svgEl('polygon', {class: 'rider-marker', points: `${ax},${tip} ${ax - w},${tip - h} ${ax + w},${tip - h}`}, live);
        if (zoom) {
            const sx = (pos - full.start) / full.length * width;
            svgEl('line', {class: 'zoom-pos', x1: sx, x2: sx, y1: height - stripH + 1, y2: height}, live);
        }
    } else if (progress.state !== 'done') {
        const t = svgEl('text', {class: 'base-label', x: 2, y: labelSize, 'font-size': labelSize * 0.9}, live);
        t.textContent = positionUnknown ?
            `at ${toText(formatDistance(climb.start, imperial))}` :
            `▶ ${toText(formatDistance(progress.toStart, imperial))}`;
    }
    const stops = Math.max(2, Math.min(600, Math.round(width / 2)));
    profileView = {climb, width, bottom, labelSize, y, gradeWindow: Math.max(40, climb.length / stops * 2),
                   riderPos: progress.state === 'climbing' && pos != null ? pos : null};
    drawHover();
}

// The whole climb as a strip under a zoomed profile, in the gradient colors, with the part
// shown marked.
function drawZoomStrip(g, full, view, width, height, stripH, scheme, opacity) {
    const top = height - stripH + 2;
    const bottom = height - 1;
    const n = Math.max(20, Math.round(width / 3));
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const d = full.start + full.length * i / n;
        pts.push([d, elevationAt(profile, d)]);
    }
    const lo = Math.min(...pts.map(p => p[1]));
    const hi = Math.max(...pts.map(p => p[1]));
    const sx = d => (d - full.start) / full.length * width;
    const sy = e => bottom - (e - lo) / ((hi - lo) || 1) * (bottom - top);
    const poly = pts.map(([d, e]) => `${sx(d).toFixed(1)},${sy(e).toFixed(1)}`);
    poly.push(`${width},${bottom}`, `0,${bottom}`);
    const gradId = 'zoom-strip-fill';
    const grad = svgEl('linearGradient', {id: gradId, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: width, y2: 0},
                       svgEl('defs', {}, g));
    const stops = Math.max(2, Math.min(300, Math.round(width / 3)));
    const gradeWindow = Math.max(40, full.length / stops * 2);
    for (let i = 0; i <= stops; i++) {
        const d = full.start + full.length * i / stops;
        svgEl('stop', {offset: (i / stops).toFixed(4),
                       'stop-color': gradeColor(gradeAt(profile, d, gradeWindow), scheme, 1)}, grad);
    }
    svgEl('polygon', {class: 'zoom-strip', points: poly.join(' '), fill: `url(#${gradId})`, 'fill-opacity': opacity}, g);
    svgEl('rect', {class: 'zoom-window', x: sx(view.start), y: top - 1,
                   width: sx(view.end) - sx(view.start), height: bottom - top + 1}, g);
}

// ---------- Hover: grade at the pointer ----------

let profileView = null;  // how the profile was last drawn, for the hover readout
let hoverX = null;       // pointer position over the profile (px), or null

function drawHover() {
    const svg = document.querySelector('.profile svg');
    svg.querySelector('.hover')?.remove();
    const v = profileView;
    if (hoverX == null || !v || !profile) {
        return;
    }
    const px = Math.min(v.width, Math.max(0, hoverX));
    const d = v.climb.start + px / v.width * v.climb.length;
    const py = v.y(elevationAt(profile, d));
    const g = svgEl('g', {class: 'hover'}, svg);
    svgEl('line', {class: 'hover-line', x1: px, x2: px, y1: py, y2: v.bottom}, g);
    svgEl('circle', {class: 'hover-dot', cx: px, cy: py, r: Math.max(2.5, v.labelSize * 0.3)}, g);
    // Grade (same detail as the colors) and how far ahead of you (while climbing) or into the climb
    const left = px > v.width * 0.65;
    const t = svgEl('text', {class: 'hover-label', x: left ? px - 6 : px + 6,
                             y: Math.max(v.labelSize * 2.1, py - v.labelSize * 0.5),
                             'font-size': v.labelSize, 'text-anchor': left ? 'end' : 'start'}, g);
    const grade = svgEl('tspan', {class: 'hover-grade', 'font-size': v.labelSize * 1.25}, t);
    grade.textContent = toText(formatGrade(gradeAt(profile, d, v.gradeWindow)));
    const from = v.riderPos != null ? d - v.riderPos : d - v.climb.start;
    const sign = v.riderPos == null ? '' : from >= 0 ? '+' : '\u2212';
    svgEl('tspan', {}, t).textContent = ` · ${sign}${toText(formatDistance(Math.abs(from), isImperial()))}`;
}

// ---------- Other riders ----------

// Every rider's latest road position (Sauce's 'states' feed, which only sends riders whose
// state changed, so it's collected here), and the nearby list for names and Sauce's gaps.
const riderStates = new Map();  // athleteId -> {state, time}
let nearby = {time: 0, byId: new Map()};
let ridersSubscribed = false;

function onStates(data) {
    const now = Date.now();
    for (const st of Array.isArray(data) ? data : []) {
        if (st && st.athleteId != null) {
            riderStates.set(st.athleteId, {state: st, time: now});
        }
    }
}

function onNearby(data) {
    const byId = new Map();
    for (const ad of Array.isArray(data) ? data : []) {
        if (ad && ad.athleteId != null) {
            byId.set(ad.athleteId, ad);
        }
    }
    nearby = {time: Date.now(), byId};
}

// Only follow every rider's state while other riders are shown; stop (and forget them) when off.
function updateNearbySubscription() {
    const want = !!settings().showRiders;
    if (want && !ridersSubscribed) {
        ridersSubscribed = true;
        common.subscribe('states', onStates);
        common.subscribe('nearby', onNearby);
    } else if (!want && ridersSubscribed) {
        ridersSubscribed = false;
        if (typeof common.unsubscribe === 'function') {
            common.unsubscribe('states', onStates);
            common.unsubscribe('nearby', onNearby);
        }
        riderStates.clear();
        nearby = {time: 0, byId: new Map()};
    }
}

function otherRiderPosition(state, ref) {
    return C.otherRiderPosition(course, state, ref);
}

// Riders on this climb. Placed from their road position, so riders far up the road show
// too; riders Sauce only has a gap for are placed by the gap (negative = ahead).
function ridersOnClimb(climb, pos) {
    const now = Date.now();
    const nearbyFresh = now - nearby.time < 5000;
    const riders = [];
    const placed = new Set();
    const add = (id, distance, gap, ad) => {
        if (distance == null || distance < climb.start || distance > climb.end) {
            return;
        }
        const athlete = (ad && ad.athlete) || {};
        placed.add(id);
        riders.push({
            distance,
            gap,
            name: athlete.sanitizedFullname || athlete.fullname || null,
            marked: !!(athlete.marked || athlete.following),
        });
    };
    for (const [id, {state, time}] of riderStates) {
        if (now - time > 10000) {
            riderStates.delete(id);  // left the area or stopped sending
            continue;
        }
        if (id === lastAthleteId || (lastState && state.courseId != null && state.courseId !== lastState.courseId)) {
            continue;
        }
        const ad = nearbyFresh ? nearby.byId.get(id) : null;
        const sauceGap = ad && Number.isFinite(ad.gapDistance) ? ad.gapDistance : null;
        const distance = otherRiderPosition(state, sauceGap != null ? pos - sauceGap : pos);
        add(id, distance, distance != null ? pos - distance : null, ad);
    }
    if (nearbyFresh) {
        for (const [id, ad] of nearby.byId) {
            if (!placed.has(id) && !ad.watching && Number.isFinite(ad.gapDistance) && !riderStates.has(id)) {
                add(id, pos - ad.gapDistance, ad.gapDistance, ad);
            }
        }
    }
    // Marked and followed riders on top
    return riders.sort((a, b) => a.marked - b.marked);
}

function segmentFlags(climb) {
    return settings().showSegmentFlags ? C.segmentFlags(climb) : [];
}

// A flag on the profile line: a pennant for the segment start, checkered for the finish.
function drawSegmentFlag(svg, flag, name, fx, fy, size, width) {
    const g = svgEl('g', {class: `segment-flag ${flag.kind}`}, svg);
    svgEl('title', {}, g).textContent = `${flag.kind === 'start' ? 'Start' : 'Finish'} of ${name}`;
    const poleTop = fy - size;
    svgEl('line', {class: 'pole', x1: fx, x2: fx, y1: fy, y2: poleTop}, g);
    const w = size * 0.75;
    const h = size * 0.5;
    const dir = fx + w + 2 > width ? -1 : 1;  // keep the flag inside the window
    if (flag.kind === 'start') {
        svgEl('polygon', {class: 'cloth', points: `${fx},${poleTop} ${fx + dir * w},${poleTop + h / 2} ${fx},${poleTop + h}`}, g);
    } else {
        const cols = 3;
        const rows = 2;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cx = dir > 0 ? fx + c * w / cols : fx - (c + 1) * w / cols;
                svgEl('rect', {class: (r + c) % 2 ? 'check-light' : 'cloth', x: cx, y: poleTop + r * h / rows,
                               width: w / cols, height: h / rows}, g);
            }
        }
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

function renderUpcoming(list, positionUnknown, rows=list.length) {
    const imperial = isImperial();
    const el = document.querySelector('.upcoming');
    setRows(el, list.map(({climb: c, toStart}) => climbRow(c, {
        title: climbTitle(c),
        where: `${positionUnknown ? 'at' : 'in'} ${toText(formatDistance(toStart, imperial))}`,
    })));
    // Room for `rows` rows; scroll (mouse wheel) for the rest
    const first = el.firstElementChild;
    if (first && list.length > rows) {
        const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
        el.style.maxHeight = `${rows * first.offsetHeight + (rows - 1) * gap}px`;
    } else {
        el.style.maxHeight = '';
    }
    updateUpcomingFade(el);
}

// Fade the bottom while there are more climbs below to scroll to
function updateUpcomingFade(el) {
    el.classList.toggle('scrolls', el.scrollTop + el.clientHeight < el.scrollHeight - 2);
}

function preview(index) {
    previewIndex = index;
    showList = false;
    render();
}

function shownClimbs(pos) {
    return C.shownClimbs(course, climbs, pos);
}

function lapOf(distance) {
    return C.lapOf(course, distance);
}

function routeListClimbs(pos, positionUnknown) {
    return C.routeListClimbs(course, climbs, pos, positionUnknown);
}

function renderRouteList(pos, positionUnknown) {
    const el = document.querySelector('.route-list');
    const imperial = isImperial();
    const {lap, list} = routeListClimbs(pos, positionUnknown);
    const multiLap = course && lap == null && course.laps && course.laps.length > 1;
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
        ...(course?.video ? [`video road ${course.road.id}`] : []),
        ...(course?.portal && course.segments.length ? [`portal ${Math.round(course.segments[0].start)}-` +
            `${Math.round(course.segments[0].end)} m (${course.gate ? 'gate' : 'top'})`] : []),
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
    renderPos = null;
    if (!state) {
        message = 'Waiting for rider data...';
    } else if (building && !course) {
        message = 'Loading route...';
    } else if (!course) {
        message = routeMissing(routeCourseKey(state)) ?
            'This route and road aren\u2019t in Sauce yet (waiting for a Sauce update)' :
            'No route or road data';
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
            renderPos = positionUnknown ? null : pos;
            climb = currentOrNextClimb(shownClimbs(pos), pos);
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
                    course.routeMissing ? 'Route not in Sauce yet: no climbs ahead on this road' :
                    !climbs.length ? 'No climbs on this route' :
                    C.noSetEnd(course, pos) && climbs.some(c => c.start > pos) ? 'No more climbs this lap' : 'No more climbs';
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
    // The summary can keep the finished climb's profile under it, in place of the climb's stats
    const summaryClimb = showSummary && s.summaryProfile !== false ?
        climbs.find(x => Math.abs(x.start - summary.stats.climb.start) < 1) : null;
    content.classList.toggle('summary-profile', !!summaryClimb);
    climbEl.hidden = summaryClimb ? false : !climb || showSummary;
    climbEl.classList.toggle('previewing', previewing);
    climbEl.querySelector('.preview-close').hidden = !previewing;
    idleEl.textContent = climb || showSummary ? '' : message;
    content.classList.toggle('hide-idle', !climb && !showSummary && !!s.hideWhenIdle);
    // Later climbs, all of them: the setting is how many rows show, and the list scrolls for the
    // rest. While the summary covers the climb view, the next climb is listed too.
    const upcoming = [];
    const count = Number(s.upcomingCount) || 0;
    if (pos != null && count > 0) {
        const shown = shownClimbs(pos);
        const after = showSummary ? shown.filter(x => x.end > pos) :
            liveClimb ? shown.filter(x => x.start > liveClimb.end) : shown.filter(x => x.start > pos);
        for (const c of after) {
            upcoming.push({climb: c, toStart: Math.max(0, c.start - pos)});
        }
    }
    renderUpcoming(upcoming, positionUnknown, count);
    if (summaryClimb) {
        renderProfile(summaryClimb, pos, {state: 'done'}, positionUnknown);
        return;
    }
    if (!climb || showSummary) {
        return;
    }
    const header = climbEl.querySelector('.climb-header');
    setBadge(header.querySelector('.cat-badge'), climb);
    header.querySelector('.climb-name').textContent = climbTitle(climb);
    header.querySelector('.climb-meta').textContent =
        (previewing ? 'Preview · ' : '') +
        `${climbNumberText(climb)} · max ${toText(formatGrade(climb.maxGrade, 0))}` +
        (positionUnknown && !previewing ? ' · position unknown' : '') +
        (course.routeMissing ? ' · this road only' : '');
    // "Starts at" (from the route start) when we can't say how far away it is
    const showAt = positionUnknown || (progress.state === 'approaching' && progress.toStart == null);
    if (progress.state === 'climbing') {
        setStat(0, 'To top', formatDistance(progress.remaining, imperial));
        setStat(1, 'Climb left', formatElevation(progress.remainingAscent, imperial));
        // Sauce may not have a grade where it has no road data (e.g. video routes): use the profile's
        const grade = Number.isFinite(state.grade) ? state.grade : gradeAt(profile, pos);
        // Readable on the panel's own background (the theme's), whatever the theme
        setStat(2, 'Grade', formatGrade(grade), s.colorGradeNumber ?
            gradeTextColor(grade, s.colorScheme, parseRgb(getComputedStyle(climbEl).backgroundColor)) : '');
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
    renderLiveStats(climbEl, climb, progress, previewing);
    renderProfile(climb, pos, progress, showAt);
}

// ---------- Climb summary ----------

function trackEffort(state, pos, positionUnknown) {
    if (!state || pos == null || positionUnknown || !climbs.length ||
        !(course?.mode === 'route' || course?.portal || course?.video || course?.routeMissing)) {
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

// This ride's attempts at each climb, to compare laps. A climb is known by its place in the lap
// and its length, so it's the same climb on every lap.
const history = new ClimbHistory((a, b) => a.base === b.base && Math.abs(a.offset - b.offset) < 40 &&
                                           Math.abs(a.length - b.length) < 60);

function climbKey(c) {
    const lap = course?.laps ? course.laps[lapOf(c.start)] : null;
    return {base: baseKey(course?.key), offset: c.start - (lap ? lap.lapStart : 0), length: c.length};
}

function finishEffort(e) {
    const s = settings();
    const top = ascentAt(profile, e.climb.end);
    const stats = e.summary(pos => Math.max(0, top - ascentAt(profile, pos)));
    if (!stats) {
        return;
    }
    const key = climbKey(e.climb);
    Object.assign(stats, history.final(key, stats));
    history.add(key, stats, e.trace);
    if (s.climbSummary === false || e.coverage() < 0.5) {
        return;
    }
    const seconds = Math.min(60, Math.max(3, Number(s.summarySeconds) || 12));
    summary = {stats, until: Date.now() + seconds * 1000};
    setTimeout(render, seconds * 1000 + 50);
}

function setSummaryStat(el, i, label, f, color='') {
    const cell = el.querySelector(`.stat[data-sstat="${i}"]`);
    cell.querySelector('.value').style.color = color;
    cell.hidden = !label;  // slot turned off
    cell.querySelector('.label').textContent = label;
    cell.querySelector('.num').textContent = typeof f === 'string' ? f : f.value;
    cell.querySelector('.unit').textContent = typeof f === 'string' ? '' : f.unit;
}

// One effort stat (from ClimbEffort summary() or live()): [label, value or {value, unit}]
function effortStat(key, x, imperial) {
    const missing = v => v == null || !Number.isFinite(v);
    const n = (v, digits, unit) => missing(v) ? '-' : {value: v.toFixed(digits), unit};
    switch (key) {
        case 'time': return ['Time', formatDuration(x.time)];
        case 'avgPower': return ['Avg power', n(x.avgPower, 0, 'w')];
        case 'wkg': return ['Avg W/kg', missing(x.wkg) ? '-' : x.wkg.toFixed(1)];
        case 'vam': return ['VAM', missing(x.vam) ? '-' : imperial ?
            {value: Math.round(x.vam * 3.28084).toString(), unit: 'ft/h'} : n(x.vam, 0, 'm/h')];
        case 'avgHR': return ['Avg HR', n(x.avgHR, 0, 'bpm')];
        case 'maxHR': return ['Max HR', n(x.maxHR, 0, 'bpm')];
        case 'avgSpeed': return ['Avg speed', missing(x.avgSpeed) ? '-' : imperial ?
            {value: (x.avgSpeed / 1.609344).toFixed(1), unit: 'mph'} : n(x.avgSpeed, 1, 'kph')];
        case 'avgCadence': return ['Cadence', n(x.avgCadence, 0, 'rpm')];
        case 'np': return ['NP', n(x.np, 0, 'w')];
        case 'maxPower': return ['Max power', n(x.maxPower, 0, 'w')];
        case 'kj': return ['Energy', n(x.kj, 0, 'kJ')];
        case 'distance': return ['Distance', missing(x.distance) ? '-' : formatDistance(x.distance, imperial)];
        case 'ascent': return ['Climbed', missing(x.ascent) ? '-' : formatElevation(x.ascent, imperial)];
        case 'eta': return ['Est. to top', missing(x.eta) ? '-' : formatDuration(x.eta)];
        // Against this ride's earlier laps: ahead (faster) green, behind red
        case 'vsLast': return ['vs last lap', formatDelta(x.vsLast), deltaColor(x.vsLast)];
        case 'vsBest': return ['vs best lap', formatDelta(x.vsBest), deltaColor(x.vsBest)];
        case 'vsLastPower': return ['Power vs last', missing(x.vsLastPower) ? '-' :
            {value: `${x.vsLastPower >= 0 ? '+' : '\u2212'}${Math.abs(Math.round(x.vsLastPower))}`, unit: 'w'},
            deltaColor(missing(x.vsLastPower) ? null : -x.vsLastPower)];
    }
    return ['', ''];
}

function deltaColor(seconds) {
    return !Number.isFinite(seconds) || Math.round(seconds) === 0 ? '' : seconds < 0 ? '#4cd964' : '#ff5a4f';
}

const SUMMARY_STATS = ['time', 'avgPower', 'wkg', 'vam', 'avgHR', 'maxHR', 'avgSpeed', 'avgCadence'];

// The stats offered in settings. 'eta' only makes sense while climbing, so not in the summary.
const STAT_OPTIONS = [
    ['time', 'Time'], ['avgPower', 'Avg power'], ['wkg', 'Avg W/kg'], ['avgHR', 'Avg HR'],
    ['maxHR', 'Max HR'], ['vam', 'VAM'], ['avgSpeed', 'Avg speed'], ['avgCadence', 'Cadence'],
    ['np', 'NP (Normalized Power)'], ['maxPower', 'Max power'], ['kj', 'Energy (kJ)'],
    ['distance', 'Distance'], ['ascent', 'Climbed'], ['eta', 'Est. time to top (live only)'],
    ['vsLast', 'Time vs last lap'], ['vsBest', 'Time vs best lap'],
    ['vsLastPower', 'Avg power vs last lap (summary only)'],
];
const LIVE_ONLY = new Set(['eta']);
const SUMMARY_ONLY = new Set(['vsLastPower']);

function fillStatSelects() {
    for (const select of document.querySelectorAll('select[data-stat-list]')) {
        const live = select.dataset.statList === 'live';
        const options = [['off', 'Off'], ...STAT_OPTIONS.filter(([key]) => live ? !SUMMARY_ONLY.has(key) : !LIVE_ONLY.has(key))];
        select.replaceChildren(...options.map(([value, label]) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = label;
            return o;
        }));
    }
}

function renderSummary(el, x) {
    const imperial = isImperial();
    const c = x.climb;
    el.querySelector('.climb-name').textContent = climbTitle(c);
    el.querySelector('.climb-meta').textContent =
        `${toText(formatDistance(x.distance, imperial))} · ${toText(formatGrade(c.avgGrade))}` +
        (x.partial ? ' · partial' : '');
    const s = settings();
    for (const [i, fallback] of SUMMARY_STATS.entries()) {
        setSummaryStat(el, i, ...effortStat(s[`summaryStat${i + 1}`] || fallback, x, imperial));
    }
}

// Live stats row while climbing: the climb so far (time, average power...), for the climb shown.
function renderLiveStats(climbEl, climb, progress, previewing) {
    const s = settings();
    const row = climbEl.querySelector('.live-stats');
    const tracking = effort && climb && Math.abs(effort.climb.start - climb.start) < 1;
    const x = s.liveStats && !previewing && progress?.state === 'climbing' && tracking ?
        effort.live((a, b) => ascentAt(profile, b) - ascentAt(profile, a)) : null;
    if (x) {
        x.eta = estimateTimeLeft(x, progress.remaining, progress.remainingGrade);
        // Against earlier laps at the same point, when this attempt started at the bottom too
        Object.assign(x, x.partial ? {vsLast: null, vsBest: null} :
            history.live(climbKey(climb), x.distance, x.time));
    }
    row.hidden = !x;
    if (!x) {
        return;
    }
    const imperial = isImperial();
    let shown = 0;
    for (let i = 0; i < 4; i++) {
        const [label, f, color=''] = effortStat(s[`liveStat${i + 1}`], x, imperial);
        const cell = row.querySelector(`.stat[data-lstat="${i}"]`);
        cell.querySelector('.value').style.color = color;
        cell.hidden = !label;
        shown += label ? 1 : 0;
        cell.querySelector('.label').textContent = label;
        cell.querySelector('.num').textContent = typeof f === 'string' ? f : f.value;
        cell.querySelector('.unit').textContent = typeof f === 'string' ? '' : f.unit;
    }
    row.hidden = !shown;  // every slot off
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
        updateNearbySubscription();
        applyAppearance();
        render();
    });
    const profileEl = document.querySelector('.profile');
    new ResizeObserver(() => render()).observe(profileEl);
    profileEl.addEventListener('pointermove', ev => {
        hoverX = ev.clientX - profileEl.getBoundingClientRect().left;
        drawHover();
    });
    profileEl.addEventListener('pointerleave', () => {
        hoverX = null;
        drawHover();
    });
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
    const upcomingEl = document.querySelector('.upcoming');
    upcomingEl.addEventListener('scroll', () => updateUpcomingFade(upcomingEl));
    document.querySelector('.summary-close').addEventListener('click', () => {
        summary = null;
        render();
    });
    document.querySelector('.preview-close').addEventListener('click', () => {
        previewIndex = null;
        render();
    });
    common.subscribe('athlete/watching', onWatching);
    updateNearbySubscription();
    render();
}


// ---------- Settings page ----------

export async function settingsMain() {
    common.initInteractionListeners();
    fillStatSelects();
    await common.initSettingsForm('form#options')();
    const select = document.querySelector('select[name="colorScheme"]');
    const preview = document.querySelector('.scheme-preview');
    if (select && preview) {
        renderSchemePreview(preview, select.value);
        select.addEventListener('change', () => renderSchemePreview(preview, select.value));
    }
}

// A strip of the color scheme from -10% to 20%, with grade marks, under the scheme picker.
function renderSchemePreview(el, scheme) {
    const min = -0.10;
    const max = 0.20;
    const stops = [];
    for (let g = min; g <= max + 1e-9; g += 0.0025) {
        stops.push(`${gradeColor(g, scheme)} ${((g - min) / (max - min) * 100).toFixed(2)}%`);
    }
    el.textContent = '';
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    el.appendChild(strip);
    const ticks = document.createElement('div');
    ticks.className = 'ticks';
    for (const g of [-0.10, -0.05, 0, 0.05, 0.10, 0.15, 0.20]) {
        const t = document.createElement('span');
        t.style.left = `${(g - min) / (max - min) * 100}%`;
        t.textContent = `${Math.round(g * 100)}%`;
        ticks.appendChild(t);
    }
    el.appendChild(ticks);
}
