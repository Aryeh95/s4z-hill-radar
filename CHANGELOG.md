# Changelog

## 0.1.0 (unreleased)

- Fix "Waiting for position on route" on free rides: when Sauce has no route distance, the rider is placed by matching their road position to the route's road sections, then by the game's lap progress.
- Keep using the selected route if the route briefly disappears from the rider data.
- When the position is still unknown, show the route's climbs from the start instead of a waiting message.
- Climbs without an official Zwift segment are named from a list of well-known unofficial climbs (from Brian Mudge's S4Z mods, plus San Luca on the Bologna Time Trial).
- High resolution gradient coloring: the profile is colored point by point by its grade (new "Gradient coloring" setting; "Sections" keeps the old look).
- Classic color scheme now blends smoothly from green through yellow, orange and red to dark red instead of fixed bands.
- Official climb segments only extend a climb, never shorten it (e.g. Ventoux on Ven-Top keeps its full length).
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
