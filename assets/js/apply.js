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
      : 'https://dcsketchfest-app.walker-df2.workers.dev/api/apply',

    year: '2027',
    edition: '4th',
    dates_line: 'March 31–April 3, 2027 — venue to be announced',
    location: 'All shows are in Washington, DC. Venue to be announced.',

    /* Three fee windows this year rather than two fixed deadlines, so the
       page renders this list instead of one line per tier. The Worker's /fee
       endpoint is what actually sets the fee — these have to agree with it.

       These are the BASE fee per window. Tax and the service fee are added on
       top by the Worker, and /fee only reports the window that is open now, so
       the other two windows cannot be totalled here — renderFee() annotates
       this list with the real total instead of restating it per line. */
    deadlines: [
      'Early Application ($25) – October 20 to November 1.',
      'Standard Application ($30) – November 1 to November 29.',
      'Late Application ($40) – November 30 to December 13.'
    ],
    deadline_close: 'Applications close December 13, 11:59 PM ET.',

    /* Read by someone who has already applied, so it is in the second person.
       Editing stops when applications close, which is the same December 13 as
       the line above — the Worker is what enforces it, these two only explain
       it, so all three move together. */
    edit_window: 'You can change your answers until applications close on December 13.',
    edit_closed: 'December 13 has passed, so a change may no longer be saved.',

    notification: 'All applicants will be contacted mid-January 2027.',

    /* Stored verbatim as the applicant's availability and read straight by the
       schedule builder, so the weekday must match the date. 2027 runs Wed–Sat,
       March 31 to April 3. */
    dates: [
      'Wednesday, March 31, 2027',
      'Thursday, April 1, 2027',
      'Friday, April 2, 2027',
      'Saturday, April 3, 2027'
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
    { name: 'tech_level', label: 'Tech requirements of your show', required: true },
    { name: 'stage_reqs', label: 'Stage requirements' },
    { name: 'tech_reqs', label: 'Tech requirements' },
    { name: 'accessibility', label: 'Accessibility requirements' },
    { name: 'representation', label: 'Representation', type: 'list' },
    { name: 'representation_other', label: 'Representation (other)' },
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

  /* `submitted` means this application is in. `editing` means we are looking
     at one that is in and the applicant is changing it, which is a different
     screen and a different kind of save. `paid` stays null until the server has
     been asked, because "we don't know yet" must not be shown as either
     answer. */
  var state = {
    id: null, token: null, photo: null, serverPhoto: null,
    dirty: false, saving: false, submitted: false,
    editing: false, paid: null, submittedAt: null, editedAt: null,
    editable: true, editNotice: '', savedAt: null, saveRefused: false
  };
  var saveTimer = null;

  /* ---------------------------------------------------------- helpers --- */

  function api(path) { return CONFIG.api.replace(/\/$/, '') + path; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* `.save-bar` sets its own `display`, which beats the hidden attribute, so
     the bar needs a style to actually leave the page. It has to leave: once the
     form is swapped for a panel there is nothing left to save, and the
     email-my-link button has no business sitting over a confirmation. */
  function hideSaveBar() {
    if (!saveBar) return;
    saveBar.hidden = true;
    saveBar.style.display = 'none';
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

  /* The link back into this application from any device. It is a bearer
     credential for the whole application, which is why it is only ever shown
     to someone already holding it and only ever mailed to the address the
     application itself carries. */
  function resumeUrl() {
    return location.origin + location.pathname +
      '?id=' + encodeURIComponent(state.id) + '&t=' + encodeURIComponent(state.token);
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString();
  }

  /* An edit gets the time as well as the day: two corrections on the same
     afternoon are otherwise indistinguishable. */
  function fmtDateTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  /* ---------------------------------------------------- render config --- */

  Object.keys(CONFIG).forEach(function (key) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-cfg="' + key + '"]'), function (el) {
      if (typeof CONFIG[key] === 'string') el.textContent = CONFIG[key];
    });
  });
  document.title = 'Apply to Perform - DC Sketchfest ' + CONFIG.year;

  /* The page ships this same copy as static markup so a JS failure still
     shows the deadlines; the two have to be edited together. */
  $('deadlines').innerHTML = CONFIG.deadlines.map(function (d) {
    return '<p>' + esc(d) + '</p>';
  }).join('') + '<p><strong>' + esc(CONFIG.deadline_close) + '</strong></p>';

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

    /* An edit to a submitted application is deliberately not autosaved, and
       deliberately not kept in localStorage either. Every server-side save of a
       paid application raises an email to the organisers naming the fields that
       changed, so a save per keystroke would mail them thirty half-typed
       answers; and this browser's draft slot belongs to whoever opens /apply/
       next, who must not inherit another team's answers. The unload warning is
       what guards an edit against a closed tab. */
    if (state.editing) {
      setStatus(state.saveRefused
        ? 'This application can’t be changed — see the message by the button'
        : 'Unsaved change — press Save changes', state.saveRefused ? 'error' : '');
      return;
    }

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
    if (state.submitted && !state.editing) return Promise.resolve(state);
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
        /* Carry the status and the Worker's own sentence: an edit refused
           because applications have closed needs a different answer from a save
           that merely failed. */
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            var err = new Error(d.error || 'save failed (' + r.status + ')');
            err.status = r.status;
            err.editsClosed = !!d.edits_closed;
            /* A 404 here almost always means the token was rotated by a
               recovery email, not that the application vanished: this tab is
               holding a link that has since been replaced. Saying "we could
               not find it" would read as lost work. */
            err.linkReplaced = r.status === 404 && !!state.id;
            throw err;
          });
        }
        return r.json();
      })
      .then(function (d) {
        state.id = d.id;
        state.token = d.token;
        /* `edited_at` is the Worker's stamp for when the ANSWERS last moved,
           which is not `updated_at` — a save that changed nothing leaves it
           where it was, and that is the honest thing to show. */
        state.savedAt = d.edited_at || null;
        state.editedAt = d.edited_at || state.editedAt;
        // Anything typed while the request was in flight didn't make this trip.
        state.dirty = JSON.stringify(collect()) !== sent;
        // See touch(): a submitted application is never left on this device.
        if (!state.editing) writeLocal(LS_KEYS, { id: d.id, token: d.token });
        setStatus(state.editing ? 'Change saved' : 'Saved — you can finish later', 'saved');
        return state;
      })
      .catch(function (err) {
        setStatus(state.editing
          ? 'Couldn’t save that change — your answers are still on this screen'
          : 'Couldn’t reach the server — saved on this device only', 'error');
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

  /* Somewhere for an upload to go. A draft gets an application created on the
     spot; an edit already has one, and must not have the form's half-typed
     state pushed up as a side effect of adding a photo. */
  function ensureDraft() {
    return state.id ? Promise.resolve(state) : pushDraft();
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
    /* The photo on a submitted application can be replaced but not taken away,
       so while editing the dropzone is the only affordance offered. */
    removeBtn.hidden = state.editing;
  }

  /* The photo the server already holds. Remembered as well as shown: a
     replacement that fails has to fall back to it rather than leaving the
     field looking empty. */
  function showStoredPhoto(row, token) {
    state.serverPhoto = {
      name: row.photo.name,
      src: api('/photo?id=' + encodeURIComponent(row.id) + '&token=' + encodeURIComponent(token))
    };
    showPhoto(state.serverPhoto.name, state.serverPhoto.src);
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
    ensureDraft()
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
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            var err = new Error(d.error || r.status);
            err.status = r.status;
            err.editsClosed = !!d.edits_closed;
            throw err;
          });
        }
        return r.json();
      })
      .then(function (d) {
        state.serverPhoto = { name: d.name, src: localUrl };
        showPhoto(d.name, localUrl);
        setStatus('Photo uploaded — saved', 'saved');
      })
      .catch(function (err) {
        var why = err.editsClosed
          ? String(err.message)
          : err.status === 413 || String(err.message) === 'too_large' ||
            String(err.message) === 'too_large_no_r2'
            ? 'that photo is too big — try one under 10 MB'
            : 'the upload didn’t go through — check your connection and try again';
        setStatus('Photo not saved: ' + why, 'error');
        /* A failed replacement must not look like the photo is gone: the
           application still has the one the server already holds. */
        if (state.serverPhoto) showPhoto(state.serverPhoto.name, state.serverPhoto.src);
        else clearPhoto();
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

    /* A change to an application that is already in is a save, not a second
       submission: /submit would hand back a payment link and make correcting a
       typo look like being charged twice. */
    if (state.editing) {
      button.querySelector('span').textContent = 'Saving…';
      pushDraft()
        .then(function () { showEditSaved(); })
        .catch(function (err) {
          button.disabled = false;
          button.querySelector('span').textContent = 'Save changes';
          editSaveFailed(err);
        });
      return;
    }

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

  /* ------------------------------------------------------------ money --- */

  /* A lone amount, formatted the way this page has always formatted one: $25,
     not $25.00. Still right when the fee is a single number. */
  function money(cents) {
    return '$' + (cents / 100).toFixed(2).replace(/\.00$/, '');
  }

  /* Two decimals, always. Itemised rows have to line up under one another, and
     beside "$1.50" a bare "$28" reads as a different kind of number. */
  function money2(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  /* The fee as the WORKER reported it. /fee, /submit, /pay-intent and
     /preview-intent all name these same keys, so one reader serves all four.

     Nothing on this page computes a price. The gross-up that sizes the service
     fee so Stripe's cut comes out of it lives in the Worker; a second copy here
     would be a second answer to what the card is charged, and the one that is
     wrong would be the one the applicant reads.

     `amount_cents` is the fallback because it is the total on every one of
     those responses: an older Worker that sends only that renders as a single
     number, which is what this page showed before there was tax or a service
     fee to itemise. */
  function feeFrom(d) {
    if (!d) return null;
    var total = d.total_cents != null ? d.total_cents : d.amount_cents;
    if (total == null) return null;
    var tax = d.tax_cents || 0;
    var service = d.service_cents || 0;
    return {
      base_cents: d.base_cents != null ? d.base_cents : total,
      tax_cents: tax,
      service_cents: service,
      total_cents: total,
      tax_label: d.tax_label || 'Tax',
      service_label: d.service_label || 'Card processing fee',
      /* Whether there is anything to break the total DOWN into. Both off is the
         default, and then every screen shows the one number it always did. */
      itemised: tax > 0 || service > 0
    };
  }

  /* ONE FLAT TAX RATE FOR EVERYONE, BY DESIGN — and this page is where that
     decision is visible, so it is written down here too. The form asks for no
     billing address (see FIELDS), so there is no jurisdiction to compute from:
     `tax_label` is a fixed sentence an admin wrote, not a rate derived from who
     is paying. That is right while the fee is treated as DC-sourced — a slot in
     a DC festival — and wrong the moment it has to follow each applicant's own
     location. Making it per-jurisdiction starts HERE, with an address question
     and the consent and validation that come with one, then a rate table or
     Stripe Tax behind it in the Worker. Do not add an address field for any
     smaller reason, and do not try to vary the label client-side. */

  /* For a headline or a button: cents only when cents are in play. */
  function feeAmount(fee) {
    if (!fee) return '';
    return fee.itemised ? money2(fee.total_cents) : money(fee.total_cents);
  }

  function extraLabels(fee) {
    var out = [];
    if (fee.tax_cents > 0) out.push(fee.tax_label);
    if (fee.service_cents > 0) out.push(fee.service_label);
    return out;
  }

  function andList(items) {
    if (items.length < 2) return items[0] || '';
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /* The breakdown. Cheapest line first, in the same order and under the same
     labels as the emailed receipt (feeLines in the Worker), so the screen and
     the receipt cannot quote the applicant two different stories.

     Returns '' when nothing is added on top of the base fee — that is what
     keeps the default page free of a one-row table. */
  function feeTable(fee) {
    if (!fee || !fee.itemised) return '';

    var row = function (label, cents, cls) {
      return '<div class="fee-row' + (cls || '') + '">' +
        '<dt>' + esc(label) + '</dt><dd>' + money2(cents) + '</dd></div>';
    };

    return '<dl class="fee-rows">' +
      row('Application fee', fee.base_cents) +
      (fee.tax_cents > 0 ? row(fee.tax_label, fee.tax_cents) : '') +
      (fee.service_cents > 0 ? row(fee.service_label, fee.service_cents) : '') +
      row('Total charged to your card', fee.total_cents, ' fee-row--total') +
      '</dl>';
  }

  function showSubmitted(body, data) {
    form.hidden = true;
    hideSaveBar();
    done.hidden = false;

    var reference =
      '<p>Your reference is <span class="ref">' + esc(state.id) + '</span>. ' +
      (body.emailed
        ? 'A copy of your answers is on its way to ' + esc(data.contact_email) + '.'
        : 'Please save this reference — quote it if you email us about your application.') +
      '</p>';

    var inForm = body.payments_mode === 'stripe' && body.publishable_key;
    var fee = feeFrom(body);

    done.innerHTML =
      '<h2 class="h-md">Application received</h2>' +
      '<p><strong>You’re not done yet.</strong> Your application is incomplete until you pay the application fee' +
      (fee ? ' of <strong>' + feeAmount(fee) + '</strong>' : '') + '.</p>' +
      // Repeated here deliberately: this is the last screen before money
      // changes hands, so the provisional terms must be in front of them.
      (body.grace && body.grace_warning
        ? '<p class="apply-banner apply-banner--warn"><strong>Past the deadline.</strong> ' +
          esc(body.grace_warning) + '</p>'
        : '') +
      // Directly above the card field: the last place the price can still be a
      // surprise is the moment the card number goes in.
      feeTable(fee) +
      (inForm
        ? '<div id="pay-wrap">' +
            '<div id="payment-element"></div>' +
            '<p class="pay-error" id="pay-error" hidden></p>' +
            '<button type="button" class="btn btn--purple" id="pay-btn"><span>Pay ' +
              (fee ? feeAmount(fee) : 'the application fee') + '</span></button>' +
          '</div>'
        : '<p><a class="btn btn--purple" href="' + esc(body.payUrl) + '"><span>Pay the application fee</span></a></p>') +
      '<p>All sales are final and non-refundable. Payment does not guarantee entry. ' + esc(CONFIG.notification) + '</p>' +
      reference;

    done.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (window.gtag) gtag('event', 'application_submitted');

    if (inForm) mountPayment(body);
  }

  /* -------------------------------------------------- editing an entry --- */

  /* A resume link for an application that is already in reopens the form with
     the answers in it, because until applications close a team can still
     correct what they sent. Three things have to be unmistakable: the
     application is in, this is a change to that one rather than a second
     application, and changes stop at the deadline. */
  function openForEditing(d, keys) {
    /* Not remembered on this device. /apply/ in this browser is the next team's
       blank form, and a remembered key would reopen this application instead of
       giving them one. The link is what gets back in. */
    try { localStorage.removeItem(LS_DATA); localStorage.removeItem(LS_KEYS); } catch (err) {}

    state.submitted = true;
    state.editing = true;
    state.submittedAt = d.submitted_at;
    /* Only the server's own edit stamp counts. `updated_at` also moves when a
       PaymentIntent is created and again when the webhook lands, so reading
       that as "last changed" would tell almost every applicant they had edited
       an application they had only paid for. */
    state.editedAt = d.edited_at || null;
    /* Whether this one may still be changed is the Worker's answer, not a
       guess from the fee window: the fee tiers and `applications_phase` are
       separate switches, and only the Worker knows where the second one is.
       `editable` is absent on an older Worker, which reads as open — the save
       itself is still the authority. */
    state.editable = d.editable !== false;
    state.editNotice = d.edit_notice || '';

    /* Start from an empty form: whatever a half-finished draft left in this
       browser belongs to a different application, and fill() only overwrites
       the answers this one actually holds. */
    form.reset();
    clearPhoto();
    clearErrors();
    fill(d.data);
    if (d.photo) showStoredPhoto(d, keys.token);

    /* "Submit and pay" and "Save & finish later" are both the wrong promise
       now, and nothing on this page can clear an application that is in.
       `.btn` carries its own `display`, which wins against the hidden
       attribute, so that one is taken out with a style as well. */
    var button = $('submit');
    if (button) button.querySelector('span').textContent = 'Save changes';
    var later = $('save-later');
    if (later) { later.hidden = true; later.style.display = 'none'; }
    if ($('clear')) $('clear').hidden = true;

    if (state.editable) {
      setStatus('Your application is in — you’re editing it', 'saved');
    } else {
      /* The Worker has already said no. Better to show that here than to let
         someone retype a bio and lose it to a refusal. The answers stay on
         screen and stay selectable — what goes is the button that would
         promise to save them. */
      state.saveRefused = true;
      if (button) {
        button.disabled = true;
        button.querySelector('span').textContent = 'Changes are closed';
      }
      setStatus('Your application is in — it can no longer be changed', 'error');
    }
    renderNotice();

    paymentState(d, keys.token).then(function (fee) {
      state.paid = fee.paid;
      /* The rule for every screen from here on: someone who has paid is never
         shown a fee or a pay button for changing an answer. */
      if (state.paid === true && $('fee-paid-note')) $('fee-paid-note').hidden = false;
      renderNotice();
      // The answer to "has this been paid?" is what decides whether the price
      // belongs on screen at all, so the breakdown is redrawn once it lands.
      renderFee();
    });
  }

  /* Has the fee been paid? It decides whether a saved change ends on "nothing
     else to do" or on the payment step, so it is read from the server: `paid`
     on the draft response when it is there, the payment endpoint when it is
     not. null means neither could be reached, which the panels treat as "we
     can't promise either way" rather than picking an answer. */
  function paymentState(d, token) {
    if (typeof d.paid === 'boolean') return Promise.resolve({ paid: d.paid });
    return fetch(api('/payment-status?id=' + encodeURIComponent(d.id) +
                     '&token=' + encodeURIComponent(token)))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { return { paid: p && p.ok ? !!p.paid : null }; })
      .catch(function () { return { paid: null }; });
  }

  function showEditSaved() {
    state.dirty = false;
    form.hidden = true;
    hideSaveBar();
    done.hidden = false;

    var received = state.submittedAt ? ' on ' + esc(fmtDate(state.submittedAt)) : '';
    var when = state.savedAt ? ' — last changed on ' + esc(fmtDateTime(state.savedAt)) : '';
    var reference = '<p>Your reference is <span class="ref">' + esc(state.id) + '</span>.</p>';
    var updated =
      '<h2 class="h-md">Your changes are saved</h2>' +
      '<p>We have updated the application you sent us' + received + when + '. ' +
      'This is still the one application; nothing here starts a second one.</p>';

    /* Paid: the whole panel. No amount, no pay button, nothing that could be
       read as a second charge for fixing a typo. */
    if (state.paid === true) {
      done.innerHTML = updated +
        '<p>Your application fee is paid, so there is nothing else to do.</p>' +
        '<p><a href="' + esc(resumeUrl()) + '">Make another change</a>, or email ' +
        '<a href="mailto:admin@dcsketchfest.com">admin@dcsketchfest.com</a> if something ' +
        'still is not right.</p>' +
        reference;
      done.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (window.gtag) gtag('event', 'application_edited');
      return;
    }

    /* Unpaid, or unknown: saving a change does not make an application
       complete, so the fee step is still the fee step. In Stripe mode the card
       field is mounted — /pay-intent answers `paid: true` for anyone who has
       already paid, so an unknown state corrects itself on this screen rather
       than chasing someone for money they have already sent. */
    var fee = notice.fee;
    var inForm = notice.mode === 'stripe';

    done.innerHTML = updated +
      (state.paid === false
        ? '<p><strong>You’re not done yet.</strong> Your application is incomplete until you ' +
          'pay the application fee' +
          (fee ? ' of <strong>' + feeAmount(fee) + '</strong>' : '') + '.</p>'
        : '<p>If you have not paid the application fee yet, your application is incomplete ' +
          'until you do.</p>') +
      feeTable(fee) +
      (inForm
        ? '<div id="pay-wrap">' +
            '<div id="payment-element"></div>' +
            '<p class="pay-error" id="pay-error" hidden></p>' +
            '<button type="button" class="btn btn--purple" id="pay-btn"><span>Pay ' +
              (fee ? feeAmount(fee) : 'the application fee') + '</span></button>' +
          '</div>'
        /* The fee URL lives in the Worker's settings and only comes back with a
           submit response, so this panel has none to offer — send them to a
           person rather than to last year's checkout. */
        : '<p>Email <a href="mailto:admin@dcsketchfest.com">admin@dcsketchfest.com</a> with ' +
          'your reference and we’ll send you the payment link.</p>') +
      '<p>All sales are final and non-refundable. Payment does not guarantee entry. ' +
      esc(CONFIG.notification) + '</p>' +
      reference;

    done.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (window.gtag) gtag('event', 'application_edited');
    if (inForm) mountPayment({});
  }

  /* A save the server would not take. The deadline is the server's to enforce,
     so this reports what it said rather than deciding for itself — and it
     leaves the answers on the screen, where they can at least be copied into
     an email, instead of clearing the form. */
  function editSaveFailed(err) {
    var status = err && err.status;
    var refused = (err && err.editsClosed) || status === 403 || status === 409 || status === 410;

    errorBox.hidden = false;

    /* Not a failure so much as a stale tab: a recovery email rotates the token,
       so the link this page is holding has been superseded. Telling someone
       their application could not be found would be both wrong and alarming. */
    if (err && err.linkReplaced) {
      errorBox.textContent = 'This link has been replaced. We emailed you a newer one — ' +
        'open the most recent email from us and carry on there. Your answers are safe; ' +
        'nothing here has been lost.';
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (!refused) {
      errorBox.textContent = 'We couldn’t save that change just now. Your answers are still ' +
        'on this screen — please try again in a moment, or email admin@dcsketchfest.com.';
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    /* Refused for good: stop offering a button that cannot work, and say so at
       the top of the page as well, where someone who scrolls back up looks. */
    state.saveRefused = true;
    state.editable = false;
    state.editNotice = err.message || '';
    renderNotice();

    var button = $('submit');
    if (button) {
      button.disabled = true;
      button.querySelector('span').textContent = 'Changes are closed';
    }

    /* The Worker's sentence is the explanation — it knows which deadline bit,
       and it already says that nothing has been lost. All this adds is the
       reference, which it cannot know. */
    errorBox.innerHTML =
      '<p>' + esc(err.message || ('Applications have closed, so this application can no ' +
                  'longer be changed. ' + CONFIG.deadline_close)) + '</p>' +
      '<p>Quote your reference ' + esc(state.id) + ' if you email us about it.</p>';
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ------------------------------------------------------------- pay --- */

  /* Stripe.js is only fetched once someone actually reaches the payment step,
     so the form itself carries no third-party script for the 20 minutes people
     spend filling it in. Card fields live in Stripe's own iframes — card
     numbers never touch this page or the festival's servers. */
  /* ------------------------------------------------- deadline warning --- */

  /* The single notice at the top of the page. Two answers arrive on their own
     schedule — what the fee window is doing (/fee) and which application the
     link in the URL opens (/draft) — and both change what it should say, so
     each records what it learned and asks for one redraw. One element,
     replaced rather than appended, so the second answer cannot stack a second
     banner under the first. */
  var notice = {
    known: false, open: true, grace: false, warning: '',
    mode: '', fee: null, el: null
  };

  /* Ask the Worker what the fee is right now. Someone arriving in the grace
     window needs to know their application is provisional BEFORE they spend
     twenty minutes on it — telling them only on the receipt would be a nasty
     surprise attached to a charge. */
  function checkFeeWindow() {
    fetch(api('/fee'))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        notice.known = true;
        notice.open = !!d.open;
        notice.grace = !!d.grace;
        notice.warning = d.warning || '';
        /* Kept for the panel a saved edit lands on: an unpaid application still
           owes the fee, and that panel has no submit response to learn the
           breakdown or the payment mode from. */
        notice.mode = d.payments_mode || '';
        notice.fee = feeFrom(d);
        renderNotice();
        renderFee();
      })
      .catch(function () { /* never block the form on this */ });
  }

  function banner(cls, html) {
    var el = document.createElement('div');
    el.className = 'apply-banner ' + cls;
    el.innerHTML = html;
    var anchor = document.querySelector('.apply-body .container') || form.parentNode;
    anchor.insertBefore(el, anchor.firstChild);
    return el;
  }

  function renderNotice() {
    var cls = 'apply-banner--warn';
    var html = '';
    var closed = notice.known && !notice.open;

    if (state.editing) {
      closed = !state.editable;
      /* Everything an applicant who followed their own link back here has to
         understand before they touch a field: which application this is, that
         it is already in, when it last changed, where the fee stands, and that
         the window closes. */
      html = '<strong>This application is already in.</strong> ' +
        (state.submittedAt ? 'We received it on ' + esc(fmtDate(state.submittedAt)) + '. ' : '') +
        'Changing an answer here updates that application — it does not start a new one.' +
        (state.editedAt ? ' Last changed ' + esc(fmtDateTime(state.editedAt)) + '.' : '') +
        (state.paid === true
          ? ' Your application fee is paid; changing an answer costs nothing.' : '') +
        (state.paid === false
          ? ' Your application fee is still outstanding — your application is not complete ' +
            'until it is paid.' : '') +
        '<br>' +
        (closed
          ? (state.editNotice
              ? esc(state.editNotice)
              : '<strong>Applications have closed.</strong> ' + esc(CONFIG.edit_closed))
          : esc(CONFIG.edit_window) + ' Nothing you change is saved until you press ' +
            '<strong>Save changes</strong> at the end of the form.');
    } else if (closed) {
      cls = 'apply-banner--closed';
      html = '<strong>Applications are closed.</strong> Thanks for your interest — ' +
        'follow us on social media and we will announce next year’s dates there.';
    } else if (notice.known && notice.grace && notice.warning) {
      html = '<strong>Past the deadline.</strong> ' + esc(notice.warning);
    }

    if (notice.el) { notice.el.remove(); notice.el = null; }
    if (html) notice.el = banner(cls, html);
  }

  /* ------------------------------------------------- the price on screen --- */

  /* Put the real total in front of the applicant before they commit to it.
     Someone who reads "$25" in the deadlines panel, ticks an agreement that
     says only "the application fee" and then meets $27.61 at the card step
     either abandons or calls it a surprise charge afterwards. So the itemised
     number goes beside the agreement they tick, not only on the receipt.

     Every branch here is a no-op when neither tax nor a service fee is set: the
     three elements stay empty and hidden, and the page reads exactly as it did
     before any of this existed. */
  function renderFee() {
    var fee = notice.fee;
    var box = $('fee-breakdown');
    var agreeTotal = $('agree-total');
    var note = $('fee-extras-note');

    /* Never shown to someone who has already paid — the rule for every screen
       after payment is that correcting an answer is not priced. Nor before /fee
       has answered, nor once it reports applications closed: there is no fee to
       quote in either case. */
    var show = !!fee && fee.itemised && notice.open && state.paid !== true;
    var labels = show ? extraLabels(fee) : [];

    if (box) {
      box.innerHTML = show
        ? feeTable(fee) +
          '<p class="help fee-note">This is the full amount your card will be ' +
          'charged. ' + esc(andList(labels)) + (labels.length > 1 ? ' are' : ' is') +
          ' added to the application fee at checkout.</p>'
        : '';
      box.hidden = !show;
    }

    /* The agreement names the number. "I will pay the application fee" is not
       consent to a larger charge, and consent is the thing a chargeback turns
       on. */
    if (agreeTotal) {
      agreeTotal.innerHTML = show
        ? ' of <strong>' + money2(fee.total_cents) + '</strong> (including ' +
          esc(andList(labels)) + ')'
        : '';
    }

    /* The deadlines panel lists a base fee per window, and /fee reports only
       the window that is open now, so the other two cannot be totalled without
       a second copy of the gross-up. Say what those prices are instead, and
       give the real total for today. */
    if (note) {
      note.innerHTML = show
        ? 'Those prices are the application fee itself. With ' +
          esc(andList(labels)) + ' added, an application started today comes to ' +
          '<strong>' + money2(fee.total_cents) + '</strong>.'
        : '';
      note.hidden = !show;
    }
  }

  /* ------------------------------------------------------ admin bypass --- */

  /* `?fill=1` fills every question with obvious placeholder answers and
     generates the required group photo, so an admin can reach the payment
     step in one click instead of typing out a whole application.

     Deliberately NOT a validation bypass: it satisfies the real requirements
     through the real code paths, so what you see afterwards is exactly what an
     applicant gets. Nothing server-side is loosened, which means this can't
     become a hole that lets a genuine applicant skip required questions.

     Everything it types is prefixed TEST so any application that reaches the
     admin panel this way is obvious at a glance. */
  var TEST_ANSWERS = {
    team_name: 'TEST — delete me',
    bio: 'TEST application created with the staging prefill tool. Not a real team. Safe to delete.',
    team_size: '4',
    home: 'Washington, DC',
    instagram: '@dcsketchfest',
    contact_first: 'Test',
    contact_last: 'Applicant',
    contact_email: 'admin@dcsketchfest.com',
    contact_phone: '202-555-0100',
    tape: 'https://vimeo.com/76979871',
    show_description: 'TEST submission used to check the application flow end to end.',
    // Not TEST-prefixed: a radio stays unchecked unless the value is one of
    // the options, which would leave the prefilled form failing validation.
    tech_level: 'Little to No Tech (not counting blackouts there are less than 5 cues)',
    stage_reqs: 'TEST — two chairs.',
    tech_reqs: 'TEST — one mic.',
    accessibility: '',
    anything_else: 'TEST application. Delete before judging.',
    agree: true
  };

  function fillTestApplication() {
    var data = {};
    FIELDS.forEach(function (f) {
      if (f.type === 'list') {
        // Tick the first option of each checkbox group — enough to be valid
        // without pretending the team is available every night.
        var first = form.querySelector('input[name="' + f.name + '"]');
        data[f.name] = first ? [first.value] : [];
      } else if (f.type === 'bool') {
        data[f.name] = true;
      } else {
        data[f.name] = TEST_ANSWERS[f.name] !== undefined ? TEST_ANSWERS[f.name] : 'TEST';
      }
    });
    fill(data);
    touch();

    banner('apply-banner--warn',
      '<strong>Test mode.</strong> This form has been filled with placeholder answers ' +
      'so you can reach the payment step. Anything submitted will appear in the admin ' +
      'panel as “TEST — delete me”.');

    // The photo is genuinely required, so make a real one and push it through
    // the real upload endpoint rather than teaching the server to skip it.
    makePlaceholderPhoto()
      .then(function (file) {
        /* Put the file on the input itself, not just through the handler, so
           the field is really populated — otherwise the preview shows a photo
           while `photoInput.files` is empty, which looks fine but isn't the
           same state an applicant's browser would be in. */
        try {
          var dt = new DataTransfer();
          dt.items.add(file);
          photoInput.files = dt.files;
        } catch (err) {
          // Older Safari won't allow assigning files; the upload below still works.
        }
        handleFile(file);
      })
      .catch(function () { setStatus('Could not generate a test photo', 'error'); });

    var submit = $('submit');
    if (submit) submit.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* A visible prefill button, but only where it can't confuse an applicant:
     staging and localhost. On dcsketchfest.com it never renders, so the real
     form stays clean — `?fill=1` still works everywhere for anyone who knows
     to type it. */
  var STAGING_HOSTS = /^(staging\.dcsketchfest\.com|localhost|127\.0\.0\.1|.*\.local)$/i;

  function maybeShowStagingTools() {
    if (!STAGING_HOSTS.test(location.hostname)) return;

    var bar = document.createElement('div');
    bar.className = 'staging-tools';
    bar.innerHTML =
      '<span class="staging-tools__tag">Staging</span>' +
      '<button type="button" class="staging-tools__btn" id="staging-fill">Fill with test data</button>' +
      '<button type="button" class="staging-tools__btn" id="staging-reset">Clear</button>';
    document.body.appendChild(bar);

    $('staging-fill').addEventListener('click', function () {
      if (state.submitted) return;
      fillTestApplication();
    });

    /* Clearing wipes only this browser's copy. The server-side draft is left
       alone deliberately — deleting real rows from a button on a web page is
       not something worth risking a misclick on. */
    $('staging-reset').addEventListener('click', function () {
      try { localStorage.removeItem(LS_DATA); localStorage.removeItem(LS_KEYS); } catch (err) {}
      location.href = location.pathname;
    });
  }

  function makePlaceholderPhoto() {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement('canvas');
      canvas.width = 1200; canvas.height = 800;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#2b3fbf';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffc933';
      ctx.font = 'bold 96px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TEST PHOTO', canvas.width / 2, canvas.height / 2);
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error('no_blob'));
        resolve(new File([blob], 'test-photo.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.8);
    });
  }

  /* --------------------------------------------------- checkout preview --- */

  /* `?preview=<code>` renders the real Stripe checkout with no application
     behind it, so an admin can see what applicants will see. The code is set
     in the judge app's Settings; the Worker rejects anything else. */
  function maybePreviewCheckout() {
    var code = new URLSearchParams(location.search).get('preview');
    if (!code) return false;

    form.hidden = true;
    hideSaveBar();
    done.hidden = false;
    done.innerHTML =
      '<h2 class="h-md">Checkout preview</h2>' +
      '<p>This is the payment step exactly as an applicant sees it. ' +
      'No application has been created and nothing here is saved.</p>' +
      '<div id="pay-wrap"><div id="payment-element"></div>' +
      '<p class="pay-error" id="pay-error" hidden></p>' +
      '<button type="button" class="btn btn--purple" id="pay-btn"><span>Pay</span></button></div>';

    loadStripeJs()
      .then(function () {
        return fetch(api('/preview-intent'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code })
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'preview_failed');
        var b = res.body;

        if (b.live) {
          banner('apply-banner--warn',
            '<strong>These are LIVE Stripe keys.</strong> A card entered here will really be charged. ' +
            'Switch to test keys (<code>pk_test_…</code>) before trying a payment.');
        }

        /* The preview is meant to be the applicant's checkout exactly, so it
           gets the same itemised breakdown above the same card field. */
        var fee = feeFrom(b);
        var table = feeTable(fee);
        if (table) $('pay-wrap').insertAdjacentHTML('afterbegin', table);

        var payBtn = $('pay-btn');
        payBtn.querySelector('span').textContent = 'Pay ' + feeAmount(fee) +
          (b.tier ? ' (' + b.tier + ')' : '');

        var stripe = window.Stripe(b.publishable_key);
        var elements = stripe.elements({
          clientSecret: b.client_secret,
          appearance: {
            theme: 'flat',
            variables: {
              colorPrimary: '#2b3fbf', colorText: '#211b3a', colorBackground: '#fffdf8',
              fontFamily: '"Space Grotesk", system-ui, sans-serif', borderRadius: '12px'
            }
          }
        });
        elements.create('payment', { layout: 'tabs' }).mount('#payment-element');

        payBtn.addEventListener('click', function () {
          payBtn.disabled = true;
          payBtn.querySelector('span').textContent = 'Paying…';
          stripe.confirmPayment({
            elements: elements, redirect: 'if_required', confirmParams: { return_url: location.href }
          }).then(function (result) {
            payBtn.disabled = false;
            var box = $('pay-error');
            if (result.error) {
              payBtn.querySelector('span').textContent = 'Try again';
              if (box) { box.hidden = false; box.textContent = result.error.message; }
            } else {
              $('pay-wrap').innerHTML =
                '<p class="pay-ok"><strong>Payment succeeded.</strong> ' +
                'This was a preview — no application was created.</p>';
            }
          });
        });
      })
      .catch(function (err) {
        $('pay-wrap').innerHTML = '<p class="pay-error">Preview unavailable: ' +
          esc(String(err.message)) + '</p>';
      });

    return true;
  }

  function loadStripeJs() {
    if (window.Stripe) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('stripe_js')); };
      document.head.appendChild(s);
    });
  }

  function mountPayment(body) {
    var errorBox = $('pay-error');
    var payBtn = $('pay-btn');

    function fail(message) {
      if (!errorBox) return;
      errorBox.hidden = false;
      errorBox.textContent = message;
    }

    loadStripeJs()
      .then(function () {
        return fetch(api('/pay-intent'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.id, token: state.token })
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'pay_intent_failed');
        if (res.body.paid) return showPaid();

        /* /pay-intent returns the publishable key as well, so a panel that did
           not come from a submit response — a saved edit that still owes the
           fee — can mount the card field without being handed one. */
        var stripe = window.Stripe(res.body.publishable_key || body.publishable_key);
        var elements = stripe.elements({
          clientSecret: res.body.client_secret,
          appearance: {
            theme: 'flat',
            variables: {
              colorPrimary: '#2b3fbf',
              colorText: '#211b3a',
              colorBackground: '#fffdf8',
              fontFamily: '"Space Grotesk", system-ui, sans-serif',
              borderRadius: '12px'
            }
          }
        });
        /* Payment Element decides for itself which wallets to offer, so Apple
           Pay appears on Safari/iOS and Google Pay on Android with no branching
           here — but only over HTTPS on a domain registered with Stripe. */
        elements.create('payment', { layout: 'tabs' }).mount('#payment-element');

        payBtn.addEventListener('click', function () {
          payBtn.disabled = true;
          payBtn.querySelector('span').textContent = 'Paying…';
          if (errorBox) errorBox.hidden = true;

          stripe.confirmPayment({
            elements: elements,
            redirect: 'if_required',
            confirmParams: { return_url: location.href }
          }).then(function (result) {
            if (result.error) {
              payBtn.disabled = false;
              payBtn.querySelector('span').textContent = 'Try again';
              fail(result.error.message || 'That payment did not go through.');
              return;
            }
            /* Don't take the browser's word for it — the webhook is what marks
               the application paid, so read the server's view back. */
            confirmPaidWithServer();
          });
        });
      })
      .catch(function () {
        var wrap = $('pay-wrap');
        if (wrap) {
          wrap.innerHTML = '<p>We couldn’t load the payment form. Your application is saved — ' +
            'email <a href="mailto:admin@dcsketchfest.com">admin@dcsketchfest.com</a> and we’ll send you a payment link.</p>';
        }
      });
  }

  function confirmPaidWithServer(attempt) {
    attempt = attempt || 0;
    fetch(api('/payment-status?id=' + encodeURIComponent(state.id) +
              '&token=' + encodeURIComponent(state.token)))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.paid) return showPaid();
        // The webhook usually lands within a second or two; give it a few
        // tries before telling someone their money is in limbo.
        if (attempt < 6) return setTimeout(function () { confirmPaidWithServer(attempt + 1); }, 1200);
        var wrap = $('pay-wrap');
        if (wrap) {
          wrap.innerHTML = '<p><strong>Your payment went through.</strong> It is taking a moment to ' +
            'register on our side — you do not need to pay again. Quote reference ' +
            '<span class="ref">' + esc(state.id) + '</span> if you email us.</p>';
        }
      })
      .catch(function () {});
  }

  function showPaid() {
    var wrap = $('pay-wrap');
    if (wrap) {
      wrap.innerHTML = '<p class="pay-ok"><strong>Paid — your application is complete.</strong> ' +
        'Nothing else is needed from you.</p>';
    }
    if (window.gtag) gtag('event', 'application_paid');
  }

  /* ------------------------------------------------------ email my link --- */

  /* Where the link goes is not this page's choice: the Worker mails the address
     stored on the application and ignores anything we send with the request.
     That is deliberate — the link is a bearer credential for the whole
     application, so a page that could name the recipient would be a way to post
     one team's application to an address they never chose. Hence no "send it
     somewhere else" field here, and copy that promises the address on the
     application rather than one we could offer to change. */
  function emailMyLink() {
    var typed = (form.elements.contact_email.value || '').trim();

    /* Nowhere to send it yet. The Worker says so too, but in a sentence the
       applicant would have to go looking for; say it at the field instead. */
    if (!typed) {
      clearErrors();
      fieldError('contact_email', 'Add your email address first — that’s where the link goes.');
      var box = form.elements.contact_email;
      if (box) { box.focus(); box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return Promise.reject(new Error('no_email'));
    }

    /* A draft is saved first, so the address the Worker mails is the one on the
       screen. An edit is not: saving is the applicant's own button to press, and
       saving a paid application raises an email to the organisers — asking for
       a link should do neither. Which also means an edit's link goes to the
       address the application already holds, so the confirmation says exactly
       that rather than naming the typed one. */
    var saved = !state.editing;

    return (saved ? pushDraft() : Promise.resolve(state))
      .then(function () {
        return fetch(api('/email-link'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.id, token: state.token })
        });
      })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, body: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'email_failed');
        return { emailed: !!res.body.emailed, to: saved ? typed : null };
      });
  }

  /* In the save bar, which is sticky: losing the link is the one problem an
     applicant cannot solve from inside the form, so the fix cannot be two
     clicks deep inside another panel. */
  /* ---------------------------------------------------------- recovery --- */

  /* For an applicant with no link at all. POST /recover answers an identical
     200 whether or not the address has an application, so that someone cannot
     use this to discover who applied — which means this UI must never say
     "found" or "not found" either. The hedged copy below is the whole point;
     do not "improve" it into a confirmation.

     Recovery mints a fresh token, so any older link stops working. That is
     unavoidable: only the hash is stored, so the previous link cannot be
     reproduced. */
  (function recovery() {
    var toggle = $('recover-toggle'), box = $('recover-form');
    var field = $('recover-email'), send = $('recover-send'), status = $('recover-status');
    if (!toggle || !box) return;

    toggle.addEventListener('click', function () {
      box.hidden = !box.hidden;
      if (!box.hidden) field.focus();
    });

    send.addEventListener('click', function () {
      var email = String(field.value || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        status.textContent = 'That email address does not look right.';
        field.focus();
        return;
      }

      send.disabled = true;
      status.textContent = 'Sending…';

      fetch(api('/recover'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          return { status: r.status, body: d };
        });
      }).then(function (res) {
        if (res.status === 200) {
          /* Deliberately hedged: a definite "we sent it" would confirm the
             address has an application. */
          box.innerHTML =
            '<p>If that address has an application in progress, we\u2019ve emailed the ' +
            'link to it. Check your inbox \u2014 and your spam folder. The newest email ' +
            'always has the working link; older ones stop working.</p>';
          return;
        }
        status.textContent = res.body && res.body.error
          ? res.body.error
          : 'We could not do that right now. Please try again shortly.';
        send.disabled = false;
      }).catch(function () {
        status.textContent = 'We could not reach the server. Please try again shortly.';
        send.disabled = false;
      });
    });
  })();

  $('email-link-bar').addEventListener('click', function () {
    var btn = $('email-link-bar');
    btn.disabled = true;
    setStatus('Sending your link…', 'saving');

    emailMyLink()
      .then(function (r) {
        btn.disabled = false;
        setStatus(r.emailed
          ? 'Link sent to ' + (r.to || 'the email address on your application')
          : 'We couldn’t send that email — copy the link from your address bar instead',
        r.emailed ? 'saved' : 'error');
      })
      .catch(function (err) {
        btn.disabled = false;
        setStatus(String(err.message) === 'no_email'
          ? 'Add your email address and try again'
          : 'We couldn’t send that email just now — please try again in a moment', 'error');
      });
  });

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
        var link = resumeUrl();

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
            // The same action as the one in the save bar, and the same rule
            // about where it goes: the Worker picks the address, not this page.
            emailMyLink()
              .then(function (r) {
                $('mail-note').innerHTML = r.emailed
                  ? 'Sent to <strong>' + esc(r.to || email) + '</strong>. Check your spam folder if it doesn’t arrive.'
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
    /* An edit is never autosaved, so unsaved work is exactly the case to warn
       about even though the application itself is already submitted. */
    if (state.dirty && state.id && (!state.submitted || state.editing)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------------------------------------------------------- startup --- */

  function boot() {
    // Admin checkout preview short-circuits everything else.
    if (maybePreviewCheckout()) return;

    saveBar.hidden = false;
    setStatus('Not saved yet', '');

    // Warn about a closed or grace-period window before anyone starts typing.
    checkFeeWindow();

    // Staging-only prefill controls. Never rendered on the live site.
    maybeShowStagingTools();

    var params = new URLSearchParams(location.search);

    // Admin shortcut: fill the whole form so the payment step is one click away.
    if (params.get('fill')) {
      fillTestApplication();
      return;
    }
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

        /* Submitted is no longer the end of the road: the form reopens with
           their answers in it so a typo does not need an email to fix. */
        if (d.status === 'submitted') {
          openForEditing(d, keys);
          return;
        }

        writeLocal(LS_KEYS, keys);
        fill(d.data);
        writeLocal(LS_DATA, d.data);
        if (d.photo) showStoredPhoto(d, keys.token);
        setStatus('Picked up where you left off', 'saved');
      })
      .catch(function () {
        // A bad or expired link shouldn't block a fresh application.
        if (params.get('id')) setStatus('That save link didn’t work — starting a new application', 'error');
      });
  }

  boot();
})();
