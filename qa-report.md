# REDLINE — Independent QA Report

**Verdict: PASS — no blocking defects found.** 326/327 automated checks pass; the single failure is a documented non-blocking cosmetic issue. All previously-found blockers were fixed and re-verified on this exact build.

## Deliverable under test

| Field | Value |
|---|---|
| File | `tt-death-ride/index.html` (single self-contained file, file://) |
| SHA-256 | `f74f2123b360329a47da24b341e77d7d2cfc81748f91f704de1ca971c04c40f0` |
| Size / mtime | 209,695 bytes / 2026-11-09 01:29:03 (Asia/Shanghai) |
| Tested | 2026-11-09 ~01:29–01:34, exact hash above; hash re-checked after the suite (unchanged) |
| Workspace writes | only this report; all scripts/screenshots under `/tmp/qa-redline` |

## Environment & method

- **Desktop WebKit (real renderer):** custom WKWebView harness (`/tmp/qa-redline/qa.m` → `qa`), 1440×900, file:// load, document-start error/console capture, DOM geometry + `elementFromPoint` hit-tests, `WKSnapshot` PNG evidence.
- **Mobile WebKit (touch emulated):** same harness at 844×390 landscape and 390×844 portrait with `ontouchstart` + `navigator.maxTouchPoints=5`; touch controls driven with real `PointerEvent`s. (Synthetic pointer events are not OS-trusted gestures — see limitations.)
- **Logic/full-race simulation:** jsdom 31 + fake 2D canvas + deterministic rAF clock (`/tmp/qa-redline/scripts/qa-jsdom.js`, 152 checks), including a complete 4-rival autopilot race.
- **Deterministic stepping:** this headless/locked-screen session reports `document.visibilityState="hidden"`, so native rAF ≈0 Hz and CSS transitions freeze (independently confirmed; also reported by the Lead). All state transitions were driven with the shipped `REDLINE.step(n, dt)` (same `tick/render` path); layout/opacity judgments use DOM/computed style, not real-time screenshots. `REDLINE.scenic()`/`teleport()` were used only for fast WebKit UI-state coverage; the physics/race logic was fully simulated in jsdom.
- **Audio:** real WebAudio exists in WKWebView; `TTEngineAudio` constructed and full API called directly. Sound quality was not judged (out of scope/headless).
- **Persistence:** localStorage on file:// verified in WKWebView *across `location.reload()`*.
- Result totals: **jsdom 152/152, desktop 97/97, mobile 49/50, portrait 28/28**; 0 uncaught JS errors, 0 `console.error`, 0 warnings in every WebKit run.

## Pass/fail matrix

| # | Area | Result | Evidence / notes |
|---|---|---|---|
| 1 | Load from file://, no uncaught errors | **PASS** | `REDLINE` exposed, `__REDLINE_INIT_ERROR=null`, 5690 segments, 12 landmarks, 0 uncaught / 0 console.error / 0 warnings (desktop, mobile, portrait). jsdom only emits expected "Web Audio API not supported" warnings (no AudioContext in jsdom). |
| 2 | Full flow: title → start → 3-2-1-GO → race → finish → result → restart; pause/resume; mute; crash→restart; garage | **PASS** | `Enter`/start→countdown (3/2/1/GO); race; finish; result; `againBtn`/Enter restart; `pauseBtn`/P pause↔resume; pause RESUME/RESTART/GARAGE work; crash overlay after impact animation, TRY AGAIN restarts; GARAGE returns to title. Timer frozen at finish (raw `elapsed` stable across 120 extra ticks), world frozen while paused, countdown resumes correctly. |
| 3 | Controls (keyboard) | **PASS** | W/↑ throttle, S/↓ brake, A/D and ←/→ steer, Shift tuck (badge on/off), P pause, M mute, R restart, Enter start/restart, F fullscreen, Esc pause all verified; no stuck keys after pause/blur (blur clears keys and auto-pauses). |
| 4 | Controls (touch 844×390) | **PASS** | All 6 controls visible, inside viewport and hit-testable: steer 62×62, throttle/brake 64×64, tuck 74×40, pause 44×44. THROTTLE accelerates + `.on` clears on release; TUCK engages/releases; RIGHT steers; BRAKE applies; touch pause pauses/resumes; controls hide on pause/result/crash and reappear on resume; no stuck touch flags after down/leave/up. |
| 5 | Physics/race sanity | **PASS** | jsdom full autopilot race: 99.10 s, P3/5, 0 crashes, 318 km/h top speed, gears 1→6 auto-shift, 2 AI riders finished ahead, all sector splits 1–11 finite and strictly ordered, no NaN anywhere. WebKit finish/result flow verified; best time saved and shown. Note: WebKit `scenic` runs deliberately skip sectors (debug path only) — not a gameplay path. |
| 6 | Best time / localStorage | **PASS** | `saveBestRun` writes `redline.best.v1`; verified in WKWebView on file://, and after `location.reload()` state=title, `REDLINE.best.time=84.04`, `#bestTimeTitle="1:24.04"`, stored JSON intact, no errors. Muted preference also stored. |
| 7 | Layout 1440×900 | **PASS** | No page scroll; title/start/best/controls hints visible & hit-testable; HUD readouts do not overlap (tuck badge vs system buttons overlap was fixed); pause/result/crash panels fit and every action button is inside viewport + hit-testable. |
| 8 | Layout 844×390 landscape | **PASS** | Title fits, start 185×50 at y≈327; countdown/race clean; touch controls do not cover HUD timer/sector/position/callout; pause panel 186 px high and all 5 buttons visible/hit; crash panel 152 px all actions visible; **result panel compacted to 224 px — RUN IT BACK/GARAGE now inside viewport and hit-testable** (previous blocker fixed). |
| 9 | Layout 390×844 portrait | **PASS** | No page scroll; start button and personal-best row visible; touch controls fit without covering HUD; pause (473 px)/crash/result (604 px) panels fully inside 844 px viewport with all actions hit-testable. |
| 10 | Robustness / performance | **PASS** | No runaway console output (single boot log), no uncaught exceptions across ~5 min of stepped racing; jsdom random key-mashing (500 events) produced no errors/NaN; canvas resized on resize/orientation with correct DPR and rendering continued; pause does not advance simulation. |
| 11 | Audio integration | **PASS** | `window.TTEngineAudio` is a function; constructor + `unlock`, `update` (partial/valid state), `setMuted`, `setPaused`, `triggerShift`, `triggerCrash`, `triggerNearMiss`, `triggerCountdown`, `setVolume`, `getLevel`, `stop` all callable with no exceptions; wrapper catches hostile-engine throws; mute/pause/restart/stop produce no errors. In the harness `unlock()` resolves `false` because synthetic JS clicks are not user gestures (expected); no throw/spew. |

## Defects found during QA — all resolved before this final hash

1. **BLOCKER (found on `8fa1adfb`): pause-overlay MUTE and FULLSCREEN were dead buttons.** `ui` lacked `pauseMuteBtn`/`pauseFullBtn` (`index.html` ~1708), so the guarded listeners never attached; on phones (`.sysbtns` hidden at ≤900 px) this removed the only mute/fullscreen controls. Fixed and re-verified on `f2e074`/`f74f2123`: MUTE updates label/`#btnMute` glyph/`localStorage.redline.muted`; FULLSCREEN triggers fullscreen or a explanatory toast.
2. **BLOCKER (found on `f2e074`): 844×390 RESULT primary actions below the fold.** Panel clientH 348 vs scrollH 524; RUN IT BACK/GARAGE at y≈471 in a 390 px viewport, with `body{touch-action:none}` making touch scrolling of the panel unreliable on iOS. Fixed via compact short-landscape result CSS + panel `touch-action:pan-y`; verified: panel 224 px, both buttons inside viewport and `elementFromPoint`-hit.
3. **MINOR (fixed):** TUCK badge overlapped `#btnPause`/system buttons on desktop (672 px²); HUD overlaps now empty.
4. **MINOR (fixed):** touch tuck 60×30 / pause 34×34 raised to 74×40 / 44×44.

## Remaining non-blocking polish / known limitations

1. **`#dangerLabel` can still be partly covered by the left/right steer buttons at 844×390** when it lights up (geometry overlap 210.6/241.8 px²; computed `display:block, opacity:0` normally). The fix that hides it (`index.html:269`) only applies at `max-width:620px`. Suggest moving `.danger-label` or extending the hide rule to `max-width:900px` (`index.html:95`, `269`). Only cosmetic; label is normally transparent.
2. **Sub-44 px touch targets:** compact panel buttons are ~34–39 px high and tuck is 74×40; accepted by the Lead. HIG-recommended 44 px would need slightly taller controls.
3. **Mobile landscape title hides `.title-bottom`** (personal best line not visible on title) — accepted; best time is shown in results/pause context and on portrait/desktop titles.
4. **Debug surface shipped in production:** `window.REDLINE.step/scenic/teleport` (`index.html:5032–5100`) allow console cheating and `scenic`-driven finishes store `null` sector splits. Normal play is unaffected (jsdom full race: all 11 splits finite/ordered); consider gating debug hooks for public release.
5. **Environment limitations:** WKWebView ran with `devicePixelRatio=1`; retina 2× crispness not visually verified (DPR logic itself is exercised and capped). Native animation/transition smoothness cannot be judged in this headless/locked session; result values from `scenic` (avg == top speed) are an artifact of the debug teleport, not normal play (normal-race result sanity verified in jsdom). Audio quality not judged.
6. localStorage persistence verified in WebKit/WKWebView file:// only; other engines not available in this environment.

## Evidence

**Screenshots** (`/tmp/qa-redline/shots/`):
- Desktop 1440×900: `d-title.png`, `d-countdown.png`, `d-race.png`, `d-pause.png`, `d-crash.png`, `d-result.png`, `d-title-best.png`
- Mobile 844×390 touch: `m-title.png`, `m-countdown.png`, `m-race.png`, `m-pause.png`, `m-crash.png`, `m-result.png`, `m-result-scrolled.png`
- Portrait 390×844 touch: `p-title.png`, `p-countdown.png`, `p-race.png`, `p-pause.png`, `p-crash.png`, `p-result.png`

**Logs:** `/tmp/qa-redline/logs/jsdom-final2.log` (152/152), `web-desktop-f74.log` (97/97 + RELOADCHECK), `web-mobile-f74b.log` (49/50), `web-portrait-f74.log` (28/28).

**Harness / scripts:** `/tmp/qa-redline/qa.m`, `/tmp/qa-redline/qa`, `/tmp/qa-redline/scripts/qa-jsdom.js`, `web-helper.js`, `web-desktop-final.js`, `web-mobile.js`, `web-portrait.js`, `_run-*.js`.

**Reproduce:**
```bash
cd /tmp/qa-redline
./qa /path/to/tt-death-ride/index.html 1440 900 scripts/_run-desktop.js d 0
./qa /path/to/tt-death-ride/index.html 844 390 scripts/_run-mobile.js m 1
./qa /path/to/tt-death-ride/index.html 390 844 scripts/_run-portrait.js p 1
cd scripts && NODE_PATH=/tmp/tt-test/node_modules node qa-jsdom.js
```
(`qa` and `_run-*.js` are QA-only copies; the game file was never modified.)
