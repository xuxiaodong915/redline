# REDLINE — QA / Validation Report

**Build:** `index.html` (218,313 bytes, 213 KB)  
**SHA-256:** `56f1c5bbe74cdf63fecdd00cc172aad9d738881b9be3fbe3ee6ad21f381ec945`  
**Verdict:** PASS — no blocking defects found in the “wild TT mountain” revision.

## Scope

This revision changes the course profile, roadside scenery and cockpit glass:

- narrower 4.7 km course with more corners and much larger elevation changes;
- continuous walls removed; instead grass verges, a dark grass ditch, wildflowers, low scrub and low, wind-cut trees;
- the collision edge is now a grass ditch / bank rather than a stone wall;
- a curved, smoked racing windscreen added to the first-person cockpit;
- landmark signs, spectators and marshals moved outward so they do not sit on the racing line;
- title, HUD and result copy updated to “NO BARRIERS / GRASS DITCH” and 4.7 km.

The rest of the game (audio engine, controls, AI, sectors, best-time storage, pause/crash/result flows) is unchanged.

## Verification

| Area | Result | Evidence |
| --- | --- | --- |
| Load | PASS | `file://` load in WebKit; `REDLINE` exposed, 5530 segments, 12 landmarks, 0 uncaught JS errors. |
| Course | PASS | Finish at segment 4870, race distance 4690 segments (4.69 km), 12 landmarks in order: Bray Hill → Quarter Bridge → Union Mills → Ballaugh → Sulby → The Mountain → Mountain Mile → Kate's Cottage → Creg-ny-Baa → Governor's Dip → Finish. |
| Full race | PASS | Deterministic autopilot: 108.27 s, P5/5, 0 crashes, 0 NaN, all sectors/gear shifts finite. AI finishers 98.7 / 100.2 / 101.7 / 103.3 s. More aggressive autopilot: 93.57 s, P1. |
| Ditch edge | PASS | Full-throttle/no-steering run leaves tarmac, crosses the grass and crashes at `playerX = -1.32` (reason `GRASS BANK / BRAY HILL / 161 KM/H`) with WIPEOUT overlay visible. |
| Off-road | PASS | Grass shoulder applies strong speed loss, shake, dust and `OFF LINE` callout; low-speed ditch contact pushes the bike back without a wipeout. |
| Ballaugh jump | PASS | `AIRBORNE / BALLAUGH BRIDGE` callout observed after a fast pass over the drop; dynamic jump segment follows the new plan. |
| Scenery | PASS | No wall rendering in race/title; grass, ditch, wildflowers, low shrubs and low trees render on both sides; no continuous fence/barrier. |
| Windscreen | PASS | Curved smoked screen with frame, highlight, reflections, rain beads and mounting brackets renders in the cockpit on desktop and mobile; it does not block the TFT or HUD. |
| Layout 1440×900 | PASS | Title/countdown/race/pause/crash/result screenshots captured; all overlays and buttons inside viewport. |
| Layout 844×390 | PASS | Touch controls visible and clear of the cockpit; result panel and actions inside viewport; no ship.page badge on GitHub Pages. |
| Regression | PASS | Pause/resume, mute, crash/restart, result, localStorage, fullscreen, keyboard and touch bindings unchanged and exercised; `node --check` on the inline script passes. |

## Known non-blocking caveats

- The WebKit snapshot harness in this environment freezes native CSS transitions; screenshots and overlay checks use `REDLINE.step()` plus direct state setup. Normal browsers use `requestAnimationFrame` and CSS transitions normally.
- The shipped debug API (`window.REDLINE.scenic`, `teleport`, `step`, etc.) is intentionally left in for testability; it is not part of normal input.
- No independent human playtest or formal cross-browser matrix (Chrome/Firefox/Safari) was run for this revision. The game uses standard Canvas 2D and WebAudio APIs.
- Mobile compact buttons retain the existing small hit areas in landscape; this is a pre-existing visual trade-off, not a new blocker.

## Screenshots

Desktop and mobile screenshots are regenerated from this build and stored in `screenshots/`; the online GitHub Pages build is the same `index.html` hash.
