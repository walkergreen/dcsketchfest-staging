/* Volunteer sign-up form.
 *
 * The form posts natively to the Google Form's formResponse endpoint through a
 * hidden iframe, so Google itself writes the response row into the linked
 * sheet. That endpoint sends no CORS headers, so the response body is
 * unreadable by design; the iframe's load event is the only completion signal
 * available, and it cannot distinguish a stored response from a rejected one.
 * Validation therefore happens here, before the POST goes out.
 *
 * Because success is unreadable, this page used to thank every visitor
 * unconditionally -- including when the form was closed or had been edited out
 * from under it, which Google answers 200 and discards. It cannot learn the
 * fate of a response it has already sent, so instead it asks the Worker what
 * the form currently accepts BEFORE anyone fills it in, and withdraws the form
 * when the answer proves a sign-up would be thrown away.
 *
 * It withdraws only on proof. A probe that fails, or cannot tell, leaves the
 * form exactly as it was: the failure this guards against is silent data loss,
 * and refusing sign-ups because Google reshaped a page would be worse.
 */
(function () {
  "use strict";

  var form = document.getElementById("volunteer-form");
  if (!form) return;

  var errors = document.getElementById("errors");
  var done = document.getElementById("done");
  var sink = document.getElementById("gform-sink");
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

  var STATUS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "http://localhost:8789/api/volunteer/form"
    : "https://dcsketchfest-app.walker-df2.workers.dev/api/volunteer/form";

  /* The "Other" checkbox carries no name until it is ticked. An unticked box
     is never submitted, but a ticked one must send __other_option__ alongside
     the free-text answer or Google drops both. */
  function syncOther() {
    var on = otherBox.checked;
    otherWrap.hidden = !on;
    otherBox.name = on ? "entry.2141830555" : "";
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
    for (var r = 0; r < req.length; r++) {
      // sent[id] is [] for a text field the page does post, which is truthy,
      // so this fires only where the page has no control for the question.
      if (!sent[req[r]]) return "drifted";
    }

    return null;
  }

  var blocked = false;

  function withdraw(kind) {
    blocked = true;
    form.hidden = true;
    if (errors) errors.hidden = true;
    done.hidden = false;
    done.innerHTML =
      "<h2 class=\"h-sm\">Volunteer sign-ups are paused</h2>" +
      "<p>" + (kind === "closed"
        ? "The volunteer form is closed at the moment, so this page can’t record a sign-up."
        : "This page and the volunteer form have fallen out of step, so a sign-up made here wouldn’t reach us.") +
      " Email us instead and we’ll add you by hand — and we’d like to know this page is broken, so please do.</p>" +
      "<a class=\"btn btn--yellow\" href=\"mailto:admin@dcsketchfest.com?subject=Volunteering%20with%20DC%20Sketchfest\">" +
      "<span>Email admin@dcsketchfest.com</span></a>";
    done.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  fetch(STATUS_URL, { headers: { accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (live) {
      var kind = breakage(live);
      if (kind) withdraw(kind);
    })
    .catch(function () { /* can't tell, so the form stands */ });

  /* ----------------------------------------------------------- submit --- */

  var submitted = false;

  form.addEventListener("submit", function (ev) {
    // The probe can land after someone has already started typing, so this is
    // checked here as well as at withdrawal.
    if (blocked) {
      ev.preventDefault();
      return;
    }

    // A honeypot hit is dropped silently: bots get the same screen humans do.
    if (form.website.value) {
      ev.preventDefault();
      finish();
      return;
    }

    if (showErrors(validate())) {
      ev.preventDefault();
      return;
    }

    submitted = true;
    submitBtn.disabled = true;
    submitBtn.querySelector("span").textContent = "Sending…";
    // The native POST proceeds into the hidden iframe from here.
  });

  sink.addEventListener("load", function () {
    // `blocked` means the probe proved this sign-up would be discarded. The
    // withdrawal notice is the honest outcome, so completing the POST must not
    // replace it with a thank-you -- the row is gone either way.
    if (submitted && !blocked) finish();
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
