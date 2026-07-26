# dcsketchfest.com

The DC Sketchfest website — a plain static site (HTML + CSS + a little vanilla
JS), rebuilt off Webflow. No build step, no framework, no dependencies. Whatever
is on the `main` branch is what's live.

**Current state: between festivals.** The site is framed around "back in 2027,
dates announced this fall." There are no tickets on sale and no 2027 lineup; the
2026, 2025 and 2024 lineups stay up as an archive. See
[Turning the festival back on](#turning-the-festival-back-on) when dates are set.

```
index.html                  home page
performers-<year>/index.html  lineup pages (generated — see below)
404.html                    not-found page
assets/css/style.css        all styles
assets/js/main.js           mobile nav, sliders, scroll reveals
assets/img/                 all images (nothing loads from Webflow's CDN)
assets/lineups/<year>.json  lineup data, one file per festival
tools/build-lineup.py       regenerates the lineup pages from that JSON
tools/mailing-list.gs       Apps Script for the signup form (deploy separately)
CNAME                       custom domain for GitHub Pages
```

## Working on it locally

```bash
python3 -m http.server 4322
```

Then open <http://localhost:4322>. Edit a file, refresh. That's the whole loop.

## Deploying

Push to `main`. GitHub Pages redeploys in about a minute.

### First-time setup

1. Create a repo on GitHub and push this folder to it:

   ```bash
   git init && git add -A && git commit -m "Rebuild dcsketchfest.com off Webflow"
   git branch -M main
   git remote add origin git@github.com:YOUR-ORG/dcsketchfest.git
   git push -u origin main
   ```

2. In the repo: **Settings → Pages → Source: Deploy from a branch**, branch
   `main`, folder `/ (root)`.

3. Point DNS at GitHub. At the registrar (Squarespace Domains), for
   `dcsketchfest.com`:

   | Type  | Name  | Value                    |
   |-------|-------|--------------------------|
   | A     | `@`   | `185.199.108.153`        |
   | A     | `@`   | `185.199.109.153`        |
   | A     | `@`   | `185.199.110.153`        |
   | A     | `@`   | `185.199.111.153`        |
   | CNAME | `www` | `walkergreen.github.io`  |

   **Leave the MX and TXT records alone** — `admin@dcsketchfest.com` is Google
   Workspace, and its 5 MX records plus SPF and DMARC live in the same zone.

4. Cancel the Webflow plan **after** the new site is confirmed live.

### Canonical host

The bare domain `dcsketchfest.com` is canonical — that's what the `CNAME` file
holds, and `www` redirects to it. Every absolute URL in the site (canonical tags,
`og:url`, `sitemap.xml`, `robots.txt`) points at the bare domain to match; if the
custom domain is ever switched back to `www`, those need updating too or search
engines get contradictory signals.

## Common edits

**Change dates, venue, FAQ answers, testimonials** — edit `index.html`. Each
section is marked with a comment banner (`<!-- ==== faq ==== -->` and so on).

**Change a lineup, or add a year** — lineups live in `assets/lineups/<year>.json`,
one file per festival (2026, 2025, 2024). Edit one, or drop in a new
`2027.json`, then:

```bash
python3 tools/build-lineup.py
```

That rewrites every `performers-<year>/index.html` and rebuilds the year
switcher from whatever files exist, so a new year needs no template edits — just
add its dates and venue to the `YEARS` dict at the top of the script. Commit the
JSON and the generated HTML together.

Performer images live in `assets/img/performers-<year>/`; the `local` field in
each entry points at one. `city` and `link` are optional — cards drop the line
when they're empty.

**Change colors or type** — the palette is a block of CSS variables at the top of
`assets/css/style.css`:

| Variable   | Value     | Used for                                  |
|------------|-----------|-------------------------------------------|
| `--red`    | `#df3d23` | hero, press, FAQ backgrounds              |
| `--cream`  | `#f6ede4` | tickets, venue backgrounds; button text   |
| `--teal`   | `#19647e` | buttons, fest pics, Mumbie, footer        |
| `--yellow` | `#f4d35e` | navbar pill, testimonials, accents        |
| `--purple` | `#5541ba` | secondary buttons, testimonial quotes     |
| `--dark`   | `#211509` | body text, borders                        |

Fonts are Londrina Solid (display) and Inter (body), loaded from Google Fonts.

## Turning the festival back on

When the 2027 dates are public, in order:

1. **Homepage hero** (`index.html`) — replace `Back in 2027 / Dates announced
   this fall` with the real dates and venue. Point the first button back at
   `#about-section` and relabel it `Get Tickets`.
2. **Ticket calendar** — in the `#about-section` block, delete the
   `<div class="coming-soon">` panel and uncomment the block below it marked
   `<!-- TICKETS:`. Set `data-start-date` to the new year (it's already
   `2027-03-01`). The calendar pulls shows straight from Crowdwork, so it fills
   in on its own once shows are published there.
3. **FAQ** — update "When is the 2027 festival?" and "Where do I get tickets?".
4. **Venue** — the `#where-section` copy currently says the 2027 venue is
   confirmed with the dates. Once it's locked, change the heading back to
   `We're back at`.
5. **Lineup** — add the new teams as `assets/lineups/2027.json`, add a `"2027"`
   entry to the `YEARS` dict in `tools/build-lineup.py`, and run it. The page and
   the year switcher build themselves; earlier years stay put as the archive.
   Drop the `.archive-note` paragraph from the template once 2027 is current, and
   point the nav's `Past Lineups` link at `/performers-2026/`.
6. **Structured data** — swap the `Organization` JSON-LD block in `index.html`
   back to a `Festival` block with `startDate`/`endDate`/`location`. The old one
   is in git history.
7. **sitemap.xml** — add the new lineup URL.

## Third-party pieces

- **Tickets** — the Crowdwork calendar embed in `index.html`
  (`crowdwork.com/embed.js`, `data-theatre="dcsketchfest"`), currently commented
  out. Unchanged from the Webflow site; it pulls shows from the Crowdwork
  account, so the lineup and on-sale dates are managed there, not here.
- **Donate** — links to `givebutter.com/dcsketchfest2026`.
- **Map** — a keyless Google Maps embed iframe.

### Mailing list

The signup form on the homepage posts to a Google Apps Script web app, which
appends a row to a Google Sheet you own. No third-party service, no account, no
monthly fee — and the data lives in your Drive.

**It needs one 5-minute setup before it collects anything.** Until then the form
still renders and tells people to email `admin@dcsketchfest.com`.

1. Create a Google Sheet (any name) in the DCSF Google account.
2. **Extensions → Apps Script**. Delete the placeholder, paste in the contents
   of [`tools/mailing-list.gs`](tools/mailing-list.gs), and save.
3. **Deploy → New deployment → Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone** — this must be "Anyone", not "Anyone with a
     Google account", or the form gets a 401 and every signup silently fails.
4. Authorise it when prompted (it's your own script; the "unverified app"
   warning is expected — *Advanced → Go to … (unsafe)*).
5. Copy the deployment URL — it ends in `/exec`.
6. In `index.html`, put it in the form's `data-endpoint`:

   ```html
   <form class="signup" id="signup-form" data-endpoint="https://script.google.com/macros/s/AKfy.../exec">
   ```

7. Commit, push, and test the live form. A row should appear in the Sheet within
   a second or two.

**If you edit the script later, Deploy → *Manage deployments* → edit → New
version.** Without a new version the live URL keeps running the old code — the
most common way this quietly breaks.

What the script does: validates the address, skips duplicates
(case-insensitive), takes a lock so simultaneous signups can't overwrite each
other, and records timestamp, email, name, and which page they signed up from.
The form has a honeypot field that bots fill and humans never see; those
submissions are silently dropped.

**Before shutting Webflow down, export the existing signup list** — those
submissions live in the Webflow dashboard under Forms and are not in this repo.

## Notes

- Images were pulled from Webflow's CDN and resized for the web (5 MB total, down
  from 21 MB of originals). Nothing on the site depends on Webflow staying up.
- The sliders are CSS scroll-snap with arrow buttons — they work with touch,
  trackpad, and keyboard, and degrade to a plain scroller if JS fails.
- Scroll-reveal animations respect `prefers-reduced-motion`.
