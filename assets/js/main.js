/* DC Sketchfest — mobile nav, sliders, scroll reveals. No dependencies. */
(function () {
  "use strict";

  /* ---------------------------------------------------------- mobile nav */

  var toggle = document.querySelector(".nav-toggle");
  var links = document.getElementById("nav-links");

  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
    });

    // Close the menu after tapping a link so in-page anchors are visible.
    links.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------------------------------------------------------- fee window */

  /* Which row of the application fee table wears the "Open now" flag.

     The table ships all three flags with two hidden, and the served markup is
     a real answer on its own -- this only corrects it. The Worker is what
     actually prices an application, so the flag follows what /apply/fee says
     is open rather than the calendar written into the page. Before this the
     flag was hand-kept and it ran two days late: the table went on offering
     $25 after the $30 window had opened, which is a price nobody could be
     charged.

     Anything unexpected leaves the markup alone. A failed request, a response
     that is not ok, or a window this table does not list are all better served
     by a flag that might be stale than by a table with no flag at all. */

  var feeTable = document.querySelector("[data-fee-table]");

  if (feeTable) {
    fetch(
      /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
        ? "http://localhost:8789/api/apply/fee"
        : "https://dcsketchfest-app.walker-df2.workers.dev/api/apply/fee",
      { headers: { accept: "application/json" } }
    )
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (fee) {
        if (!fee || fee.ok !== true) return;

        // A grace application is charged the late fee, so late stays the row
        // to point at.
        var tier = fee.tier === "grace" ? "late" : fee.tier;
        var open = feeTable.querySelector('[data-fee-tier="' + tier + '"]');

        // Open, but in a window this table has no row for: say nothing rather
        // than flag the wrong one.
        if (fee.open === true && !open) return;
        if (fee.open !== true) open = null;

        feeTable.querySelectorAll(".fee-row").forEach(function (row) {
          var flag = row.querySelector(".fee-flag");
          var isOpen = row === open;
          row.classList.toggle("is-open", isOpen);
          if (flag) flag.hidden = !isOpen;
        });
      })
      .catch(function () {
        // Offline, blocked, or the Worker is down. The served markup stands.
      });
  }

  /* ------------------------------------------------------------- sliders */

  document.querySelectorAll("[data-slider]").forEach(function (slider) {
    var track = slider.querySelector(".slider-track");
    var prev = slider.querySelector("[data-slider-prev]");
    var next = slider.querySelector("[data-slider-next]");
    if (!track) return;

    function step() {
      var first = track.firstElementChild;
      if (!first) return track.clientWidth;
      var gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      return first.getBoundingClientRect().width + gap;
    }

    function sync() {
      if (!prev || !next) return;
      var max = track.scrollWidth - track.clientWidth - 1;
      prev.disabled = track.scrollLeft <= 1;
      next.disabled = track.scrollLeft >= max;
    }

    if (prev) prev.addEventListener("click", function () { track.scrollLeft -= step(); });
    if (next) next.addEventListener("click", function () { track.scrollLeft += step(); });

    track.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    sync();
  });

  /* --------------------------------------------------------- signup form */

  var signup = document.getElementById("signup-form");

  if (signup) {
    var status = signup.querySelector(".signup-status");
    var email = signup.querySelector("#signup-email");
    var submit = signup.querySelector(".signup-submit");
    var MAILTO = "mailto:admin@dcsketchfest.com?subject=Add%20me%20to%20the%20DCSF%20list";

    function say(message, isError) {
      status.innerHTML = message;
      status.classList.toggle("is-error", !!isError);
    }

    signup.addEventListener("submit", function (event) {
      event.preventDefault();

      var endpoint = signup.getAttribute("data-endpoint");
      var address = email.value.trim();

      // Deliberately loose: the server is the real validator, and clever
      // regexes reject more valid addresses than they catch bad ones.
      if (!address || address.indexOf("@") < 1 || address.lastIndexOf(".") < address.indexOf("@")) {
        email.setAttribute("aria-invalid", "true");
        email.focus();
        say("That email doesn't look right — mind checking it?", true);
        return;
      }
      email.removeAttribute("aria-invalid");

      // Silently accept honeypot submissions so bots don't learn to adapt.
      if (signup.querySelector("#signup-company").value) {
        say("Thanks! You're on the list.");
        signup.reset();
        return;
      }

      if (!endpoint) {
        say('Signup isn\'t wired up yet — email <a href="' + MAILTO + '">admin@dcsketchfest.com</a> and we\'ll add you.', true);
        return;
      }

      submit.setAttribute("disabled", "disabled");
      say("Adding you…");

      // text/plain keeps this a "simple" request, so the browser skips the
      // CORS preflight that Apps Script web apps do not answer.
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          name: signup.querySelector("#signup-name").value.trim(),
          email: address,
          source: location.pathname
        })
      })
        .then(function (res) { return res.json().catch(function () { return { ok: res.ok }; }); })
        .then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || "rejected");
          say("You're on the list! We'll email you when 2027 dates drop.");
          signup.reset();
        })
        .catch(function () {
          say('Something went wrong — email <a href="' + MAILTO + '">admin@dcsketchfest.com</a> and we\'ll add you.', true);
        })
        .then(function () { submit.removeAttribute("disabled"); });
    });
  }

  /* ------------------------------------------------------ scroll reveals */

  var revealables = document.querySelectorAll(".reveal");

  if (!("IntersectionObserver" in window)) {
    revealables.forEach(function (el) { el.classList.add("is-visible"); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.1 });

  revealables.forEach(function (el) { observer.observe(el); });
})();
