# Changelog

## 0.1.0 (unreleased)

- Official Zwift climb segments (KOMs) on the route now set the climb's exact start, end and name.
- Long flat sections inside a climb split it into separate climbs; dips still keep a climb together.
- Detection tuned and checked against the elevation profiles of all 352 Zwift routes.
- Climb detection (500 m minimum, 3% minimum average grade) with a Small / Medium / Large threshold, using the climb score (length x average grade).
- Climbs carry on through dips and short descents.
- Remaining elevation counts all the climbing left to the top, including re-climbing dips.
- Gradient-colored profile of the climb with rider position, section grades and summit elevation.
- Climb names from Zwift KOM segments when they match.
- Upcoming climbs list.
- Units: Auto (Sauce setting), Metric or Imperial.
- Color schemes: Classic, Sauce, Veloviewer (ish), CVD-BuRd, CVD-PRGn, CVD-Sunset.
- Theme override, solid background, font scaling and data background opacity.
- Settings page button to export every route's elevation profile to JSON.
