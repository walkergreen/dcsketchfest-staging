/* Volunteer sign-up form.
 *
 * The form posts natively to the Google Form's formResponse endpoint through a
 * hidden iframe, so Google itself writes the response row into the linked
 * sheet. That endpoint sends no CORS headers, so the response body is
 * unreadable by design; the iframe's load event is the only completion signal
 * available, and it cannot distinguish a stored response from a rejected one.
 * Validation therefore happens here, before the POST goes out.
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

  var submitted = false;

  form.addEventListener("submit", function (ev) {
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
    if (submitted) finish();
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
