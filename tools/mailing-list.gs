/**
 * DC Sketchfest mailing list intake.
 *
 * Google Apps Script bound to a Google Sheet. Receives POSTs from the signup
 * form on dcsketchfest.com and appends one row per signup.
 *
 * Setup is in the repo README under "Mailing list". Short version:
 *   1. Create a Sheet, Extensions -> Apps Script, paste this in.
 *   2. Deploy -> New deployment -> Web app.
 *        Execute as:     Me
 *        Who has access: Anyone            <- required; "Anyone with Google
 *                                             account" will reject the form
 *   3. Copy the /exec URL into data-endpoint on the form in index.html.
 *
 * Re-deploy as a *new version* after any edit, or the live URL keeps running
 * the old code — the single most common way this silently stops working.
 */

// The DC Sketchfest mailing list Sheet. Pinned by ID so this works whether the
// script is bound to the Sheet or standalone. To point it somewhere else, swap
// the ID from that Sheet's URL: /spreadsheets/d/<ID>/edit
var SHEET_ID = '1Ie3SdfTFCmJSqegK4n_zG5mf26puzopWpDWgP-ISiXQ';
var SHEET_NAME = 'Signups';
var HEADERS = ['Timestamp', 'Email', 'Name', 'Source', 'User agent'];

function doPost(e) {
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var email = String(payload.email || '').trim();

    if (!isPlausibleEmail_(email)) {
      return json_({ ok: false, error: 'invalid email' });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(15000);                 // serialise concurrent signups
    try {
      var sheet = getSheet_();
      if (findRowByEmail_(sheet, email)) {
        return json_({ ok: true, duplicate: true });
      }
      sheet.appendRow([
        new Date(),
        email,
        String(payload.name || '').trim().slice(0, 120),
        String(payload.source || '').slice(0, 200),
        (e && e.parameter && e.parameter.ua) || ''
      ]);
    } finally {
      lock.releaseLock();
    }

    return json_({ ok: true });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server error' });
  }
}

/** Visiting the /exec URL in a browser should say something useful. */
function doGet() {
  return json_({ ok: true, service: 'dcsketchfest mailing list', method: 'POST' });
}

function getSheet_() {
  var ss = SHEET_ID
    ? SpreadsheetApp.openById(SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Case-insensitive lookup so the same person cannot land twice. */
function findRowByEmail_(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var values = sheet.getRange(2, 2, last - 1, 1).getValues();
  var needle = email.toLowerCase();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() === needle) return i + 2;
  }
  return 0;
}

function isPlausibleEmail_(s) {
  return s.length >= 6 && s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
