/* ==========================================================================
   DC Sketchfest — application form
   Replaces the Airtable form. Answers live in localStorage from the first
   keystroke, so nothing is lost to a closed tab; a server-side draft is created
   the moment the applicant does something that needs one (uploads a photo,
   asks to finish later, or submits) and from then on autosaves. The resume link
   is what carries a draft between devices.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------- config --- */

  /* Everything festival-specific lives here. A new year is an edit to this
     block, plus the matching `application_*` settings in the judge's app. */
  var CONFIG = {
    /* The judge's app Worker (Projects/dcsketchfest-judges-app) — the same
       backend that runs judging, so an application becomes a team the moment
       it's submitted. `wrangler dev` is picked up automatically when this page
       is served from localhost, so one file works in both places. */
    api: /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
      ? 'http://localhost:8789/api/apply'
      : 'https://dcsketchfest-app.greenroom.workers.dev/api/apply',

    year: '2026',
    edition: '3rd',
    dates_line: 'March 25–28 at The DC Arts Center',
    deadline_regular: 'Regular Application ($25) – Friday, October 31, 11:59 PM ET.',
    deadline_late: 'Late Application ($40) – Sunday, November 23, 11:59 PM ET.',
    notification: 'All applicants will be contacted mid-January 2026.',

    /* Only used for the "you already applied but still owe the fee" case; the
       submit flow uses whatever PAYMENT_URL the Worker is configured with. */
    payment_url: 'https://crowdwork.com/e/dc-sketchfest-2026-application-fee',

    dates: [
      'Wednesday, March 25, 2026',
      'Thursday, March 26, 2026',
      'Friday, March 27, 2026',
      'Saturday, March 28, 2026'
    ]
  };

  /* Field names, mirroring APPLICATION_FIELDS in the judge's app Worker
     (src/index.js). `list` fields are checkbox groups; `bool` is the fee
     agreement. Add a question in both places or the answer is dropped. */
  var FIELDS = [
    { name: 'team_name', label: 'Team or Performer Name', required: true },
    { name: 'bio', label: 'Team or Performer Bio', required: true },
    { name: 'team_size', label: 'Team Size', required: true },
    { name: 'home', label: 'Home Theater / Home Town', required: true },
    { name: 'instagram', label: 'Instagram' },
    { name: 'contact_first', label: 'Point of Contact First Name', required: true },
    { name: 'contact_last', label: 'Point of Contact Last Name', required: true },
    { name: 'contact_email', label: 'Point of Contact Email', required: true },
    { name: 'contact_phone', label: 'Point of Contact Phone', required: true },
    { name: 'tape', label: 'Performance Tape', required: true },
    { name: 'show_description', label: 'Show Description', required: true },
    { name: 'dates', label: 'Show dates you are available', required: true, type: 'list' },
    { name: 'representation', label: 'Representation', type: 'list' },
    { name: 'representation_other', label: 'Representation (other)' },
    { name: 'stage_reqs', label: 'Stage requirements' },
    { name: 'tech_reqs', label: 'Tech requirements' },
    { name: 'accessibility', label: 'Accessibility requirements' },
    { name: 'anything_else', label: 'Anything else we should know' },
    { name: 'agree', label: 'Application fee agreement', required: true, type: 'bool' }
  ];

  var LS_DATA = 'dcsf.apply.data';
  var LS_KEYS = 'dcsf.apply.keys';
  var MAX_EDGE = 1600;          // longest side we keep when downscaling a photo
  var TARGET_BYTES = 800 * 1024; // small enough to survive without R2

  /* ------------------------------------------------------------ dom --- */

  var form = document.getElementById('form');
  if (!form) return;

  var $ = function (id) { return document.getElementById(id); };
  var saveBar = $('save-bar');
  var saveStatus = $('save-status');
  var errorBox = $('errors');
  var done = $('done');

  var state = { id: null, token: null, photo: null, dirty: false, saving: false, submitted: false };
  var saveTimer = null;

  /* ---------------------------------------------------------- helpers --- */

  function api(path) { return CONFIG.api.replace(/\/$/, '') + path; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function setStatus(text, stateName) {
    if (!saveStatus) return;
    saveStatus.textContent = text;
    saveStatus.setAttribute('data-state', stateName || '');
  }

  function readLocal(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function writeLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  /* ---------------------------------------------------- render config --- */

  Object.keys(CONFIG).forEach(function (key) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-cfg="' + key + '"]'), function (el) {
      if (typeof CONFIG[key] === 'string') el.textContent = CONFIG[key];
    });
  });
  document.title = 'Apply to Perform - DC Sketchfest';

  var dateChecks = $('dates-checks');
  dateChecks.innerHTML = CONFIG.dates.map(function (d) {
    return '<label class="check"><input type="checkbox" name="dates" value="' + esc(d) + '"><span>' + esc(d) + '</span></label>';
  }).join('');

  /* ------------------------------------------------- form <-> object --- */

  function collect() {
    var data = {};
    FIELDS.forEach(function (f) {
      if (f.type === 'list') {
        data[f.name] = Array.prototype.map.call(
          form.querySelectorAll('input[name="' + f.name + '"]:checked'),
          function (el) { return el.value; }
        );
      } else if (f.type === 'bool') {
        var box = form.elements[f.name];
        data[f.name] = Boolean(box && box.checked);
      } else {
        var el = form.elements[f.name];
        data[f.name] = el ? el.value : '';
      }
    });
    return data;
  }

  function fill(data) {
    if (!data) return;
    FIELDS.forEach(function (f) {
      var value = data[f.name];
      if (f.type === 'list') {
        var chosen = Array.isArray(value) ? value : [];
        Array.prototype.forEach.call(form.querySelectorAll('input[name="' + f.name + '"]'), function (el) {
          el.checked = chosen.indexOf(el.value) !== -1;
        });
      } else if (f.type === 'bool') {
        var box = form.elements[f.name];
        if (box) box.checked = Boolean(value);
      } else {
        var el = form.elements[f.name];
        if (el && typeof value === 'string') el.value = value;
      }
    });
    syncRepOther();
  }

  /* --------------------------------------------------------- autosave --- */

  function touch() {
    state.dirty = true;
    writeLocal(LS_DATA, collect());
    if (state.id) {
      setStatus('Saving…', 'saving');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(pushDraft, 1200);
    } else {
      setStatus('Saved on this device', 'saved');
    }
  }

  /* Create the server-side draft on first need, then keep it in sync.
     Callers that need an id (the photo upload, submit) await this, so
     concurrent calls share the one in-flight request rather than racing to
     create two rows — or worse, reading state.id before it exists. */
  function pushDraft() {
    if (state.submitted) return Promise.resolve(state);
    if (state.saving) return state.savePromise;
    state.saving = true;
    setStatus('Saving…', 'saving');

    var sent = JSON.stringify(collect());

    state.savePromise = fetch(api('/draft'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.id, token: state.token, data: JSON.parse(sent) })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('save failed (' + r.status + ')');
        return r.json();
      })
      .then(function (d) {
        state.id = d.id;
        state.token = d.token;
        // Anything typed while the request was in flight didn't make this trip.
        state.dirty = JSON.stringify(collect()) !== sent;
        writeLocal(LS_KEYS, { id: d.id, token: d.token });
        setStatus('Saved — you can finish later', 'saved');
        return state;
      })
      .catch(function (err) {
        setStatus('Couldn’t reach the server — saved on this device only', 'error');
        throw err;
      })
      .then(
        function (v) { state.saving = false; flushIfDirty(); return v; },
        function (e) { state.saving = false; throw e; }
      );

    return state.savePromise;
  }

  /* Edits made while a save was in flight went out with the old payload, so
     send one more round. */
  function flushIfDirty() {
    if (state.dirty && state.id && !state.submitted) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(pushDraft, 400);
    }
  }

  /* --------------------------------------------------------- the photo --- */

  var dropzone = $('dropzone');
  var photoInput = $('photo');
  var preview = $('photo-preview');
  var dropText = $('dropzone-text');
  var removeBtn = $('photo-remove');

  function showPhoto(name, src) {
    state.photo = { name: name };
    if (src) { preview.src = src; preview.hidden = false; }
    dropText.innerHTML = esc(name) + ' — <span class="link">choose a different photo</span>';
    removeBtn.hidden = false;
  }

  function clearPhoto() {
    state.photo = null;
    preview.hidden = true;
    preview.removeAttribute('src');
    photoInput.value = '';
    dropText.innerHTML = 'Drop a photo here or <span class="link">click to browse</span>';
    removeBtn.hidden = true;
  }

  /* Shrink in the browser: keeps uploads fast on venue wifi and keeps the
     stored image small enough to live in D1 while R2 is off. */
  function downscale(file) {
    if (!window.createImageBitmap || !window.HTMLCanvasElement) return Promise.resolve(file);

    return createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && file.size <= TARGET_BYTES && file.type === 'image/jpeg') return file;

      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close && bitmap.close();

      return new Promise(function (resolve) {
        var attempt = function (quality) {
          canvas.toBlob(function (blob) {
            if (!blob) return resolve(file);
            if (blob.size <= TARGET_BYTES || quality <= 0.5) return resolve(blob);
            attempt(quality - 0.15);
          }, 'image/jpeg', quality);
        };
        attempt(0.85);
      });
    }).catch(function () {
      // HEIC and other formats the browser can't decode: send the original and
      // let the Worker's size limit be the judge.
      return file;
    });
  }

  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setStatus('That file isn’t an image', 'error');
      return;
    }

    var localUrl = URL.createObjectURL(file);
    showPhoto(file.name, localUrl);
    setStatus('Uploading photo…', 'saving');

    // The upload needs somewhere to go, so this is one of the moments a
    // server-side draft gets created.
    pushDraft()
      .then(function () { return downscale(file); })
      .then(function (blob) {
        var name = file.name.replace(/\.(heic|heif|png|webp)$/i, '.jpg');
        return fetch(api('/upload?id=' + encodeURIComponent(state.id) + '&token=' + encodeURIComponent(state.token)), {
          method: 'POST',
          headers: { 'Content-Type': blob.type || file.type, 'X-Filename': name },
          body: blob
        });
      })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || r.status); });
        return r.json();
      })
      .then(function (d) {
        showPhoto(d.name, localUrl);
        setStatus('Photo uploaded — saved', 'saved');
      })
      .catch(function (err) {
        var why = String(err.message) === 'too_large' || String(err.message) === 'too_large_no_r2'
          ? 'that photo is too big — try one under 10 MB'
          : 'the upload didn’t go through — check your connection and try again';
        setStatus('Photo not saved: ' + why, 'error');
        clearPhoto();
      });
  }

  photoInput.addEventListener('change', function () { handleFile(photoInput.files[0]); });
  removeBtn.addEventListener('click', clearPhoto);

  ['dragenter', 'dragover'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove('is-over'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });

  /* ------------------------------------------------------- validation --- */

  function fieldError(name, message) {
    var el = form.elements[name];
    var target = el && el.length ? el[0] : el;
    if (!target) return;
    var container = target.closest('.field') || target.closest('.checkgroup');
    if (!container) return;
    if (target.type !== 'checkbox') target.setAttribute('aria-invalid', 'true');
    var note = document.createElement('p');
    note.className = 'field-error';
    note.textContent = message;
    container.appendChild(note);
  }

  function clearErrors() {
    Array.prototype.forEach.call(form.querySelectorAll('.field-error'), function (el) { el.remove(); });
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) {
      el.removeAttribute('aria-invalid');
    });
    errorBox.hidden = true;
    errorBox.innerHTML = '';
  }

  function validate(data) {
    var problems = [];

    FIELDS.forEach(function (f) {
      if (!f.required) return;
      var v = data[f.name];
      var empty = f.type === 'list' ? !v.length : f.type === 'bool' ? !v : !String(v || '').trim();
      if (empty) {
        problems.push({ name: f.name, message: f.type === 'bool'
          ? 'Please confirm you’ll pay the application fee.'
          : 'This one’s required.' });
      }
    });

    var already = function (n) { return problems.some(function (p) { return p.name === n; }); };

    if (!already('contact_email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contact_email)) {
      problems.push({ name: 'contact_email', message: 'That doesn’t look like an email address.' });
    }
    if (!already('team_size') && !(parseInt(data.team_size, 10) >= 1)) {
      problems.push({ name: 'team_size', message: 'Enter the number of badges you need.' });
    }
    if (!already('tape') && !/^https?:\/\/\S+\.\S+/.test(String(data.tape).trim())) {
      problems.push({ name: 'tape', message: 'Paste a full link, starting with https://' });
    }
    if (!state.photo) {
      problems.push({ name: 'photo', message: 'Please add a group photo or headshot.' });
    }

    // Report in the order the questions appear, so the summary list reads as a
    // route down the page rather than the order the checks happened to run.
    var order = FIELDS.map(function (f) { return f.name; });
    order.splice(order.indexOf('contact_first'), 0, 'photo');
    return problems.sort(function (a, b) { return order.indexOf(a.name) - order.indexOf(b.name); });
  }

  function label(name) {
    if (name === 'photo') return 'Group Photo or Headshot';
    var f = FIELDS.filter(function (x) { return x.name === name; })[0];
    return f ? f.label : name;
  }

  /* ----------------------------------------------------------- submit --- */

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();

    if (form.elements.website && form.elements.website.value) return; // honeypot

    var data = collect();
    var problems = validate(data);

    if (problems.length) {
      problems.forEach(function (p) { fieldError(p.name, p.message); });
      errorBox.hidden = false;
      errorBox.innerHTML = 'Almost there — a few things still need filling in:<ul>' +
        problems.map(function (p) { return '<li>' + esc(label(p.name)) + '</li>'; }).join('') + '</ul>';
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    var button = $('submit');
    button.disabled = true;
    button.querySelector('span').textContent = 'Submitting…';

    pushDraft()
      .then(function () {
        return fetch(api('/submit'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.id, token: state.token })
        });
      })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'submit_failed');
        state.submitted = true;
        try { localStorage.removeItem(LS_DATA); localStorage.removeItem(LS_KEYS); } catch (err) {}
        showSubmitted(res.body, data);
      })
      .catch(function (err) {
        button.disabled = false;
        button.querySelector('span').textContent = 'Submit and pay';
        errorBox.hidden = false;
        errorBox.textContent = String(err.message) === 'incomplete'
          ? 'Some required answers are still missing — scroll up and check the highlighted questions.'
          : 'We couldn’t submit your application just now. Your answers are saved — please try again in a moment, or email admin@dcsketchfest.com.';
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
  });

  function showSubmitted(body, data) {
    form.hidden = true;
    if (saveBar) saveBar.hidden = true;
    done.hidden = false;
    done.innerHTML =
      '<h2 class="h-md">Application received</h2>' +
      '<p><strong>You’re not done yet.</strong> Your application is incomplete until you pay the application fee.</p>' +
      '<p><a class="btn btn--purple" href="' + esc(body.payUrl) + '"><span>Pay the application fee</span></a></p>' +
      '<p>All sales are final and non-refundable. Payment does not guarantee entry. ' + esc(CONFIG.notification) + '</p>' +
      '<p>Your reference is <span class="ref">' + esc(state.id) + '</span>. ' +
      (body.emailed
        ? 'A copy of your answers is on its way to ' + esc(data.contact_email) + '.'
        : 'Please save this reference — quote it if you email us about your application.') +
      '</p>';
    done.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (window.gtag) gtag('event', 'application_submitted');
  }

  /* --------------------------------------------------- save for later --- */

  var sheet = document.createElement('dialog');
  sheet.className = 'sheet';
  document.body.appendChild(sheet);

  $('save-later').addEventListener('click', function () {
    var email = (form.elements.contact_email.value || '').trim();
    sheet.innerHTML = '<h2 class="h-sm">Saving…</h2><p>One moment.</p>';
    if (typeof sheet.showModal === 'function') sheet.showModal();

    pushDraft()
      .then(function () {
        var link = location.origin + location.pathname +
          '?id=' + encodeURIComponent(state.id) + '&t=' + encodeURIComponent(state.token);

        sheet.innerHTML =
          '<h2 class="h-sm">Saved</h2>' +
          '<p>Come back to this link any time to pick up where you left off. It’s the only way back into your draft from a different device or browser — keep it somewhere safe.</p>' +
          '<div class="resume-link"><input type="text" readonly value="' + esc(link) + '" id="resume-input">' +
          '<button type="button" id="copy-link">Copy</button></div>' +
          (email ? '<p id="mail-note">We can email it to <strong>' + esc(email) + '</strong>.</p>' : '') +
          '<p style="font-size:.9rem;opacity:.75">Your application is not submitted until you finish the form and pay the fee.</p>' +
          '<div class="form-actions">' +
          (email ? '<button type="button" class="text-btn" id="email-link">Email me the link</button>' : '') +
          '<button type="button" class="btn btn--yellow" id="close-sheet"><span>Back to the form</span></button></div>';

        $('copy-link').addEventListener('click', function () {
          var input = $('resume-input');
          input.select();
          var copy = navigator.clipboard
            ? navigator.clipboard.writeText(input.value)
            : Promise.reject();
          copy.then(function () { $('copy-link').textContent = 'Copied'; })
              .catch(function () { document.execCommand('copy'); $('copy-link').textContent = 'Copied'; });
        });

        if (email) {
          $('email-link').addEventListener('click', function () {
            var btn = $('email-link');
            btn.disabled = true;
            btn.textContent = 'Sending…';
            fetch(api('/email-link'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: state.id, token: state.token, email: email })
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                $('mail-note').innerHTML = d.emailed
                  ? 'Sent to <strong>' + esc(email) + '</strong>. Check your spam folder if it doesn’t arrive.'
                  : 'We couldn’t send that email — please copy the link above instead.';
                btn.remove();
              })
              .catch(function () {
                btn.disabled = false;
                btn.textContent = 'Try again';
              });
          });
        }

        $('close-sheet').addEventListener('click', function () { sheet.close(); });
      })
      .catch(function () {
        sheet.innerHTML =
          '<h2 class="h-sm">Couldn’t save</h2>' +
          '<p>We couldn’t reach the server. Your answers are still stored in this browser, so they’ll be here when you come back on this device — but we can’t make you a resume link right now. Please try again in a minute.</p>' +
          '<div class="form-actions"><button type="button" class="btn btn--yellow" id="close-sheet"><span>Close</span></button></div>';
        $('close-sheet').addEventListener('click', function () { sheet.close(); });
      });
  });

  /* ------------------------------------------------------------ misc --- */

  var repOther = $('rep-other');
  function syncRepOther() { $('rep-other-field').hidden = !repOther.checked; }
  repOther.addEventListener('change', syncRepOther);

  $('clear').addEventListener('click', function () {
    if (!confirm('Clear every answer and start over? Your saved draft on this device will be erased.')) return;
    form.reset();
    clearPhoto();
    clearErrors();
    syncRepOther();
    try { localStorage.removeItem(LS_DATA); localStorage.removeItem(LS_KEYS); } catch (e) {}
    state.id = null;
    state.token = null;
    setStatus('Not saved yet', '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  form.addEventListener('input', touch);
  form.addEventListener('change', touch);

  window.addEventListener('beforeunload', function (e) {
    if (state.dirty && state.id && !state.submitted) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------------------------------------------------------- startup --- */

  function boot() {
    saveBar.hidden = false;
    setStatus('Not saved yet', '');

    var params = new URLSearchParams(location.search);
    var keys = params.get('id') && params.get('t')
      ? { id: params.get('id'), token: params.get('t') }
      : readLocal(LS_KEYS);

    // Answers typed on this device come back instantly, before any network.
    fill(readLocal(LS_DATA));

    if (!keys) return;

    fetch(api('/draft?id=' + encodeURIComponent(keys.id) + '&token=' + encodeURIComponent(keys.token)))
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        state.id = d.id;
        state.token = keys.token;

        if (d.status === 'submitted') {
          // Deliberately don't remember a finished application: otherwise a
          // later visit to /apply/ on this browser would show this panel
          // instead of a blank form, and a second team couldn't apply.
          try { localStorage.removeItem(LS_DATA); localStorage.removeItem(LS_KEYS); } catch (err) {}
          state.submitted = true;
          form.hidden = true;
          saveBar.hidden = true;
          done.hidden = false;
          done.innerHTML =
            '<h2 class="h-md">This application is already in</h2>' +
            '<p>We received it on ' + esc(new Date(d.submitted_at).toLocaleDateString()) + '. ' +
            'Your reference is <span class="ref">' + esc(d.id) + '</span>.</p>' +
            '<p>If you still need to pay the application fee, you can do that here.</p>' +
            '<p><a class="btn btn--purple" href="' + esc(CONFIG.payment_url) + '"><span>Pay the application fee</span></a></p>' +
            '<p>Something wrong? Email <a href="mailto:admin@dcsketchfest.com">admin@dcsketchfest.com</a> and quote your reference.</p>' +
            '<p><a href="' + esc(location.pathname) + '">Apply with a different team</a></p>';
          return;
        }

        writeLocal(LS_KEYS, keys);
        fill(d.data);
        writeLocal(LS_DATA, d.data);
        if (d.photo) {
          showPhoto(d.photo.name, api('/photo?id=' + encodeURIComponent(d.id) + '&token=' + encodeURIComponent(keys.token)));
        }
        setStatus('Picked up where you left off', 'saved');
      })
      .catch(function () {
        // A bad or expired link shouldn't block a fresh application.
        if (params.get('id')) setStatus('That save link didn’t work — starting a new application', 'error');
      });
  }

  boot();
})();
