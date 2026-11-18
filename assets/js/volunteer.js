/* Volunteer sign-up form.
 *
 * Sign-ups go to the Worker's relay (POST /api/volunteer/signup), which
 * forwards them into the Google Form behind this page, so Google still writes
 * each response into the organisers' sheet. The page used to post straight to
 * Google's formResponse endpoint, which put the form id and every entry id in
 * public markup; bots replayed that template directly at Google, where nothing
 * on this page ever ran, and flooded the sheet. The form now has a required
 * "Website check" question that only the relay answers, so a post made
 * straight to Google is rejected.
 *
 * Going through the relay also fixes the old blind spot. Google's endpoint
 * sends no CORS headers, so the browser could never tell a stored response
 * from a rejected one and thanked everyone. The relay reads Google's answer
 * and passes it back, so this page thanks people only for sign-ups Google kept.
 *
 * The relay wants a ticket the Worker issues with every answer from the
 * status check below, and refuses one less than a few seconds old, so a
 * crawler that submits the form without running this script gets nowhere.
 *
 * The status check still runs before anyone fills the form in, and withdraws
 * it when the answer proves a sign-up would be thrown away. It withdraws only
 * on proof: a check that fails, or cannot tell, leaves the form as it was.
 */
(function () {
  "use strict";

  var form = document.getElementById("volunteer-form");
  if (!form) return;

  var errors = document.getElementById("errors");
  var done = document.getElementById("done");
  var submitBtn = document.getElementById("submit");
  var clearBtn = document.getElementById("clear");
  var otherBox = document.getElementById("area-other");
  var otherWrap = document.getElementById("area-other-wrap");
  var otherText = document.getElementById("area-other-text");

  var REQUIRED = [
    { id: "name", label: "your name" },
    { id: "email", label: "your email address" },
    { id: "phone", label: "your phone number" }
  ];

  /* The last answer the Worker gave, so validation can enforce questions the
     form marks required. Null until the first probe lands, which keeps every
     check fail-open before then. */
  var liveSeen = null;

  var API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "http://localhost:8789/api/volunteer/"
    : "https://dcsketchfest-app.walker-df2.workers.dev/api/volunteer/";
  var STATUS_URL = API + "form";
  var SIGNUP_URL = API + "signup";

  /* The relay refuses a ticket younger than this, so instant fills are
     turned away. Measured on this browser's own clock from when the ticket
     arrived, since the visitor's clock and the Worker's may disagree; the
     margin over the Worker's 3 seconds absorbs the network trip. */
  var TICKET_MIN_MS = 3500;
  /* The earliest ticket this visit was given. The status check runs again at
     submit, and its fresh ticket would be too new to use, so the first one is
     kept for as long as the relay accepts it. */
  var ticket = null;
  var ticketAt = 0;
  var TICKET_KEEP_MS = 11 * 3600 * 1000;

  function keepTicket(live) {
    if (!live || typeof live.ticket !== "string") return;
    if (ticket && Date.now() - ticketAt < TICKET_KEEP_MS) return;
    ticket = live.ticket;
    ticketAt = Date.now();
  }

  /* The only question with an Other box. Named once so the submit wiring and
     the liveness check cannot disagree about which question that is. */
  var OTHER_ENTRY = "2141830555";

  /* The "Other" checkbox carries no name until it is ticked. An unticked box
     is never submitted, but a ticked one must send __other_option__ alongside
     the free-text answer or Google drops both. */
  function syncOther() {
    var on = otherBox.checked;
    otherWrap.hidden = !on;
    otherBox.name = on ? "entry." + OTHER_ENTRY : "";
    if (!on) otherText.value = "";
  }

  otherBox.addEventListener("change", function () {
    syncOther();
    if (otherBox.checked) otherText.focus();
  });
  syncOther();

  function showErrors(list) {
    if (!list.length) {
      errors.hidden = true;
      errors.textContent = "";
      return false;
    }
    errors.hidden = false;
    errors.innerHTML = "<p>Please check the following:</p><ul>" +
      list.map(function (e) { return "<li>" + e + "</li>"; }).join("") + "</ul>";
    errors.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  /* Does the page currently hold an answer for this question? A checkbox group
     with nothing ticked and an empty textarea both submit NOTHING, which is the
     difference between "the page has a control for it" and "Google will receive
     an answer". */
  function hasValueFor(id) {
    var els = form.querySelectorAll('[name="entry.' + id + '"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = String(el.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (el.checked) return true;
      } else if (String(el.value || "").trim()) {
        return true;
      }
    }
    return false;
  }

  /* The question's own wording, so an error names what to fill in. A fieldset
     keeps it in the legend; a plain field in its label. */
  function labelFor(id) {
    var el = form.querySelector('[name="entry.' + id + '"]');
    var wrap = el && el.closest ? el.closest(".field") : null;
    if (!wrap) return null;
    var legend = wrap.querySelector("legend");
    var text = legend ? legend.textContent : (wrap.querySelector("label") || {}).textContent;
    text = String(text || "").replace(/\*/g, "").replace(/\s+/g, " ").trim();
    return text || null;
  }

  /* Entry ids already covered by REQUIRED, so the probe-driven check below
     does not report the same empty field twice. */
  function builtInRequired() {
    var ids = {};
    REQUIRED.forEach(function (f) {
      var el = document.getElementById(f.id);
      var m = el && /^entry\.(\d+)$/.exec(el.getAttribute("name") || "");
      if (m) ids[m[1]] = true;
    });
    return ids;
  }

  function validate() {
    var problems = [];

    REQUIRED.forEach(function (f) {
      var el = document.getElementById(f.id);
      var empty = !el.value.trim();
      el.setAttribute("aria-invalid", empty ? "true" : "false");
      if (empty) problems.push("Enter " + f.label + ".");
    });

    var email = document.getElementById("email");
    if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
      email.setAttribute("aria-invalid", "true");
      problems.push("That email address does not look right.");
    }

    if (otherBox.checked && !otherText.value.trim()) {
      problems.push("You ticked Other — tell us what you had in mind.");
    }

    /* Questions the FORM now marks required. REQUIRED above covers the three
       this page has always required; an organiser can tick "Required" on any
       other question later, and Google then rejects the whole response when it
       arrives unanswered. The page cannot know that on its own, so it asks.

       Only questions this page actually has a control for: one it does not is
       drift, which breakage() withdraws over rather than asking a visitor to
       answer something that is not on screen. */
    var builtIn = builtInRequired();
    ((liveSeen && liveSeen.required) || []).forEach(function (id) {
      if (builtIn[id]) return;
      if (!form.querySelector('[name="entry.' + id + '"]')) return;
      if (hasValueFor(id)) return;
      var label = labelFor(id);
      problems.push(label
        ? "Answer: " + label
        : "One of the questions is now required — please complete it.");
    });

    return problems;
  }

  /* --------------------------------------------------- liveness check --- */

  /* Which questions this page posts, and the literal choice values it offers
     for each. The markup is the only record of that, which is why nothing
     server-side keeps a second copy to drift against.

     entry.N.other_option_response rides along with entry.N rather than being a
     question of its own, so the exact-match pattern leaves it out. */
  function pageFields() {
    var sent = {};
    form.querySelectorAll("[name]").forEach(function (el) {
      var match = /^entry\.(\d+)$/.exec(el.getAttribute("name") || "");
      if (!match) return;
      var id = match[1];
      if (!sent[id]) sent[id] = [];
      var value = el.getAttribute("value");
      // __other_option__ is a marker Google defines for every Other box, not a
      // configured option, so it never appears in the form's own option list.
      if (value && value !== "__other_option__") sent[id].push(value);
    });
    return sent;
  }

  /* Why a sign-up would be discarded right now, or null for "no proof that it
     would be". Mirrors the FAIL conditions in tools/check-volunteer-form.py. */
  function breakage(live) {
    if (!live || live.ok !== true) return null;
    if (live.status === "closed") return "closed";
    if (live.status !== "ok") return null;

    /* Email collection rejects every anonymous POST this page makes: verified
       collection forces a Google sign-in the page cannot do, and responder
       input adds a required emailAddress field it does not send. */
    if (live.emailCollection === true) return "email";

    var declared = {};
    (live.entries || []).forEach(function (id) { declared[id] = true; });
    if (!live.entries || !live.entries.length) return null;

    var sent = pageFields();
    for (var id in sent) {
      if (!Object.prototype.hasOwnProperty.call(sent, id)) continue;

      // A question the page still posts and the form no longer has. Google
      // drops the answer, and rejects the whole response if it was a choice.
      if (!declared[id]) return "drifted";

      var allowed = (live.choices || {})[id];
      if (!allowed) continue;

      /* The form constrains this question to a list and the page offers no
         fixed values for it, so the page posts free text where Google now
         expects one of its own options and rejects the whole response. A
         question converted from text to multiple choice looks exactly like
         this, and is otherwise invisible: with no values to check, the loop
         below never runs. */
      if (!sent[id].length) return "drifted";

      for (var i = 0; i < sent[id].length; i++) {
        // Google rejects a choice value it does not recognise, and rejects the
        // entire response along with it.
        if (allowed.indexOf(sent[id][i]) === -1) return "drifted";
      }
    }

    /* The other direction. The loop above walks only the fields this page
       posts, so a question ADDED to the form is invisible to it -- and if that
       question is required, Google rejects every response this page sends and
       the page would go on thanking people for sign-ups it threw away. That is
       the exact failure this whole check exists to prevent.

       Only required ids count. An added optional question costs one answer;
       an added required one costs the entire response. A Worker too old to
       report `required` yields [], which keeps the fail-open contract. */
    var req = live.required || [];
    var relay = live.relay || [];
    for (var r = 0; r < req.length; r++) {
      // The relay answers these itself (the gate question), so the page having
      // no control for them is the design, not drift.
      if (relay.indexOf(req[r]) !== -1) continue;
      // sent[id] is [] for a text field the page does post, which is truthy,
      // so this fires only where the page has no control for the question.
      if (!sent[req[r]]) return "drifted";
    }

    /* The page offers an Other box for OTHER_ENTRY. If the form no longer has
       one there, Google rejects __other_option__ and discards the entire
       response -- and only the volunteers with something of their own to add
       are affected, which is the hardest kind of loss to notice. The Worker
       has always reported this; the page simply never read it. A Worker too
       old to send `other` yields undefined and changes nothing. */
    if (live.other && (live.choices || {})[OTHER_ENTRY]
        && live.other.indexOf(OTHER_ENTRY) === -1) {
      return "drifted";
    }

    return null;
  }

  var WHY = {
    closed: "The volunteer form is closed at the moment, so this page can’t record a sign-up.",
    email: "The volunteer form now asks people to sign in with Google, which this page can’t do, so a sign-up made here wouldn’t reach us.",
    drifted: "This page and the volunteer form have fallen out of step, so a sign-up made here wouldn’t reach us."
  };

  var blocked = false;

  function withdraw(kind) {
    blocked = true;
    form.hidden = true;
    if (errors) errors.hidden = true;
    done.hidden = false;
    done.innerHTML =
      "<h2 class=\"h-sm\">Volunteer sign-ups are paused</h2>" +
      "<p>" + (WHY[kind] || WHY.drifted) +
      " Email us instead and we’ll add you by hand — and we’d like to know this page is broken, so please do.</p>" +
      "<a class=\"btn btn--yellow\" href=\"mailto:admin@dcsketchfest.com?subject=Volunteering%20with%20DC%20Sketchfest\">" +
      "<span>Email admin@dcsketchfest.com</span></a>";
    done.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* Ask the Worker what the form accepts. Fails open in every direction: an
     error, a timeout, or a non-ok answer all resolve to null, which breakage()
     reads as "no proof", so the check being broken never blocks a sign-up. */
  function probe(timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { settle(null); }, timeoutMs);
      function settle(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
      fetch(STATUS_URL, { headers: { accept: "application/json" } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) {
          // An answer that lands after the timeout is too late to judge the
          // form by, but its ticket is still good, and without one the relay
          // refuses the sign-up. Keep it either way.
          keepTicket(body);
          settle(body);
        })
        .catch(function () { settle(null); });
    });
  }

  probe(8000).then(function (live) {
    if (live) liveSeen = live;
    keepTicket(live);
    var kind = breakage(live);
    if (kind) withdraw(kind);
  });

  /* ----------------------------------------------------------- submit --- */

  var sending = false;

  /* What went wrong, in words a volunteer can act on. Every one of these ends
     in the same place, the admin inbox, because a sign-up that did not land is
     exactly what the organisers need to hear about. */
  var FAILED = {
    rejected: "The volunteer form didn’t accept this sign-up, so it wasn’t saved.",
    busy: "We’ve had a lot of sign-ups from your network in the last hour, so this one wasn’t sent. Try again later.",
    ticket: "This page couldn’t confirm the sign-up came from here. Reload the page and try again.",
    unavailable: "We couldn’t reach the sign-up service just now, so this sign-up wasn’t saved. Try again in a minute."
  };

  function showFailure(reason) {
    errors.hidden = false;
    errors.innerHTML = "<p>" + (FAILED[reason] || FAILED.unavailable) +
      " If it keeps happening, email <a href=\"mailto:admin@dcsketchfest.com?subject=Volunteering%20with%20DC%20Sketchfest\">admin@dcsketchfest.com</a> and we’ll add you by hand.</p>";
    errors.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* The answers as the relay wants them: entry.<id> -> [values]. Built from
     the form's own controls, so the markup stays the one record of what this
     page posts. Unticked boxes and the honeypot are left out, as a native
     post would leave them out. */
  function collect() {
    var fields = {};
    form.querySelectorAll("[name]").forEach(function (el) {
      var name = el.getAttribute("name") || "";
      if (!/^entry\./.test(name) || el.disabled) return;
      var type = String(el.type || "").toLowerCase();
      if ((type === "checkbox" || type === "radio") && !el.checked) return;
      (fields[name] = fields[name] || []).push(String(el.value || ""));
    });
    return fields;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); });
  }

  /* POST to the relay and resolve to its verdict: { ok } or { ok:false,
     reason }. Never rejects, so the caller always gets the button back. */
  function send() {
    /* No ticket yet: both status checks timed out. The relay will refuse a
       sign-up without one, so make one longer attempt before saying so. */
    if (!ticket) {
      return probe(15000).then(function (live) {
        keepTicket(live);
        return ticket ? send() : { ok: false, reason: "ticket" };
      });
    }
    var payload = JSON.stringify({ fields: collect(), ticket: ticket, website: form.website.value });
    return wait(TICKET_MIN_MS - (Date.now() - ticketAt)).then(function () {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = setTimeout(function () { if (controller) controller.abort(); }, 20000);
      return fetch(SIGNUP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: payload,
        signal: controller ? controller.signal : undefined
      })
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) {
            clearTimeout(timer);
            if (body && body.ok === true) return { ok: true };
            return { ok: false, reason: (body && body.reason) || "unavailable" };
          });
        })
        .catch(function () {
          clearTimeout(timer);
          return { ok: false, reason: "unavailable" };
        });
    });
  }

  form.addEventListener("submit", function (ev) {
    // Nothing goes to Google from the browser any more: the relay sends it.
    ev.preventDefault();
    if (blocked || sending) return;

    // A honeypot hit is dropped silently: bots get the same screen humans do.
    if (form.website.value) {
      finish();
      return;
    }

    if (showErrors(validate())) return;

    var label = submitBtn.querySelector("span");
    var wording = label.textContent;
    sending = true;
    submitBtn.disabled = true;
    label.textContent = "Checking…";

    function restore() {
      sending = false;
      submitBtn.disabled = false;
      label.textContent = wording;
    }

    /* The status check answered when the page loaded, which may have been an
       hour ago. Ask once more, briefly, since this is the one moment where
       being wrong costs a real sign-up. Fails open: no answer within four
       seconds and the sign-up goes ahead on the ticket from page load (or,
       if there is none, send() makes one longer attempt to get one), and
       the relay's own verdict is still the last word. */
    probe(4000).then(function (live) {
      if (live) liveSeen = live;
      keepTicket(live);
      var kind = breakage(live);
      if (kind) {
        // withdraw() hides the form, so the button is not restored.
        withdraw(kind);
        return null;
      }
      // The fresh answer may have marked another question required.
      if (showErrors(validate())) {
        restore();
        return null;
      }
      label.textContent = "Sending…";
      return send();
    })
      .then(function (verdict) {
        if (!verdict) return;
        if (verdict.ok) {
          finish();
          return;
        }
        if (verdict.reason === "closed") {
          withdraw("closed");
          return;
        }
        // A spent or missing ticket is replaced on the next try.
        if (verdict.reason === "ticket") ticket = null;
        restore();
        showFailure(verdict.reason);
      })
      .catch(function () {
        /* Nothing above is expected to throw, but a dead button with no way
           back is the worst outcome on this page. */
        restore();
        showFailure("unavailable");
      });
  });

  function finish() {
    form.hidden = true;
    done.hidden = false;
    done.innerHTML =
      "<h2 class=\"h-sm\">You’re signed up</h2>" +
      "<p>Thanks for volunteering with DC Sketchfest. We’ll be in touch about " +
      "pre-festival planning, and there will be another form in January for " +
      "during-festival volunteering.</p>" +
      "<a class=\"btn btn--yellow\" href=\"/\"><span>Back to the site</span></a>";
    done.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  clearBtn.addEventListener("click", function () {
    form.reset();
    syncOther();
    showErrors([]);
    document.getElementById("name").focus();
  });
})();
