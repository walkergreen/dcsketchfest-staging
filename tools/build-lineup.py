#!/usr/bin/env python3
"""Regenerate the lineup pages from assets/lineups/<year>.json.

The generated HTML is committed, so the site needs no build step to deploy.
Run this whenever a lineup changes, or when adding a new year:

    python3 tools/build-lineup.py

One page is written per year: performers-<year>/index.html. Each page carries a
year switcher built from whatever JSON files exist, so adding assets/lineups/
2027.json and rerunning is all it takes to publish a new lineup.

Each entry in a year file looks like:

    {
      "name":  "Bad Medicine",
      "city":  "Washington, DC",     # may be empty
      "slug":  "bad-medicine",
      "blurb": "...",
      "local": "assets/img/performers/bad-medicine.avif",
      "link":  "https://instagram.com/..."   # optional
    }
"""

import html
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "assets" / "lineups"

# Per-year page furniture. Add an entry when a new year is published.
# Leave "dates" empty rather than guessing — the subtitle just omits it.
YEARS = {
    "2026": {"dates": "March 25–28, 2026", "venue": "The DC Arts Center"},
    # 2025 dates come from the festival photo filenames (2025-03-26 … 03-29).
    "2025": {"dates": "March 26–29, 2025", "venue": "The DC Arts Center"},
    "2024": {"dates": "", "venue": "Washington, DC"},
}

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{year} Lineup - DC Sketchfest</title>
<meta name="description" content="The {count} sketch comedy teams who performed at DC Sketchfest {year}.">

<meta property="og:type" content="website">
<meta property="og:url" content="https://dcsketchfest.com/performers-{year}/">
<meta property="og:title" content="{year} Lineup - DC Sketchfest">
<meta property="og:description" content="The {count} sketch comedy teams who performed at DC Sketchfest {year}.">
<meta property="og:image" content="https://dcsketchfest.com/assets/img/brand/og-image.avif">
<meta name="twitter:card" content="summary_large_image">

<link rel="canonical" href="https://dcsketchfest.com/performers-{year}/">
<link rel="icon" href="/assets/img/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/img/brand/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/img/brand/favicon-256.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
<a class="skip-link" href="#lineup">Skip to the lineup</a>

<header class="navbar">
  <div class="nav-inner">
    <div class="nav-bar">
      <a href="/" class="brand" aria-label="DC Sketchfest home">
        <span class="wordmark">DC <span class="wordmark-stars" aria-hidden="true">★★★</span> Sketchfest</span>
      </a>

      <nav id="nav-links" class="nav-links" aria-label="Main">
        <a class="nav-link" href="/#about-section">2027</a>
        <a class="nav-link" href="/performers-{newest}/" aria-current="page">Past Lineups</a>
        <a class="nav-link" href="/#faq-section">FAQ</a>
        <a class="nav-link" href="mailto:admin@dcsketchfest.com?subject=Question">Contact</a>
      </nav>

      <a class="btn nav-donate-desktop" href="https://givebutter.com/dcsketchfest2026"><span>Donate</span></a>

      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-links" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </div>
</header>

<main>
<section class="section lineup-hero">
  <div class="pad pad-sm">
    <div class="container">
      <h1 class="h-lg text-white">{year} <span class="text-yellow">Performers</span></h1>
      <p class="body-copy text-white" style="margin-top:1rem">{subtitle}</p>

      <nav class="year-switch" aria-label="Festival year">
{years}
      </nav>

      <p class="archive-note">DC Sketchfest returns in 2027 &mdash; dates are announced this fall, and the new lineup follows. <a href="/#newsletter-section">Get on the list</a> to hear first.</p>
    </div>
  </div>
</section>

<section id="lineup" class="section lineup-section">
  <div class="pad pad-md">
    <div class="container">
      <div class="performer-grid">
{cards}
      </div>
    </div>
  </div>
</section>

<section class="section section--teal">
  <div class="pad pad-sm">
    <div class="container text-center">
      <h2 class="h-sm text-white">Don&rsquo;t miss 2027</h2>
      <div class="btn-row" style="margin-top:1.5rem">
        <a class="btn btn--yellow" href="/#newsletter-section"><span>Get Updates</span></a>
      </div>
    </div>
  </div>
</section>
</main>

<footer class="footer">
  <div class="pad pad-sm">
    <div class="container footer-wrapper">
      <a class="footer-logo" href="/" title="Homepage">
        <span class="wordmark">DC <span class="wordmark-stars" aria-hidden="true">★★★</span> Sketchfest</span>
      </a>
      <div class="footer-social">
        <div class="join-us">Follow us on social media!</div>
        <div class="social-links">
          <a href="https://facebook.com/dcsketchfest" target="_blank" rel="noopener">fb</a>
          <a href="https://instagram.com/dcsketchfest" target="_blank" rel="noopener">insta</a>
        </div>
      </div>
    </div>
  </div>
</footer>

<script src="/assets/js/main.js" defer></script>
<div class="staging-tag">2027 rebrand · staging preview</div>
</body>
</html>
"""

CARD = """        <article class="performer-card">
          <img src="/{image}" alt="{alt}" loading="lazy" width="400" height="300">
          <div class="performer-card__body">
            <h2 class="performer-card__name">{name}</h2>
{city}            <p class="performer-card__blurb">{blurb}</p>
          </div>
        </article>"""

CITY = '            <p class="performer-card__city">{city}</p>\n'


def render_card(p: dict) -> str:
    name = html.escape(p["name"])
    if p.get("link"):
        name = '<a href="%s" target="_blank" rel="noopener">%s</a>' % (
            html.escape(p["link"], quote=True), name)
    blurb = html.escape(p["blurb"]).replace("\n\n", "<br><br>").replace("\n", "<br>")
    return CARD.format(
        image=p["local"],
        alt=html.escape("%s promotional image" % p["name"], quote=True),
        name=name,
        city=CITY.format(city=html.escape(p["city"])) if p.get("city") else "",
        blurb=blurb,
    )


def main() -> None:
    available = sorted(
        (f.stem for f in DATA_DIR.glob("*.json") if re.fullmatch(r"\d{4}", f.stem)),
        reverse=True,
    )
    if not available:
        raise SystemExit("no year files in %s" % DATA_DIR)

    for year in available:
        performers = json.loads((DATA_DIR / ("%s.json" % year)).read_text())
        performers.sort(key=lambda p: p["name"].lower())

        links = "\n".join(
            '        <a class="year-link%s" href="/performers-%s/"%s>%s</a>'
            % (" is-current" if y == year else "", y,
               ' aria-current="page"' if y == year else "", y)
            for y in available
        )

        meta = YEARS.get(year, {"dates": "", "venue": "Washington, DC"})
        subtitle = " &middot; ".join(
            x for x in ("%d teams" % len(performers), meta["dates"], meta["venue"]) if x)
        out = ROOT / ("performers-%s" % year) / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(PAGE.format(
            year=year,
            newest=available[0],
            count=len(performers),
            subtitle=subtitle,
            years=links,
            cards="\n".join(render_card(p) for p in performers),
        ))
        print("wrote %s (%d performers)" % (out.relative_to(ROOT), len(performers)))


if __name__ == "__main__":
    main()
