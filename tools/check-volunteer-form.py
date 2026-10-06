#!/usr/bin/env python3
"""Verify that /volunteer/ still matches the Google Form it posts into.

The volunteer page submits straight to the form's formResponse endpoint, and
Google answers 200 whether or not it stored anything. A visitor therefore sees
"You're signed up" even when the response was thrown away, so nothing on the
page can notice a break. This script is that missing signal.

It fails loudly on every way the coupling can rot:

  * the form was deleted, closed, or made private
  * a question was added, removed or reordered, changing the entry ids
  * a checkbox option was reworded — Google rejects choice values it does not
    recognise, and rejects the whole response with it
  * email collection was switched to "verified", which forces a Google sign-in
    and blocks anonymous posting outright

Run it after anyone edits the form, and on a schedule if you want warning
before a volunteer is lost rather than after:

    python3 tools/check-volunteer-form.py

Exit status is 0 when the page and the form agree, 1 when they do not.
"""

import html as htmllib
import json
import pathlib
import re
import sys
import urllib.request

FORM_PUBLIC_ID = "1FAIpQLSf3IQ2f6wrhQe0cdu_0TbGnJo70_1DNCT-iABmTUIySwugE0w"
VIEW_URL = f"https://docs.google.com/forms/d/e/{FORM_PUBLIC_ID}/viewform"
PAGE = pathlib.Path(__file__).resolve().parent.parent / "volunteer" / "index.html"

# Questions the page knows how to answer, in the order a visitor meets them.
# "choices" means Google validates the submitted value against its option list.
EXPECTED = {
    "748899624":  {"label": "name",            "choices": False},
    "22364742":   {"label": "email",           "choices": False},
    "150452939":  {"label": "phone",           "choices": False},
    "2141830555": {"label": "areas",           "choices": True},
    "1623177207": {"label": "meeting days",    "choices": True},
    "12081110":   {"label": "past feedback",   "choices": False},
    "1994531496": {"label": "anything else",   "choices": False},
}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "dcsf-form-check/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def live_form(markup):
    """Entry ids -> option list, as the form currently defines them."""
    m = re.search(r"FB_PUBLIC_LOAD_DATA_ = (.*?);\s*</script>", markup, re.S)
    if not m:
        raise LookupError("no form payload — the form may be closed or private")
    items = json.loads(m.group(1))[1][1] or []
    found = {}
    for it in items:
        for entry in (it[4] or []):
            opts = [o[0] for o in (entry[1] or [])] if entry[1] else []
            found[str(entry[0])] = {
                "title": it[1],
                # An empty trailing option is how Forms marks an "Other" box.
                "options": [o for o in opts if o],
                "has_other": any(o == "" for o in opts),
            }
    return found


def page_fields(markup):
    """Entry ids the page posts, and the literal values it sends for each."""
    fields = {}
    for name, value in re.findall(r'name="entry\.(\d+)"[^>]*value="([^"]*)"', markup):
        fields.setdefault(name, []).append(htmllib.unescape(value))
    for name in re.findall(r'name="entry\.(\d+)"', markup):
        fields.setdefault(name, [])
    return fields


def main():
    problems, notes = [], []

    markup = fetch(VIEW_URL)

    if "no longer accepting responses" in markup.lower():
        print("FAIL: the form is closed — every submission is being discarded.")
        return 1

    try:
        live = live_form(markup)
    except LookupError as exc:
        print(f"FAIL: {exc}")
        return 1

    # "Verified" email collection forces a Google sign-in, which an anonymous
    # POST from the page can never satisfy.
    if re.search(r'"emailAddress"|emailCollectionType":\s*2', markup):
        notes.append("email collection may have been switched on — verify "
                     "anonymous submission still works")

    page = page_fields(PAGE.read_text())

    for eid, spec in EXPECTED.items():
        if eid not in page:
            problems.append(f"page no longer posts entry.{eid} ({spec['label']})")
            continue
        if eid not in live:
            problems.append(
                f"entry.{eid} ({spec['label']}) is gone from the form — "
                f"the page still posts it, and Google will drop the response")
            continue
        if spec["choices"]:
            allowed = set(live[eid]["options"])
            if live[eid]["has_other"]:
                allowed.add("__other_option__")
            sent = {v for v in page[eid] if v}
            stale = sorted(sent - allowed)
            if stale:
                problems.append(
                    f"entry.{eid} ({spec['label']}): the page offers "
                    f"{len(stale)} option(s) the form no longer accepts — "
                    f"Google rejects the entire response. First: {stale[0]!r}")
            missing = sorted(allowed - sent - {"__other_option__"})
            if missing:
                notes.append(
                    f"entry.{eid} ({spec['label']}): the form has "
                    f"{len(missing)} option(s) the page does not offer. "
                    f"First: {missing[0]!r}")

    for eid in sorted(set(live) - set(EXPECTED)):
        notes.append(f"the form has a new question (entry.{eid}) the page does "
                     f"not show: {live[eid]['title']!r}")

    for n in notes:
        print(f"NOTE: {n}")

    if problems:
        print()
        for p in problems:
            print(f"FAIL: {p}")
        print("\nRe-sync the page with the form before anyone else signs up.")
        return 1

    print(f"OK: all {len(EXPECTED)} questions still match, form is open and "
          f"accepting anonymous responses.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
