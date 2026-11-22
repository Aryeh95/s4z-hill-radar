// Records the rider's effort on a climb, for the summary shown at the top.
// Pure module (no Sauce imports) so it can be unit tested.

const maxGap = 5;  // s; longer gaps between samples (pauses, lag) count as this long
const npWindow = 30;  // s, rolling average used for Normalized Power
const traceStep = 10;  // m between points of the time-by-distance trace


export class ClimbEffort {
    constructor(climb) {
        this.climb = climb;
        this.startPos = null;     // where tracking started (climb start, or later if joined mid-climb)
        this.startTime = null;
        this.endTime = null;
        this.last = null;
        this.time = 0;            // seconds covered by samples on the climb
        this.powerSum = 0;
        this.hrSum = 0;
        this.hrTime = 0;
        this.hrMax = 0;
        this.cadenceSum = 0;
        this.cadenceTime = 0;
        this.powerMax = 0;
        this.npQueue = [];        // recent [dt, power] for the 30 s rolling average
        this.npQueueTime = 0;
        this.npQueueSum = 0;
        this.np4Sum = 0;          // sum of rolling average^4 x time, once 30 s are in
        this.np4Time = 0;
        this.weight = null;
        this.trace = [];          // [distance from startPos (m), seconds since startTime], every 10 m
    }

    /**
     * sample: {t (s), pos (m along the course), power (W), hr (bpm), cadence (rpm), weight (kg)}
     * Returns true once the rider has passed the top.
     */
    add(sample) {
        const {t, pos} = sample;
        if (!Number.isFinite(t) || !Number.isFinite(pos)) {
            return false;
        }
        const c = this.climb;
        if (sample.weight > 0) {
            this.weight = sample.weight;
        }
        const prev = this.last;
        if (prev && t <= prev.t) {
            return false;  // duplicate or out of order
        }
        if (this.startTime == null) {
            if (pos < c.start) {
                this.last = sample;
                return false;
            }
            if (pos > c.end) {
                return false;
            }
            // Crossing the start: interpolate the time from the previous sample
            if (prev && prev.pos < c.start && pos > prev.pos) {
                this.startTime = prev.t + (t - prev.t) * (c.start - prev.pos) / (pos - prev.pos);
                this.startPos = c.start;
            } else {
                this.startTime = t;
                this.startPos = pos;
            }
            this.last = {...sample, t: this.startTime, pos: this.startPos};
            this.trace.push([0, 0]);
            if (t > this.startTime) {
                this._accumulate(sample, t - this.startTime);
                this._trace(pos, t);
            }
            this.last = sample;
            return false;
        }
        let dt = t - prev.t;
        let done = false;
        if (pos >= c.end) {
            // Crossing the top: only count the part of this interval up to the top
            const frac = pos > prev.pos ? Math.min(1, (c.end - prev.pos) / (pos - prev.pos)) : 1;
            dt *= Math.max(0, frac);
            this.endTime = prev.t + dt;
            done = true;
        }
        this._accumulate(sample, dt);
        if (done) {
            this.trace.push([c.end - this.startPos, this.endTime - this.startTime]);
        } else {
            this._trace(pos, t);
        }
        this.last = sample;
        return done;
    }

    _trace(pos, t) {
        const d = pos - this.startPos;
        if (d - this.trace[this.trace.length - 1][0] >= traceStep) {
            this.trace.push([d, t - this.startTime]);
        }
    }

    _accumulate(sample, dt) {
        dt = Math.min(maxGap, Math.max(0, dt));
        if (!dt) {
            return;
        }
        this.time += dt;
        const power = sample.power > 0 ? sample.power : 0;
        this.powerSum += power * dt;
        this.powerMax = Math.max(this.powerMax, power);
        // Normalized Power: 30 s rolling average, raised to the 4th power, averaged, 4th root
        this.npQueue.push([dt, power]);
        this.npQueueTime += dt;
        this.npQueueSum += power * dt;
        while (this.npQueue.length > 1 && this.npQueueTime - this.npQueue[0][0] >= npWindow) {
            const [qdt, qp] = this.npQueue.shift();
            this.npQueueTime -= qdt;
            this.npQueueSum -= qp * qdt;
        }
        // Trim the oldest sample so the window is exactly 30 s (long gaps would stretch it)
        const extra = this.npQueueTime - npWindow;
        if (extra > 1e-9 && this.npQueue.length > 1) {
            const oldest = this.npQueue[0];
            oldest[0] -= extra;
            this.npQueueTime -= extra;
            this.npQueueSum -= oldest[1] * extra;
        }
        if (this.npQueueTime >= npWindow - 1e-6) {
            this.np4Sum += (this.npQueueSum / this.npQueueTime) ** 4 * dt;
            this.np4Time += dt;
        }
        if (sample.hr > 0) {
            this.hrSum += sample.hr * dt;
            this.hrTime += dt;
            this.hrMax = Math.max(this.hrMax, sample.hr);
        }
        if (sample.cadence > 0) {
            this.cadenceSum += sample.cadence * dt;
            this.cadenceTime += dt;
        }
    }

    // Share of the climb that was tracked (1 = from the bottom)
    coverage() {
        if (this.startPos == null) {
            return 0;
        }
        return (this.climb.end - this.startPos) / this.climb.length;
    }

    /**
     * Summary once the top is reached. ascentFrom(pos) gives the climbing from pos to the top.
     */
    summary(ascentFrom) {
        if (this.startTime == null || this.endTime == null) {
            return null;
        }
        const ascent = ascentFrom ? ascentFrom(this.startPos) : this.climb.ascent * this.coverage();
        return this._stats(this.endTime - this.startTime, this.climb.end - this.startPos, ascent);
    }

    /**
     * So far, while still on the climb. ascentBetween(a, b) gives the climbing from a to b.
     */
    live(ascentBetween) {
        if (this.startTime == null || !this.last || this.endTime != null) {
            return null;
        }
        const pos = Math.min(this.climb.end, Math.max(this.startPos, this.last.pos));
        const ascent = ascentBetween ? ascentBetween(this.startPos, pos) : 0;
        return this._stats(Math.max(0, this.last.t - this.startTime), pos - this.startPos, ascent);
    }

    _stats(elapsed, distance, ascent) {
        const avgPower = this.time ? this.powerSum / this.time : null;
        return {
            climb: this.climb,
            partial: this.coverage() < 0.98,
            startPos: this.startPos,
            time: elapsed,
            distance,
            ascent,
            avgPower,
            np: this.np4Time ? (this.np4Sum / this.np4Time) ** 0.25 : null,  // needs 30 s on the climb
            maxPower: this.time ? this.powerMax : null,
            kj: this.time ? this.powerSum / 1000 : null,
            wkg: avgPower != null && this.weight ? avgPower / this.weight : null,
            avgHR: this.hrTime ? this.hrSum / this.hrTime : null,
            maxHR: this.hrMax || null,
            avgCadence: this.cadenceTime ? this.cadenceSum / this.cadenceTime : null,
            avgSpeed: elapsed > 0 ? distance / elapsed * 3.6 : null,       // kph
            vam: elapsed > 0 ? ascent / elapsed * 3600 : null,               // m/h
        };
    }
}


/**
 * Estimated seconds to the top: your pace on the climb so far (`x`: {time, distance, ascent}),
 * scaled for the grade left. At a steady effort, speed goes with 1 / (grade + c), where c stands
 * in for rolling resistance and air at climbing speeds. Null until there's enough to go on.
 */
export function estimateTimeLeft(x, remaining, remainingGrade, c=0.02) {
    if (!x || !(x.time >= 20) || !(x.distance >= 100) || !(remaining >= 0) ||
        !Number.isFinite(remainingGrade)) {
        return null;
    }
    const speed = x.distance / x.time;
    const gradeDone = Math.max(0, (x.ascent || 0) / x.distance);
    const speedLeft = speed * (gradeDone + c) / (Math.max(0, remainingGrade) + c);
    return speedLeft > 0 ? remaining / speedLeft : null;
}

/** Seconds into an attempt at `distance` m from its start, from its trace, or null past its end. */
export function timeAtDistance(trace, distance) {
    if (!trace || trace.length < 2 || !(distance >= 0) || distance > trace[trace.length - 1][0]) {
        return null;
    }
    let i = 1;
    while (i < trace.length - 1 && trace[i][0] < distance) {
        i++;
    }
    const [d0, t0] = trace[i - 1];
    const [d1, t1] = trace[i];
    return d1 > d0 ? t0 + (t1 - t0) * (distance - d0) / (d1 - d0) : t1;
}


/**
 * This ride's attempts at each climb, to compare laps: the previous attempt and the best (the
 * fastest). Only full attempts (from the bottom) count. A climb's key says which climb it is
 * (e.g. its place in the lap); same(a, b) says two keys are the same climb.
 */
export class ClimbHistory {
    constructor(same=(a, b) => a === b) {
        this.same = same;
        this.climbs = [];  // [{key, attempts: [{time, avgPower, trace}]}]
    }

    _attempts(key) {
        const entry = this.climbs.find(x => this.same(x.key, key));
        return entry ? entry.attempts : null;
    }

    /** Record a finished attempt: stats from ClimbEffort.summary(), trace from the effort. */
    add(key, stats, trace) {
        if (!stats || stats.partial || !(stats.time > 0)) {
            return;
        }
        let attempts = this._attempts(key);
        if (!attempts) {
            attempts = [];
            this.climbs.push({key, attempts});
        }
        attempts.push({time: stats.time, avgPower: stats.avgPower, trace});
    }

    clear() {
        this.climbs = [];
    }

    previous(key) {
        const list = this._attempts(key);
        return list && list.length ? list[list.length - 1] : null;
    }

    best(key) {
        const list = this._attempts(key);
        return list && list.length ? list.reduce((a, b) => b.time < a.time ? b : a) : null;
    }

    /**
     * Seconds ahead (negative) or behind (positive) of the previous and the best attempt, at the
     * same distance into the climb: {vsLast, vsBest}, null where there's nothing to compare.
     */
    live(key, distance, elapsed) {
        const at = a => {
            const t = a ? timeAtDistance(a.trace, distance) : null;
            return t == null || !Number.isFinite(elapsed) ? null : elapsed - t;
        };
        return {vsLast: at(this.previous(key)), vsBest: at(this.best(key))};
    }

    /** The finished attempt against the previous and the best: time (s) and average power (W). */
    final(key, stats) {
        const prev = this.previous(key);
        const best = this.best(key);
        if (!stats || stats.partial) {
            return {vsLast: null, vsBest: null, vsLastPower: null};
        }
        return {
            vsLast: prev ? stats.time - prev.time : null,
            vsBest: best ? stats.time - best.time : null,
            vsLastPower: prev && stats.avgPower != null && prev.avgPower != null ? stats.avgPower - prev.avgPower : null,
        };
    }
}


/** "-0:04" / "+1:12": a time difference (ahead is negative). */
export function formatDelta(seconds) {
    if (!Number.isFinite(seconds)) {
        return '-';
    }
    const r = Math.round(seconds);
    return (r < 0 ? '\u2212' : '+') + formatDuration(Math.abs(r));
}

export function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) {
        return '-';
    }
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
