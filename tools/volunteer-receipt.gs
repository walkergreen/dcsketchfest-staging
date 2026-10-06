/**
 * Volunteer sign-up receipts.
 *
 * Google Apps Script bound to the "DCSF 2027 Pre-Festival Volunteer Sign Up
 * (Responses)" spreadsheet. On every new response it emails the volunteer a
 * receipt and the organisers a copy.
 *
 * Why the organiser copy matters more than it looks: it is the only per-signup
 * proof that the whole path worked. The volunteer page posts into the Google
 * Form blind — Google's endpoint sends no CORS headers, so the browser cannot
 * tell a stored response from a rejected one, and the visitor is thanked
 * either way. This trigger runs only when Google really did record a row, so
 * an organiser copy landing in the inbox is the confirmation the page itself
 * can never give you.
 *
 * It does NOT warn you about silence. If the form is edited and submissions
 * start being rejected, no response is recorded, so no mail is sent — and an
 * empty inbox looks exactly like a quiet week. Pair this with
 * tools/check-volunteer-form.py, which checks the coupling proactively.
 *
 * Setup (needs edit access to the responses spreadsheet):
 *   1. Open the spreadsheet -> Extensions -> Apps Script, paste this in.
 *   2. Set ORGANISER_EMAILS below.
 *   3. Triggers (clock icon) -> Add trigger:
 *        function: onVolunteerSignup
 *        source:   From spreadsheet
 *        type:     On form submit          <- not "on edit"
 *   4. Authorise it. Submit a test response and confirm both mails arrive.
 *
 * A simple onFormSubmit() function is NOT enough here: sending mail needs an
 * installable trigger, which is why step 3 is explicit.
 */

// Who gets the heartbeat copy. Comma-separated.
var ORGANISER_EMAILS = 'admin@dcsketchfest.com';

var FESTIVAL = 'DC Sketchfest';
var REPLY_TO = 'admin@dcsketchfest.com';

// Column headers as the form writes them. Trimmed before matching, so a
// trailing space in the sheet header will not break this.
var Q_NAME  = 'What is your name?';
var Q_EMAIL = 'What is your email address?';
var Q_AREAS = 'What areas are your interested in volunteering for?';
var Q_DAYS  = 'What days are best for you for meeting (assume evenings)?';

function onVolunteerSignup(e) {
  if (!e || !e.namedValues) {
    throw new Error('Run this from an "On form submit" trigger, not by hand.');
  }

  var answers = normalise_(e.namedValues);
  var name  = firstMatch_(answers, Q_NAME);
  var email = firstMatch_(answers, Q_EMAIL);
  var areas = firstMatch_(answers, Q_AREAS);
  var days  = firstMatch_(answers, Q_DAYS);

  // Always tell the organisers, even when the volunteer's address is unusable —
  // that is the case you most want to hear about.
  notifyOrganisers_(name, email, areas, days, answers);

  if (!isPlausibleEmail_(email)) {
    console.warn('No usable email on this response; receipt skipped.');
    return;
  }

  var body =
    'Hi ' + (name || 'there') + ',\n\n' +
    'Thanks for signing up to volunteer with ' + FESTIVAL + ' before the 2027 festival.\n\n' +
    'Here is what we have for you:\n' +
    '  Areas: ' + (areas || '(none selected)') + '\n' +
    '  Best meeting days: ' + (days || '(none selected)') + '\n\n' +
    'We will be in touch about pre-festival planning. There will be a separate ' +
    'form in January for volunteering during the festival itself.\n\n' +
    'If anything above looks wrong, just reply to this email.\n\n' +
    '— ' + FESTIVAL + '\n';

  MailApp.sendEmail({
    to: email,
    replyTo: REPLY_TO,
    subject: 'You are signed up to volunteer with ' + FESTIVAL,
    body: body
  });
}

function notifyOrganisers_(name, email, areas, days, answers) {
  if (!ORGANISER_EMAILS) return;
  MailApp.sendEmail({
    to: ORGANISER_EMAILS,
    replyTo: isPlausibleEmail_(email) ? email : REPLY_TO,
    subject: 'New volunteer sign-up: ' + (name || '(no name given)'),
    body:
      'A new pre-festival volunteer signed up.\n\n' +
      '  Name:  ' + (name || '-') + '\n' +
      '  Email: ' + (email || '-') + '\n' +
      '  Areas: ' + (areas || '-') + '\n' +
      '  Days:  ' + (days || '-') + '\n\n' +
      'Full response is in the responses sheet.\n'
  });
}

/** Lower-cased, trimmed header -> first answer. */
function normalise_(namedValues) {
  var out = {};
  Object.keys(namedValues).forEach(function (key) {
    var values = namedValues[key] || [];
    out[String(key).trim().toLowerCase()] = values.join(', ');
  });
  return out;
}

/**
 * Headers are matched loosely: the question wording is the sheet's column
 * name, and a small edit to the question in the form would otherwise silently
 * stop the receipt naming the right things.
 */
function firstMatch_(answers, question) {
  var want = question.trim().toLowerCase();
  if (answers[want]) return answers[want];
  var keys = Object.keys(answers);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(want.slice(0, 18)) === 0) return answers[keys[i]];
  }
  return '';
}

function isPlausibleEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}
