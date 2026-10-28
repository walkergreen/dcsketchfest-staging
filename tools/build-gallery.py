#!/usr/bin/env python3
"""Generate the photo album page and the homepage Fest Pics carousel.

Reads assets/lineups/gallery.json (written when photos are imported) and
rewrites photos/index.html plus the marked block in index.html. Rerun after
adding a year or swapping images; both outputs are generated, never hand-edited.
"""
import html
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "assets/lineups/gallery.json"

YEARS = {
    "2026": {"dates": "March 25–28, 2026", "venue": "The DC Arts Center"},
    "2025": {"dates": "March 26–29, 2025", "venue": "The DC Arts Center"},
    "2024": {"dates": "March 20–23, 2024",
             "venue": "The DC Improv and The DC Arts Center"},
}

# Homepage carousel, in order. Named rather than indexed so reprocessing the
# photos can't silently reshuffle the front page.
CAROUSEL = [
    ("2026", "Burnt Toast"),
    ("2026", "Cam Wyllie"),
    ("2026", "MIST"),
    ("2026", "Sewer Boy LLC"),
    ("2026", "DC Raclette Club"),
    ("2026", "The Incident"),
    ("2026", "Fanfiction Theater"),
    ("2026", "Chaps"),
    ("2026", "Drop the Root Beer and Run"),
    ("2026", "Etch A Sketch"),
]

GA_TAG = """<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-5WTXCDDHMK"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-5WTXCDDHMK');
</script>
"""

NAV = """      <nav id="nav-links" class="nav-links" aria-label="Main">
        <a class="nav-link" href="/#about-section">2027</a>
        <a class="nav-link" href="/apply/">Apply</a>
        <a class="nav-link" href="/volunteer/">Volunteer</a>
        <a class="nav-link" href="/performers-2026/">Past Lineups</a>
        <a class="nav-link" href="/photos/" aria-current="page">Photos</a>
        <a class="nav-link" href="/#faq-section">FAQ</a>
        <a class="nav-link" href="mailto:admin@dcsketchfest.com?subject=Question">Contact</a>
        <a class="nav-link nav-donate-mobile" href="https://givebutter.com/dcsketchfest2027">Donate</a>
      </nav>"""

WORDMARK = ('<span class="wordmark">DC <svg class="wordmark-flag" viewBox="0 0 60 40" '
            'aria-hidden="true" focusable="false">'
            '<polygon points="11.0,2.5 13.0,8.2 19.1,8.4 14.2,12.1 16.0,17.9 11.0,14.4 6.0,17.9 7.8,12.1 2.9,8.4 9.0,8.2"/>'
            '<polygon points="30.0,2.5 32.0,8.2 38.1,8.4 33.2,12.1 35.0,17.9 30.0,14.4 25.0,17.9 26.8,12.1 21.9,8.4 28.0,8.2"/>'
            '<polygon points="49.0,2.5 51.0,8.2 57.1,8.4 52.2,12.1 54.0,17.9 49.0,14.4 44.0,17.9 45.8,12.1 40.9,8.4 47.0,8.2"/>'
            '<rect x="0" y="23" width="60" height="6"/>'
            '<rect x="0" y="33" width="60" height="6"/>'
            "</svg> Sketchfest</span>")


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def find(manifest, year, team):
    for e in manifest[year]:
        if e["team"] == team:
            return e
    raise SystemExit(f"carousel photo not found: {year} / {team}")


def build_carousel(manifest) -> str:
    slides = []
    for year, team in CAROUSEL:
        e = find(manifest, year, team)
        # The full-size file, not the thumb: a slide is ~950px wide on desktop
        # and 800px thumbs visibly soften when stretched to it.
        slides.append(
            f'          <figure class="slide-card" style="background-image:url(\'{e["full"]}\')">\n'
            f'            <figcaption class="slide-card__name">{esc(e["team"])}</figcaption>\n'
            f"          </figure>"
        )
    return "\n".join(slides)


def build_album(manifest) -> str:
    sections = []
    for year in ("2026", "2025", "2024"):
        entries = manifest.get(year, [])
        if not entries:
            continue
        meta = YEARS[year]
        tiles = []
        for e in entries:
            caption = esc(e["team"])
            tiles.append(
                f'          <button class="photo-tile" type="button"\n'
                f'                  data-full="{e["full"]}" data-caption="{caption} &middot; {year}">\n'
                f'            <img src="{e["thumb"]}" alt="{caption} performing at DC Sketchfest {year}"\n'
                f'                 loading="lazy" width="800" height="533">\n'
                f'            <span class="photo-tile__name">{caption}</span>\n'
                f"          </button>"
            )
        sections.append(
            f'      <section class="album-year" id="y{year}">\n'
            f'        <div class="album-head">\n'
            f'          <h2 class="h-lg">{year}</h2>\n'
            f'          <p class="album-meta">{meta["dates"]} &middot; {meta["venue"]} &middot; '
            f'{len(entries)} photos</p>\n'
            f"        </div>\n"
            f'        <div class="photo-grid">\n' + "\n".join(tiles) + "\n        </div>\n"
            f"      </section>"
        )
    return "\n\n".join(sections)


def album_page(manifest) -> str:
    years = [y for y in ("2026", "2025", "2024") if manifest.get(y)]
    jump = "\n".join(
        f'        <a class="year-link" href="#y{y}">{y}</a>' for y in years
    )
    total = sum(len(manifest[y]) for y in years)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

{GA_TAG}<title>Photo Album - DC Sketchfest</title>
<meta name="description" content="Photos from DC Sketchfest 2026, 2025 and 2024 — {total} shots from the District's sketch comedy festival, by Mikail Faalasli.">

<meta property="og:type" content="website">
<meta property="og:url" content="https://dcsketchfest.com/photos/">
<meta property="og:title" content="Photo Album - DC Sketchfest">
<meta property="og:description" content="Photos from DC Sketchfest 2026, 2025 and 2024, shot by Mikail Faalasli.">
<meta property="og:image" content="https://dcsketchfest.com/assets/img/brand/og-image.avif">
<meta name="twitter:card" content="summary_large_image">

<link rel="canonical" href="https://dcsketchfest.com/photos/">
<link rel="icon" href="/assets/img/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/img/brand/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/img/brand/favicon-256.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
<a class="skip-link" href="#album">Skip to the photos</a>

<header class="navbar">
  <div class="nav-inner">
    <div class="nav-bar">
      <a href="/" class="brand" aria-label="DC Sketchfest home">
        {WORDMARK}
      </a>

{NAV}

      <a class="btn nav-donate-desktop" href="https://givebutter.com/dcsketchfest2027"><span>Donate</span></a>

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
      <h1 class="h-lg text-white">Photo <span class="text-yellow">Album</span></h1>
      <p class="body-copy text-white" style="margin-top:1rem">{total} photos from three festivals, shot by
        <a class="link" href="https://instagram.com/mfaalasli" target="_blank" rel="noopener">Mikail Faalasli</a>.</p>

      <nav class="year-switch" aria-label="Jump to a year">
{jump}
      </nav>
    </div>
  </div>
</section>

<section id="album" class="section lineup-section">
  <div class="pad pad-md">
    <div class="container">
{build_album(manifest)}
    </div>
  </div>
</section>
</main>

<!-- Lightbox: markup lives here, main.js wires it up. -->
<div class="lightbox" id="lightbox" hidden>
  <button class="lightbox__close" type="button" aria-label="Close">&times;</button>
  <button class="lightbox__nav lightbox__nav--prev" type="button" aria-label="Previous photo">&#8592;</button>
  <figure class="lightbox__figure">
    <img class="lightbox__img" src="" alt="">
    <figcaption class="lightbox__caption"></figcaption>
  </figure>
  <button class="lightbox__nav lightbox__nav--next" type="button" aria-label="Next photo">&#8594;</button>
</div>

<footer class="footer">
  <div class="pad pad-sm">
    <div class="container footer-wrapper">
      <a class="footer-logo" href="/" title="Homepage">
        {WORDMARK}
      </a>
      <div class="footer-social">
        <div class="join-us">Follow us on social media!</div>
        <div class="social-links">
          <a href="https://facebook.com/dcsketchfest" target="_blank" rel="noopener">fb</a>
          <a href="https://instagram.com/dcsketchfest" target="_blank" rel="noopener">insta</a>
        </div>
      </div>
    </div>
      <p class="footer-credit">Design by <a href="https://instagram.com/guywalks" target="_blank" rel="noopener">Walker Green</a></p>

  </div>
</footer>

<script src="/assets/js/main.js" defer></script>
</body>
</html>
"""


def main():
    manifest = json.loads(MANIFEST.read_text())

    out = ROOT / "photos/index.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(album_page(manifest))
    print(f"wrote {out.relative_to(ROOT)}")

    index = ROOT / "index.html"
    text = index.read_text()
    new, count = re.subn(
        r"(<!-- GALLERY:start -->\n)(.*?)(\s*<!-- GALLERY:end -->)",
        lambda m: m.group(1) + build_carousel(manifest) + m.group(3),
        text,
        flags=re.S,
    )
    if not count:
        raise SystemExit("GALLERY markers not found in index.html")
    index.write_text(new)
    print("updated index.html carousel"
          if new != text else "index.html carousel already current")


if __name__ == "__main__":
    main()
