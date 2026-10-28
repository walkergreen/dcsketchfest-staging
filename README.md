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
photos/index.html           photo album (generated — see below)
performers-<year>/index.html  lineup pages (generated — see below)
404.html                    not-found page
assets/css/style.css        all styles
assets/js/main.js           mobile nav, sliders, scroll reveals
assets/img/                 all images (nothing loads from Webflow's CDN)
assets/lineups/<year>.json  lineup data, one file per festival
assets/lineups/gallery.json photo manifest for the album and carousel
assets/img/gallery/<year>/  festival photos (800px thumbs + 1800px full)
tools/build-lineup.py       regenerates the lineup pages from that JSON
tools/build-gallery.py      regenerates the album and the homepage carousel
tools/mailing-list.gs       Apps Script for the signup form (deploy separately)
CNAME                       custom domain for GitHub Pages
```

## Working on it locally

```bash
python3 -m http.server 4322
```

Then open <http://localhost:4322>. Edit a file, refresh. That's the whole loop.

## Deploying

Push to `main`. GitHub Pages redeploys in about a minute. There is no build
step and no CI — the committed HTML is what ships.

---

# How everything is set up

Five moving parts:

1. **GitHub** hosts the files and serves them over HTTPS.
2. **Squarespace** answers DNS for the domain.
3. **A Google Sheet** collects mailing-list signups.
4. **Google Analytics** counts visits.
5. **Crowdwork** sells the tickets.

Only the first two are needed to keep the site up, and none of the five costs
anything monthly (Crowdwork takes its cut per ticket).

## 1. Hosting — GitHub Pages

Three separate repos, each publishing itself to its own subdomain from `main`,
folder `/ (root)`. Each repo's `CNAME` file is what claims its hostname.

| Site | Repo | Serves |
|------|------|--------|
| Live site | [`walkergreen/dcsketchfest`](https://github.com/walkergreen/dcsketchfest) | `dcsketchfest.com` |
| Frozen 2026-brand archive | [`walkergreen/dcsketchfest-2026`](https://github.com/walkergreen/dcsketchfest-2026) | `2026.dcsketchfest.com` |
| Rebrand scratchpad | [`walkergreen/dcsketchfest-staging`](https://github.com/walkergreen/dcsketchfest-staging) | `staging.dcsketchfest.com` |

All three have a Let's Encrypt certificate issued and **Enforce HTTPS** on.
The archive and staging sites are `noindex` with a `robots.txt` disallow, so
they can't compete with the live site in search results.

Settings live at **Settings → Pages** in each repo. The certificate is issued
automatically once DNS resolves; if it never appears (the domain shows a
"not secure" warning and HTTPS serves a `*.github.io` certificate), remove the
custom domain, save, then re-add it — that re-triggers provisioning. That is
the fix, not a DNS change.

## 2. DNS — Squarespace Domains

`dcsketchfest.com` is registered at **Squarespace Domains** (inherited from
Google Domains) and uses Google's nameservers. The zone is *not* in any GCP
project, so records must be edited in the Squarespace panel — there is no API
path to it.

Current records:

| Type  | Name      | Value                   | Why |
|-------|-----------|-------------------------|-----|
| A     | `@`       | `185.199.108.153`       | GitHub Pages |
| A     | `@`       | `185.199.109.153`       | GitHub Pages |
| A     | `@`       | `185.199.110.153`       | GitHub Pages |
| A     | `@`       | `185.199.111.153`       | GitHub Pages |
| CNAME | `www`     | `walkergreen.github.io` | redirects to the bare domain |
| CNAME | `2026`    | `walkergreen.github.io` | archive site |
| CNAME | `staging` | `walkergreen.github.io` | staging site |

Every hostname points at `walkergreen.github.io`; GitHub decides which repo to
serve by matching the requested hostname against each repo's `CNAME` file. That
is why adding a new subdomain is two steps: a CNAME here, and a `CNAME` file in
the repo that should answer it.

> **Never touch the MX or TXT records.** `admin@dcsketchfest.com` is Google
> Workspace, and its 5 MX records plus the SPF (`v=spf1 include:_spf.google.com
> ~all`) and DMARC entries live in this same zone. Deleting them takes down
> festival email, which is a far worse outage than the website being down.

### Canonical host

The bare domain is canonical — that's what `CNAME` holds, and `www` redirects
to it. Every absolute URL in the site (canonical tags, `og:url`, `sitemap.xml`,
`robots.txt`) points at the bare domain to match. If the custom domain is ever
switched to `www`, those all need updating too, or search engines get
contradictory signals.

## 3. Email marketing — Google Sheet + Apps Script

The signup form on the homepage posts to a Google Apps Script web app, which
appends a row to a Google Sheet. No Mailchimp, no third-party account, no
monthly fee, and the list stays in the festival's own Drive.

**This is already wired up and collecting.** The pieces:

| Piece | Where |
|-------|-------|
| The form | `index.html`, `<form class="signup">`, its `data-endpoint` holds the `/exec` URL |
| The script | `tools/mailing-list.gs` — the copy of record; the running copy is pasted into Apps Script |
| The Sheet | ID `1Ie3SdfTFCmJSqegK4n_zG5mf26puzopWpDWgP-ISiXQ`, tab `Signups` |

Columns are `Timestamp, Email, Name, Source, User agent`. The script validates
the address, skips duplicates case-insensitively, and takes a lock so two
simultaneous signups can't overwrite each other. The form carries a honeypot
field that bots fill and humans never see; those submissions are accepted in
the UI and silently dropped.

**To send an actual email blast**, export the Sheet (File → Download → CSV) and
import it into whatever sends the mail. Nothing in this repo sends email.

### If you change the script

Edit `tools/mailing-list.gs` here *and* in Apps Script, then **Deploy → Manage
deployments → edit → New version**. Without a new version the live URL keeps
running the old code — the single most common way this quietly stops working.

### If you ever rebuild it from scratch

1. Create a Sheet in the DCSF Google account.
2. **Extensions → Apps Script**, paste in `tools/mailing-list.gs`, and set
   `SHEET_ID` to that Sheet's id.
3. **Deploy → New deployment → Web app**, *Execute as:* **Me**,
   *Who has access:* **Anyone** — it must be "Anyone", not "Anyone with a
   Google account", or the form gets a 401 and every signup fails silently.
4. Authorise it (the "unverified app" warning is expected for your own script:
   *Advanced → Go to … (unsafe)*).
5. Put the `/exec` URL into the form's `data-endpoint` in `index.html`.

If `data-endpoint` is ever emptied, the form degrades gracefully: it still
renders and tells people to email `admin@dcsketchfest.com`.

## 4. Analytics — Google Analytics 4

Measurement ID **`G-5WTXCDDHMK`** (GA4), in the `<head>` of every page —
homepage, photo album, all three lineup pages, and the 404. Reports are in the
GA dashboard under the DCSF Google account; nothing is stored in this repo.

Because most pages are generated, the tag lives in **four** places:
`index.html`, `404.html`, and both generators in `tools/`. It is injected
through a placeholder rather than pasted inline — see the brace warning under
[Generated pages](#generated-pages-read-this-before-editing-html).

To verify it is really reporting (rather than just present in the HTML), open
the site with devtools on the Network tab and look for a request to
`analytics.google.com/g/collect` carrying `tid=G-5WTXCDDHMK`. The tag being in
the page source is not proof it fires.

To swap the property, change the ID in all four files and rerun both
generators.

## 5. Ticketing — Crowdwork

Tickets are **not** sold by this site. They are sold by
[Crowdwork](https://crowdwork.com), under the theatre handle
`dcsketchfest`. The homepage embeds Crowdwork's calendar, which pulls shows
straight from that account:

```html
<script id="fw_script" src="https://crowdwork.com/embed.js?v=6"
        data-theatre="dcsketchfest" data-type="shows" data-view="calendar"
        data-start-date="2027-03-01"></script>
```

**Shows, prices, and on-sale dates are managed in the Crowdwork account, not
here.** Publish a show there and it appears on the site by itself; nothing in
this repo needs a commit for a lineup or on-sale change.

Between festivals that embed is **commented out** in `index.html` and a
"2027 is coming" panel stands in its place, because an empty calendar looks
broken. To turn ticketing back on, follow step 2 of
[Turning the festival back on](#turning-the-festival-back-on): delete the
`.coming-soon` panel and uncomment the block marked `<!-- TICKETS:`.

Donations are separate and go through Givebutter
(`givebutter.com/dcsketchfest2027`), linked from the Donate button in the nav.

## Generated pages (read this before editing HTML)

Only `index.html` and `404.html` are hand-maintained. `photos/index.html` and
every `performers-<year>/index.html` are **generated**, and so is the homepage
Fest Pics carousel (between the `<!-- GALLERY:start -->` / `<!-- GALLERY:end -->`
markers).

So a site-wide change — a nav link, the footer, the donate URL, an analytics
tag — has to be made in **both generators plus the two hand-maintained pages**,
then the generators rerun:

```bash
python3 tools/build-lineup.py && python3 tools/build-gallery.py
```

Editing a generated file directly works until the next rebuild silently
reverts it.

> **Watch the braces.** `build-lineup.py`'s page template is a `.format()`
> string and `build-gallery.py`'s is an f-string. Any snippet containing a
> literal `{` or `}` — the Google Analytics tag, most JavaScript — will be
> mangled or throw if pasted inline. Define it as a module-level constant and
> pass it through a placeholder, the way `GA_TAG` is wired.

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

**Change the photos** — the album at `/photos/` and the homepage Fest Pics
carousel are both generated from `assets/lineups/gallery.json`:

```bash
python3 tools/build-gallery.py
```

Each entry holds a team name, a date, and paths to a thumbnail (800px) and a
full-size image (1800px) under `assets/img/gallery/<year>/`. To swap what the
homepage carousel shows, edit the `CAROUSEL` list at the top of
`tools/build-gallery.py` — it names photos by team, so reprocessing the images
can't silently reshuffle the front page. To add a year, add its photos, add an
entry to `YEARS` in the same script, and rerun it. Commit the JSON, the images,
and the generated `photos/index.html` together.

Photos are by Mikail Faalasli; the originals live in the festival's Google
Drive (roughly 32 GB of raw JPEGs across 2025 and 2026, plus a 2024 folder) and
are deliberately not in this repo — only the resized web copies are.

**Change colors or type** — the palette is a block of CSS variables at the top of
`assets/css/style.css`:

| Variable   | Value     | Used for                                     |
|------------|-----------|----------------------------------------------|
| `--blue`   | `#2b3fbf` | hero, fest pics, Mumbie, lineup page heroes  |
| `--pink`   | `#ef4d8e` | press + FAQ backgrounds, accents, shadows    |
| `--yellow` | `#ffc933` | ticker, testimonials, buttons                |
| `--paper`  | `#f6efe1` | paper backgrounds, navbar, light text        |
| `--ink`    | `#211b3a` | text, borders, newsletter + footer           |

The pre-2027 names (`--red`, `--cream`, `--teal`, `--purple`, `--dark`) are
aliased onto these inks so older inline styles and generated pages keep
working — change the new variables, not the aliases.

Fonts are Anton (display) and Space Grotesk (body), loaded from Google Fonts.

### The logo

In the header and footer the logo is **not an image** — it is live text set in
Anton plus an inline SVG of the DC flag (three stars over two bars), assembled
by `.wordmark` / `.wordmark-flag` in the stylesheet. That keeps it crisp at any
size and recolourable per background, which is why the footer version is cream
and the header version is ink.

For anywhere outside the website — posters, socials, a partner asking for "your
logo" — use the standalone files, which carry the same lockup with the type
converted to outlines so they need no font installed:

| File | Use on |
|------|--------|
| `assets/img/brand/logo-wordmark.svg` | light backgrounds (ink type) |
| `assets/img/brand/logo-wordmark-light.svg` | dark backgrounds (cream type) |

The flag is `--pink` in both. They were generated from the live CSS lockup and
match the desktop header to within half a percent.

Two caveats. The CSS gap between the flag and the words is a fixed `7.2px`
rather than an em value, so the on-site lockup is slightly tighter at large
sizes than at small ones; the SVG files use a fixed `0.30em`, matching the
desktop header. And the old 2026 PNG logos (`logo-wide.png`, `logo-stacked.png`)
are still in `assets/img/brand/` — nothing on the site renders them, but the
`Organization` JSON-LD block in `index.html` still points `logo` at
`logo-stacked.png`, so that needs a new raster export before it is accurate. The 2026-brand site is archived at
[2026.dcsketchfest.com](https://2026.dcsketchfest.com)
(github.com/walkergreen/dcsketchfest-2026).

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
4. **Venue** — announced: **MILKCRATE** on Wednesday 31 March and Thursday
   1 April, **Sitar Arts Center** on Friday 2 April and Saturday 3 April.
   The names are in the homepage intro, the "Where is it happening?" FAQ,
   the JSON-LD `location` array, the apply page's dates line and Location
   block, `CONFIG.dates_line`/`CONFIG.location` in `apply.js`, and the
   archive note in `tools/build-lineup.py`. Neither street address is
   published yet: add `address` to each `Place` in the JSON-LD and, if you
   want a map back, restore a panel using the `.venue-tba` / `.venue-map`
   rules still in `style.css`.


5. **Lineup** — add the new teams as `assets/lineups/2027.json`, add a `"2027"`
   entry to the `YEARS` dict in `tools/build-lineup.py`, and run it. The page and
   the year switcher build themselves; earlier years stay put as the archive.
   Drop the `.archive-note` paragraph from the template once 2027 is current, and
   point the nav's `Past Lineups` link at `/performers-2026/`.
6. **Structured data** — swap the `Organization` JSON-LD block in `index.html`
   back to a `Festival` block with `startDate`/`endDate`/`location`. The old one
   is in git history.
7. **sitemap.xml** — add the new lineup URL.

## Third-party pieces at a glance

Everything the site talks to, and where it is documented:

| Piece | Account | Details |
|-------|---------|---------|
| Hosting | GitHub | [1. Hosting](#1-hosting--github-pages) |
| DNS | Squarespace Domains | [2. DNS](#2-dns--squarespace-domains) |
| Mailing list | Google Sheet + Apps Script | [3. Email marketing](#3-email-marketing--google-sheet--apps-script) |
| Analytics | Google Analytics 4, `G-5WTXCDDHMK` | [4. Analytics](#4-analytics--google-analytics-4) |
| Tickets | Crowdwork, `dcsketchfest` | [5. Ticketing](#5-ticketing--crowdwork) |
| Donations | Givebutter, `dcsketchfest2027` | Donate button in the nav, on every page |
| Fonts | Google Fonts | Anton + Space Grotesk, loaded per page |
| Email | Google Workspace | `admin@dcsketchfest.com` — **MX records live in the same DNS zone** |

**Legacy note:** the pre-rebuild signup list lived in the Webflow dashboard
under Forms and was never in this repo. Export it before that account lapses if
it hasn't been exported already — those addresses are not in the Sheet.

## Notes

- Images were pulled from Webflow's CDN and resized for the web (5 MB total, down
  from 21 MB of originals). Nothing on the site depends on Webflow staying up.
- The sliders are CSS scroll-snap with arrow buttons — they work with touch,
  trackpad, and keyboard, and degrade to a plain scroller if JS fails.
- Scroll-reveal animations respect `prefers-reduced-motion`.
