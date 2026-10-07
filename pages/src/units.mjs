// Unit formatting. Pure module; the caller decides imperial vs metric.

const metersPerMile = 1609.344;
const feetPerMeter = 3.28084;

/**
 * units: 'auto' | 'metric' | 'imperial'. For 'auto', sauceImperial is Sauce's
 * global units setting.
 */
export function resolveImperial(units, sauceImperial) {
    if (units === 'imperial') {
        return true;
    } else if (units === 'metric') {
        return false;
    }
    return !!sauceImperial;
}

// Distance along the road. Short distances use m / ft.
export function formatDistance(meters, imperial) {
    if (!Number.isFinite(meters)) {
        return '-';
    }
    meters = Math.max(0, meters);
    if (imperial) {
        const miles = meters / metersPerMile;
        if (miles < 0.1) {
            return {value: Math.round(meters * feetPerMeter).toString(), unit: 'ft'};
        }
        return {value: miles.toFixed(miles < 10 ? 2 : 1), unit: 'mi'};
    }
    if (meters < 1000) {
        return {value: (Math.round(meters / 10) * 10).toString(), unit: 'm'};
    }
    const km = meters / 1000;
    return {value: km.toFixed(km < 10 ? 2 : 1), unit: 'km'};
}

// Elevation (height) in m or ft.
export function formatElevation(meters, imperial) {
    if (!Number.isFinite(meters)) {
        return '-';
    }
    return imperial ?
        {value: Math.round(meters * feetPerMeter).toString(), unit: 'ft'} :
        {value: Math.round(meters).toString(), unit: 'm'};
}

export function formatGrade(grade, digits=1) {
    if (!Number.isFinite(grade)) {
        return {value: '-', unit: '%'};
    }
    const v = grade * 100;
    return {value: (Object.is(Math.round(v * 10), -0) ? 0 : v).toFixed(digits), unit: '%'};
}

export function toText(f) {
    return typeof f === 'string' ? f : `${f.value}${f.unit === '%' ? '' : ' '}${f.unit}`;
}
