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

  /* The last answer the Worker gave, so validation can enforce questions the
     form marks required. Null until the first probe lands, which keeps every
     check fail-open before then. */
  var liveSeen = null;

  var STATUS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? "http://localhost:8789/api/volunteer/form"
    : "https://dcsketchfest-app.walker-df2.workers.dev/api/volunteer/form";

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
    for (var r = 0; r < req.length; r++) {
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
        .then(settle)
        .catch(function () { settle(null); });
    });
  }

  probe(8000).then(function (live) {
    if (live) liveSeen = live;
    var kind = breakage(live);
    if (kind) withdraw(kind);
  });

  /* ----------------------------------------------------------- submit --- */

  var submitted = false;
  var revalidated = false;

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

    if (!revalidated) {
      /* The probe answered when the page loaded, which may have been an hour
         ago. The form being closed or edited since then is invisible to that
         answer, and this is the one moment where being wrong costs a real
         sign-up. So ask once more, briefly.

         Fails open on purpose: if the check cannot answer within four seconds
         the sign-up goes out exactly as it would have. Waiting longer would
         trade a certain cost, visitors giving up on a stuck button, against an
         unlikely one. */
      ev.preventDefault();
      var label = submitBtn.querySelector("span");
      var wording = label.textContent;
      submitBtn.disabled = true;
      label.textContent = "Checking…";
      probe(4000).then(function (live) {
        if (live) liveSeen = live;
        var kind = breakage(live);
        if (kind) {
          // withdraw() hides the form, so the button is not restored.
          withdraw(kind);
          return;
        }
        submitBtn.disabled = false;
        label.textContent = wording;
        // The fresh answer may have marked another question required.
        if (showErrors(validate())) return;
        revalidated = true;
        if (typeof form.requestSubmit === "function") {
          // Re-fires this handler, which now takes the branch below.
          form.requestSubmit();
        } else {
          /* NOT form.submit(). HTMLFormElement exposes every listed element by
             its id as a named property, and [LegacyOverrideBuiltIns] makes that
             own property shadow the prototype method -- so with
             <button type="submit" id="submit"> in the markup, `form.submit` IS
             that button and calling it throws. The same named getter is what
             makes `form.website` work for the honeypot above, so this form
             definitely has it. Reaching past the shadow is the one-line fix.

             This path also skips the submit event, so it does its own
             bookkeeping. */
          submitted = true;
          submitBtn.disabled = true;
          label.textContent = "Sending…";
          HTMLFormElement.prototype.submit.call(form);
        }
      })
      .catch(function () {
        /* Nothing in the chain above is expected to throw, but a dead button
           with no way back is the worst outcome on this page: the visitor has
           filled the form and has no thank-you, no error and no retry. Hand
           them a working button instead and let the next click try again. */
        submitBtn.disabled = false;
        label.textContent = wording;
      });
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
