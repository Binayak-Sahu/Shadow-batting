# Shadow Mirror

A phone web app that watches your shadow **front-foot defence** through the selfie
camera and tells you, rep by rep, what to fix. Pose tracking runs on the phone
(Google MediaPipe). **Video never leaves the phone.** No account, no server.

It measures 6 things on every rep:

| Check | What it looks at | Cue when it's off |
|---|---|---|
| Front toe | angle of left heel→toe at landing (0° = at the bowler) | Toe to mid-off |
| Step line | front ankle sideways vs back ankle, landing vs stance | Step straight, not wide |
| Head over foot | nose sideways vs front knee/ankle at the finish | Head to the ball |
| Knee lift | how high the front knee rises during the step | Smaller step, slide it |
| Head bob | up-and-down of the nose during the step (smooth forward travel is allowed) | Head level, glide forward |
| Base | stance width before the rep vs calibration | Reset your stance |

Green ● ✓ = good, amber ▲ ! = close, red ■ ✕ = fix. The card shows the **worst** one
(red before amber, in the order above).

## Folder layout

```
Shadow-batting/            ← your existing repo
└── mirror/
    ├── index.html
    ├── styles.css
    ├── app.js
    ├── pose.js
    ├── metrics.js
    ├── replay.js
    ├── config.js
    ├── sw.js
    ├── manifest.json
    ├── icon.svg
    ├── test.html
    └── README.md
```

## Upload to GitHub (web, no coding)

**From a computer (easiest):**
1. Open your repo `Shadow-batting` on github.com.
2. **Add file → Upload files**.
3. Drag the whole **`mirror` folder** onto the page (the folder, not the files — this keeps the folder).
4. Scroll down → **Commit changes**.

**From a phone:**
1. Repo → **Add file → Create new file**. In the name box type `mirror/README.md`
   (typing the `/` creates the folder). Paste this README's text, **Commit**.
2. Open the new `mirror` folder → **Add file → Upload files** → pick the other 11 files → **Commit**.

Wait 1–2 minutes for GitHub Pages to update, then open:

```
https://<your-github-username>.github.io/Shadow-batting/mirror/
```

(The name is case-sensitive: `Shadow-batting` exactly as your repo is named.)
Open it once **with internet** so it downloads the pose model (~10 MB). After that it works offline.
In Chrome: ⋮ menu → **Add to Home screen** to get an app icon.

To check the maths works: open `…/mirror/test.html` — it should say **10 / 10 passed**.

## First session — 2 minutes

1. Phone **upright** on a box/chair, lens ~**1 m** high, **3–4 m** away, where the bowler would be, pointing straight at you (not tilted).
2. Stand in the middle of the picture; head to feet visible with **some space below your feet** (your front foot moves down the picture as you step).
3. Light **on** you, not behind you. Wear shoes, fitted trousers/shorts.
4. Tap **Start session**, allow the camera, walk back, take your stance and **hold still 2 s** (ring fills).
5. Check the edge labels: for a right-hander **OFF ▸** should be on the right of the screen (it's a mirror). If it says the opposite, tap **Recalibrate** and make sure both feet point towards cover in your stance.
6. Play the shot, **hold the finish ~½ s**, read the cue, then go back to your stance. The next rep arms by itself.
7. At the end: **Copy summary** → paste to your coach. **Export CSV** if you want a spreadsheet.

## Tuning thresholds

Easiest: **Settings** in the app. Everything is also in `config.js` → `DEFAULTS`.

- **H** = your height in the picture. 0.05 H ≈ 9 cm for a 183 cm person.
- Each check has `good` (green up to) and `warn` (amber up to). Above `warn` = red.
- If good reps show red, raise that check's limits a little. If bad reps show green, lower them.
- If reps aren't counted: lower **Step start speed** or **Minimum step**. If it counts
  fidgets as reps: raise them.
- Phone below ~18 fps (shown at the bottom)? Settings → Model: **Lite**.
- Set **Phone height** and **Phone distance** to your real setup — the toe angle uses them.
- After you edit any file on GitHub, change `CACHE_VERSION` in `sw.js` (e.g. `v1.0.1`) so the phone picks up the change.

## Accuracy limits (honest)

- **Toe angle** comes from one flat camera, so it's approximate: expect **±15–20°**,
  worse in poor light. Use it to see the trend (60° vs 15°), not exact degrees.
  It depends on Phone height / distance being right.
- **Front-on view only sees sideways.** "Head over foot" checks your head isn't
  falling to the off or leg side; it **cannot** see how far forward you lean.
- Feet are the hardest points for MediaPipe; dark shoes on dark floor, baggy
  trousers or the back foot hidden behind the front foot make them jumpy. If the
  back ankle can't be seen, Step line uses the front foot alone and Base is skipped.
- Distances are scaled to your height, so they don't change with distance, but
  moving well off-centre adds a little sideways error. Stand in the middle.

**Best placement to reduce error:** lens at hip-to-waist height (≈1 m), 3–3.5 m
away, perfectly level and square to you, you centred, body filling about ⅔ of the
screen height, light from behind the phone.

## Files

- `config.js` — all thresholds and defaults, MediaPipe version (pinned 0.10.14).
- `pose.js` — loads MediaPipe (GPU → CPU fallback), One-Euro smoothing, framing checks.
- `metrics.js` — rep detection and the 6 measurements (formulas explained in comments).
- `replay.js` — 4 s rolling buffer and slow-motion replay with guide lines
  (blue = line to the bowler, pink = toe direction, green = plumb line from front foot).
- `app.js` — screens, camera, session, storage (localStorage), CSV/summary.
- `sw.js` — offline cache. `manifest.json` + `icon.svg` — installable app.
- `test.html` — runs `metrics.js` on synthetic reps and prints pass/fail.
