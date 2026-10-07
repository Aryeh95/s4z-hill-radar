# Hill Radar for Sauce for Zwift

A [Sauce for Zwift](https://www.sauce.llc/products/sauce4zwift/) mod that finds the climbs on the route you are riding and shows the current or next climb, the same idea as a bike computer's climb feature:

- A profile of the climb colored by gradient, with your position on it
- **To top**: distance left to the top of the climb
- **Climb left**: elevation still to climb, including any dips you will have to climb back out of
- Current grade and the average grade of what is left
- Before a climb: distance to the start, length, ascent and average grade
- A list of the next climbs on the route

## Climb detection

A climb has to be at least 500 m long with an average grade of at least 3%. Each climb gets a score of length (m) x average grade (%), which sets its category:

| Category | Score |
| --- | --- |
| HC | 80,000+ |
| Cat 1 | 64,000+ |
| Cat 2 | 32,000+ |
| Cat 3 | 16,000+ |
| Cat 4 | 8,000+ |
| Uncategorized | below 8,000 |

The **Climb detection** setting picks the smallest climbs shown:

- **All climbs**: score 1,500 or more
- **Medium and large climbs**: score 3,500 or more
- **Only large climbs**: score 8,000 or more

Climbs continue through dips and short descents, so a climb with a dip in the middle shows as one climb. Flat or gentle run-ups are trimmed off the ends.

Detection works on routes and events (including multi-lap and distance-based events). When riding without a route, it uses the current road only.

When the route has an official Zwift climb segment (a KOM), that climb uses the segment's name and covers at least the segment's official start and end (detected climbing just before or after it is kept). The segment still has to meet the climb rules above (500 m, 3%, and the detection size), so sprints, laps and very gentle segments are not shown as climbs. Climbs without an official segment are found from the elevation profile. When one of those matches a well-known unofficial climb (for example San Luca on the Bologna Time Trial, or the climbs named in Brian Mudge's S4Z mods), it gets that name; otherwise it is shown as "Climb 1", "Climb 2" and so on.

## Settings

- Climb detection: All / Medium and large / Only large
- Show next climb within (km or mi; 0 = always)
- Hide when no climb
- Upcoming climbs list (0 to 5)
- Units: Auto (follows Sauce), Metric or Imperial
- Gradient color scheme: Classic, Sauce, Veloviewer (ish), CVD-BuRd, CVD-PRGn, CVD-Sunset
- Gradient coloring: Smooth (high resolution, colored point by point) or Sections
- Gradient color opacity, section length, grade labels, dim the completed part
- Font scaling, theme override, solid background, data background opacity

The window can be resized; everything scales with it.

## Install

1. Download this repository (Code > Download ZIP) and unzip it.
2. Put the folder in your Sauce mods folder (usually `Documents\SauceMods`).
3. Restart Sauce, enable **Hill Radar** in Sauce's mod settings, and add the **Hill Radar** window.

## Development

The climb detection, colors and unit formatting are plain JavaScript modules in `pages/src/` with tests:

```
npm test
```

## Credits

Gradient color schemes follow those in [Zenmaster's S4Z mods](https://github.com/Zenmaster28/Zenmaster-s4z-mods).
Names for unofficial climbs come mostly from Brian Mudge's S4Z mods (GPL-3.0).
Climb scoring follows the common climb score used by bike computers.

## License

[GPL-3.0](LICENSE)
