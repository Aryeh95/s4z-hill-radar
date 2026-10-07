# Changelog

## 0.1.0 (2026-10-07)

First release.

- Climb detection on the current route or road: at least 500 m long and 3% average grade, with an All / Medium and large / Only large threshold using the climb score (length x average grade).
- Climbs carry on through dips and short descents; long flat sections split them.
- Official Zwift climb segments (KOMs) name a climb and extend it to the segment's start and end, never shortening it. Official KOMs don't need the 500 m minimum length (e.g. Innsbruck's Leg Snapper), but still need 3% and the score.
- Names for well-known unofficial climbs (from Brian Mudge's S4Z mods, plus San Luca on the Bologna Time Trial).
- Remaining elevation counts all the climbing left to the top, including re-climbing dips.
- Shown numbers (gain, average and max grade, climbing left, section grades) use the unsmoothed elevation so they match the game; smoothing is only used to find climbs.
- Gradient-colored profile of the climb, colored point by point (or by sections), with rider position, section grades and summit elevation.
- Route climbs list: every climb on the route; click any climb (in the list or the upcoming climbs) to preview it.
- Upcoming climbs list.
- Climbs are numbered from the start of the ride across all laps (e.g. 4/6 · lap 2 in an event, #5 · lap 3 on a free ride), so climbs already done are counted.
- Rider position from Sauce's route distance, or by matching the rider's road position to the route, or the game's lap progress.
- Units: Auto (Sauce setting), Metric or Imperial.
- Color schemes: Classic, Sauce, Veloviewer (ish), CVD-BuRd, CVD-PRGn, CVD-Sunset.
- Theme override, solid background, font scaling, data background opacity and an optional position info line.
