# Shadow Mirror

A phone web app that watches your shadow **front-foot defence** through the camera
and tells you, rep by rep, what to fix. Pose tracking runs on the phone
(Google MediaPipe). **Video never leaves the phone.** No account, no server.

Open it at:

```
https://binayak-sahu.github.io/Shadow-batting/
```

Open it once **with internet** so it downloads the pose models (Heavy is about 30 MB).
After that it works offline. In Chrome: ⋮ menu → **Add to Home screen** for an app icon.

## What it measures (7 checks per rep)

| Check | What it looks at | What it says when it's off |
|---|---|---|
| Front toe | direction of the front foot at landing, in 3D (0° = at the phone/bowler) | Point your front toe more at the phone |
| Front knee *(3D, new)* | bend of the front knee (hip–knee–ankle) at the finish; green = middle half of 64 professional forward defences (122–154°) | Bend your front knee more |
| Step line | front ankle sideways vs back ankle, landing vs stance | Step straighter, towards the phone |
| Head over foot | head sideways vs front knee/ankle at the finish (more room to the off side) | Head falling away / too far over — keep it over your front knee |
| Knee lift | how high the front knee rises during the step | Smaller step — slide the foot, don't lift the knee |
| Head bob | up-and-down of the head during the step | Keep your head level as you step |
| Base *(experimental — off by default)* | stance width before the rep vs calibration (3D) | Go back to the same stance width |
| Head forward *(experimental — off by default)* | at the finish, how far the head is **behind** the front knee | Lean forward — head over your front knee |

The two *experimental* checks use 3D depth, which real sessions showed is not reliable for
distances; they are recorded but don't drive the cue or score unless Settings → Experimental checks is on.
The result card shows **one cue**; Settings → *Result card: show all numbers* brings back every value.

If you play the shot but your front foot doesn't step, the app says **"No front-foot step seen"**.

**Stand side-on**, as if the phone were the bowler (right-hander: left shoulder to the phone).
The app checks this from your shoulders: it won't calibrate while you face the phone, and if
you turn to face it later it stops grading and asks you to stand side-on again.

Green ● ✓ = good, amber ▲ ! = close, red ■ ✕ = fix. The card shows the **worst** one
(red before amber, in the order above). Head forward is new and last in priority
until its limits are tuned on real recordings.

## First session — 2 minutes

1. Phone **upright** on a box/chair, lens about **1 m** high, **3–4 m** away, where the bowler would be, pointing straight at you.
2. Stand in the middle of the picture with your **feet above the yellow dashed line** (about a fifth of
   the screen of floor below them). Your front foot moves *down* the picture when you step; if it lands
   off the bottom edge the rep is "Not counted". In the first sessions the phone was too close (~2 m)
   and the front foot left the picture on many reps — 3 m or more works.
3. Light **on** you, not behind you. Wear shoes, fitted trousers/shorts.
4. Tap **Start session**, allow the camera, walk back, take your stance and **hold still 2 s** (ring fills).
5. Check the edge labels: for a right-hander **OFF ▸** should be on the right of the screen (it's a mirror).
6. Play the shot, **hold the finish ~½ s**. The phone **says** the rep number and the cue. Go back to your stance; the next rep arms by itself.
7. Hands-free: **both hands above your head for 2 s = finish**, **one hand = recalibrate**.
8. At the end: **Copy summary** → paste to your coach. **Export CSV** for a spreadsheet.

## Settings worth knowing

- **Pose model:** Heavy (default, most accurate). If the phone can't keep 18 fps for 5 s
  (e.g. it got hot), the app switches to Full for the rest of that session and tells you.
- **Camera:** Front (see yourself) or Back (sharper, better indoors / evening; voice is always on).
- **Batting hand:** left-handers are fully supported (the right leg is measured as the front leg).
- **Toe angle method:** 3D (default) needs no camera numbers. 2D is the old flat-picture
  method and is the only one that uses Phone height / distance.
- The bottom line on the live screen shows `fps · model · GPU/CPU · camera resolution`.
  **Tap it** for the debug numbers (visibility of each foot point, ankle speed, H, last rep values).

## Tuning thresholds with your own reps

1. Do a session as normal (Settings → *Keep recording for download* is on by default).
2. On the summary, tap **Download recording** — a small `.json.gz` with your landmarks, **no video**.
3. Open **Lab** (`…/Shadow-batting/lab.html`, also linked from Help) and pick the file.
   It re-runs the session through exactly the same code and confirms it reproduces the live results.
4. Change limits in **Settings**, tick *Use my current Settings* in Lab, and see which reps change colour.

Units: **H** = your height in the picture. 0.05 H ≈ 9 cm for a 183 cm person.
Each check has `good` (green up to) and `warn` (amber up to); above `warn` = red.
If reps aren't counted, lower **Step start speed** or **Minimum step**; if fidgets count, raise them.

## Accuracy limits (honest)

- **Toe angle (3D)** comes from MediaPipe's 3D estimate from one camera. It is much less
  sensitive to phone placement than the old method, but depth is still the weakest
  direction — use it for trends. Record a few reps and check them in Lab.
- **Head forward** uses depth too; its limits are a first guess until tuned on your recordings.
- Feet are the hardest points for MediaPipe; dark shoes on a dark floor, baggy trousers or
  the back foot hidden behind the front foot make them jumpy.

## Updating

GitHub Pages redeploys on every push to `main`, after the self-test passes
(`.github/workflows/static.yml`). The deploy stamps the commit id into `sw.js`, so
the phone notices the new version and shows **A new version is ready → Reload**
on the home screen. No manual version bump needed.

## Files

- `index.html`, `styles.css` — screens.
- `app.js` — camera, main loop, session, storage, summary, settings, gestures/voice UI.
- `pipeline.js` — smoothing → framing → calibration → rep detection → measurements, plus
  the recorder and its file format. No DOM: shared by the app, `lab.html` and `test.html`.
- `pose.js` — loads MediaPipe (GPU → CPU fallback), One-Euro smoothing, framing checks, front/back leg mapping.
- `metrics.js` — rep detection and the 7 measurements (formulas in comments).
- `replay.js` — 4 s rolling buffer and slow-motion replay with guide lines.
- `config.js` — all thresholds and defaults, MediaPipe version (pinned 0.10.14).
- `lab.html` — re-run a recording. `test.html` — self-test on synthetic reps.
- `tests/run-selftest.cjs` — runs `test.html` headless (used by the deploy workflow).
- `sw.js` — offline cache. `manifest.json` + icons — installable app.

## Credits

- Front-knee range (122–154°, median 143°) and the method of measuring joint angles from
  MediaPipe's 3D world landmarks for a camera behind the bowler come from
  [CricketShotQualityAI](https://github.com/vipulpandey21/CricketShotQualityAI)
  (V. Pandey, A. Verma, S. Raj — ABV-IIITM Gwalior; MIT licence; built on
  RITIK-12/CricketShotClassification, MIT). Their professional data also shows a ~19° body
  lean towards the off side in a forward defence, which is why "head to the off side"
  gets more room here than "head to the leg side".
- Pose tracking: Google MediaPipe Pose Landmarker (Apache 2.0).

