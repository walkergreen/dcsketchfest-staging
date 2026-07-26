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
