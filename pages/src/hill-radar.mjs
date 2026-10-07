import * as common from '/pages/src/common.mjs';
import {buildProfile, detectClimbs, riderProgress, currentOrNextClimb, climbChunks,
        autoChunkLength, elevationAt, gradeAt, DETECTION_SCORES} from './climbs.mjs';
import {gradeColor} from './colors.mjs';
import {resolveImperial, formatDistance, formatElevation, formatGrade, toText} from './units.mjs';

const doc = document.documentElement;
const svgNS = 'http://www.w3.org/2000/svg';
const metersPerMile = 1609.344;

common.settingsStore.setDefault({
    detection: 'small',
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
});

const settings = () => common.settingsStore.get();

let course;         // {key, mode, distances, elevations, laps, segments}
let profile;        // buildProfile() result for the course
let climbs = [];
let lastState;
let building;


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

function courseKey(state) {
    if (state.eventSubgroupId) {
        return `event:${state.eventSubgroupId}`;
    } else if (state.routeId) {
        return `route:${state.routeId}:${Math.max(2, (state.laps || 0) + 2)}`;
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
    let routeId = state.routeId;
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
    for (let lap = 1; lap < laps; lap++) {
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
        if (distance && distances[distances.length - 1] >= distance) {
            break;
        }
    }
    if (distance) {
        while (distances.length > 2 && distances[distances.length - 1] > distance) {
            distances.pop();
            elevations.pop();
        }
        const last = lapList[lapList.length - 1];
        last.distance = distances[distances.length - 1] - last.offset;
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
    return {key, mode: 'route', name: route.name, distances, elevations, laps: lapList, segments};
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

async function buildCourse(state, key) {
    if (key.startsWith('road:')) {
        return await buildRoadCourse(state, key);
    }
    return await buildRouteCourse(state, key);
}

// Distance along the course for the watched rider.
function coursePosition(state) {
    if (!course) {
        return null;
    }
    if (course.mode === 'route') {
        if (state.routeDistance == null || state.routeEnd == null) {
            return null;
        }
        // The lap finish line is fixed, so use the distance left in the lap.
        const lap = course.laps[state.laps || 0] || course.laps[course.laps.length - 1];
        return lap.offset + lap.distance - (state.routeEnd - state.routeDistance);
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
        c.name = best ? best.name : null;
    }
}

function detect() {
    if (!course) {
        profile = null;
        climbs = [];
        return;
    }
    profile = buildProfile(course.distances, course.elevations);
    climbs = detectClimbs(profile, {
        minScore: DETECTION_SCORES[settings().detection] || DETECTION_SCORES.small,
        segments: course.segments,
    });
    nameClimbs();
}

async function onWatching(ad) {
    const state = ad && ad.state;
    if (!state) {
        return;
    }
    lastState = state;
    const key = courseKey(state);
    if (!key) {
        course = null;
        detect();
    } else if ((!course || course.key !== key) && !building) {
        building = buildCourse(state, key).then(c => {
            course = c;
            detect();
        }).catch(e => {
            console.error('Hill Radar: failed to load course', e);
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

function renderProfile(climb, pos, progress) {
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
        t.textContent = `▶ ${toText(formatDistance(progress.toStart, imperial))}`;
    }
}

function renderUpcoming(list) {
    const el = document.querySelector('.upcoming');
    const imperial = isImperial();
    const s = settings();
    const rows = list.map(({climb: c, toStart}) => {
        const row = document.createElement('div');
        row.className = 'row';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = gradeColor(c.avgGrade, s.colorScheme, 1);
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = climbTitle(c);
        const badge = document.createElement('span');
        setBadge(badge, c);
        const info = document.createElement('span');
        info.textContent = `in ${toText(formatDistance(toStart, imperial))} · ` +
            `${toText(formatDistance(c.length, imperial))} · ${toText(formatGrade(c.avgGrade))} · ` +
            `${toText(formatElevation(c.ascent, imperial))}`;
        row.append(swatch, name, badge, info);
        return row;
    });
    el.replaceChildren(...rows);
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
    if (!state) {
        message = 'Waiting for rider data...';
    } else if (building && !course) {
        message = 'Loading route...';
    } else if (!course) {
        message = 'No route or road data';
    } else {
        pos = coursePosition(state);
        if (pos == null) {
            message = 'Waiting for position on route...';
        } else {
            climb = currentOrNextClimb(climbs, pos);
            if (climb) {
                progress = riderProgress(profile, climb, pos);
                const approach = Number(s.approachDistance) || 0;
                const approachMeters = approach * (imperial ? metersPerMile : 1000);
                if (progress.state === 'approaching' && approach > 0 && progress.toStart > approachMeters) {
                    message = `Next climb in ${toText(formatDistance(progress.toStart, imperial))}`;
                    climb = null;
                }
            } else {
                message = climbs.length ? 'No more climbs' : 'No climbs on this route';
            }
        }
    }
    climbEl.hidden = !climb;
    idleEl.textContent = climb ? '' : message;
    content.classList.toggle('hide-idle', !climb && !!s.hideWhenIdle);
    // Later climbs
    const upcoming = [];
    const count = Number(s.upcomingCount) || 0;
    if (pos != null && count > 0) {
        const after = climb ? climbs.filter(x => x.start > climb.end) : climbs.filter(x => x.start > pos);
        for (const c of after.slice(0, count)) {
            upcoming.push({climb: c, toStart: c.start - pos});
        }
    }
    renderUpcoming(upcoming);
    if (!climb) {
        return;
    }
    const header = climbEl.querySelector('.climb-header');
    setBadge(header.querySelector('.cat-badge'), climb);
    header.querySelector('.climb-name').textContent = climbTitle(climb);
    header.querySelector('.climb-meta').textContent =
        `${climb.index + 1}/${climbs.length} · max ${toText(formatGrade(climb.maxGrade, 0))}`;
    if (progress.state === 'climbing') {
        setStat(0, 'To top', formatDistance(progress.remaining, imperial));
        setStat(1, 'Climb left', formatElevation(progress.remainingAscent, imperial));
        setStat(2, 'Grade', formatGrade(state.grade));
        setStat(3, 'Avg left', formatGrade(progress.remainingGrade));
    } else {
        setStat(0, 'Starts in', formatDistance(progress.toStart, imperial));
        setStat(1, 'Length', formatDistance(climb.length, imperial));
        setStat(2, 'Ascent', formatElevation(climb.ascent, imperial));
        setStat(3, 'Avg grade', formatGrade(climb.avgGrade));
    }
    renderProfile(climb, pos, progress);
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
        if (changed && changed.has('detection')) {
            detect();
        }
        applyAppearance();
        render();
    });
    new ResizeObserver(() => render()).observe(document.querySelector('.profile'));
    common.subscribe('athlete/watching', onWatching);
    render();
}


// ---------- Settings page ----------

async function getSauceVersion() {
    try {
        return await common.rpc.getVersion();
    } catch(e) {
        return null;
    }
}

async function exportRoutes(button, status) {
    button.disabled = true;
    try {
        const list = await common.getRouteList();
        const step = 10;
        const out = {
            exportedAt: new Date().toISOString(),
            sauceVersion: await getSauceVersion(),
            step,
            routes: [],
        };
        let n = 0;
        for (const r of list) {
            n++;
            status.textContent = `${n} / ${list.length}`;
            try {
                const route = await common.getRoute(r.id);
                if (!route || !route.distances || route.distances.length < 2) {
                    continue;
                }
                // Resample to a fixed step to keep the file small
                const d = route.distances;
                const e = route.elevations;
                const total = d[d.length - 1];
                const elevations = [];
                let j = 0;
                for (let x = 0; x <= total; x += step) {
                    while (j < d.length - 2 && d[j + 1] < x) {
                        j++;
                    }
                    const t = d[j + 1] > d[j] ? Math.min(1, Math.max(0, (x - d[j]) / (d[j + 1] - d[j]))) : 0;
                    elevations.push(Math.round((e[j] + (e[j + 1] - e[j]) * t) * 10) / 10);
                }
                const segIds = Array.from(new Set((route.segments || []).map(x => x.id)));
                const names = await getSegmentNames(segIds);
                out.routes.push({
                    id: r.id,
                    name: r.name,
                    courseId: r.courseId,
                    eventOnly: !!r.eventOnly,
                    supportedLaps: !!route.supportedLaps,
                    leadinDistance: route.meta ? route.meta.leadinDistance : null,
                    length: Math.round(total),
                    elevations,
                    segments: (route.segments || []).map(x => ({
                        id: x.id,
                        name: names.get(x.id) || null,
                        offset: Math.round(x.offset),
                        distance: Math.round(x.distance),
                        leadinOnly: !!x.leadinOnly,
                        weldOnly: !!x.weldOnly,
                    })),
                });
            } catch(e) {
                console.warn('Hill Radar: route export failed for', r.id, e);
            }
        }
        const blob = new Blob([JSON.stringify(out)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'hill-radar-routes.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        status.textContent = `Saved ${out.routes.length} routes`;
    } catch(e) {
        console.error(e);
        status.textContent = `Export failed: ${e.message}`;
    } finally {
        button.disabled = false;
    }
}

export async function settingsMain() {
    common.initInteractionListeners();
    await common.initSettingsForm('form#options')();
    const button = document.getElementById('export-routes');
    const status = document.querySelector('.export-status');
    button.addEventListener('click', () => exportRoutes(button, status));
}
