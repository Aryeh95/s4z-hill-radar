// Records the rider's effort on a climb, for the summary shown at the top.
// Pure module (no Sauce imports) so it can be unit tested.

const maxGap = 5;  // s; longer gaps between samples (pauses, lag) count as this long


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
        this.weight = null;
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
            if (t > this.startTime) {
                this._accumulate(sample, t - this.startTime);
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
        this.last = sample;
        return done;
    }

    _accumulate(sample, dt) {
        dt = Math.min(maxGap, Math.max(0, dt));
        if (!dt) {
            return;
        }
        this.time += dt;
        this.powerSum += (sample.power > 0 ? sample.power : 0) * dt;
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
        const elapsed = this.endTime - this.startTime;
        const distance = this.climb.end - this.startPos;
        const ascent = ascentFrom ? ascentFrom(this.startPos) : this.climb.ascent * this.coverage();
        const avgPower = this.time ? this.powerSum / this.time : null;
        return {
            climb: this.climb,
            partial: this.coverage() < 0.98,
            startPos: this.startPos,
            time: elapsed,
            distance,
            ascent,
            avgPower,
            wkg: avgPower != null && this.weight ? avgPower / this.weight : null,
            avgHR: this.hrTime ? this.hrSum / this.hrTime : null,
            maxHR: this.hrMax || null,
            avgCadence: this.cadenceTime ? this.cadenceSum / this.cadenceTime : null,
            avgSpeed: elapsed > 0 ? distance / elapsed * 3.6 : null,       // kph
            vam: elapsed > 0 ? ascent / elapsed * 3600 : null,               // m/h
        };
    }
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
