// ========================================================================
// Standalone backend for shirt_distribution.html — bound to its OWN,
// dedicated Google Sheet (separate from the bus check-in system).
//
// Expected tabs in that Sheet:
//
//   "Names"       -> A: ID | B: Name | C: Group (optional, e.g. class/bus)
//                     | D: Size | E: Given At | F: Given By
//   "Supervisors" -> A: Name | B: Size | C: Given At | D: Given By
//   "Inventory"   -> A: Size | B: Initial Stock | C: Low Stock Threshold
//   "Log"         -> created automatically on the first distribution
//
// Sizes are open-ended (S/M/L/XL/XXL/...) — the sheet's own Size column
// and Inventory rows are the source of truth, nothing here hardcodes them.
//
// All reads (search, inventory levels, roster) are done client-side via
// the public gviz/tq JSON feed — this script only needs to handle the
// POST request that marks a shirt as handed out.
//
// SETUP:
//   1. Open the new Sheet -> Extensions -> Apps Script.
//   2. Paste this whole file in (replacing the default Code.gs content).
//   3. Deploy -> New deployment -> type: Web app.
//      - Execute as: Me
//      - Who has access: Anyone
//   4. Copy the resulting /exec URL into APPS_SCRIPT_URL in
//      shirt_distribution.html.
// ========================================================================

const STUDENTS_SHEET_NAME = 'Names';
const SUPERVISORS_SHEET_NAME = 'Supervisors';
const LOG_SHEET_NAME = 'Log';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const result = distributeShirt(data);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// chosenSize is picked by the supervisor at hand-out time (the UI pre-fills
// it with the registered size, but it can be overridden). It always wins
// over the sheet's registered size, and the sheet is updated to reflect
// what was actually handed out.
function distributeShirt(data) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { success: false, error: 'System is busy, please try again in a moment.' };
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const personType = data.personType;
    const personId = (data.personId || '').toString().trim();
    const supervisor = data.supervisor || '';
    const chosenSize = (data.size || '').toString().trim().toUpperCase();

    if (!personId) return { success: false, error: 'Missing person ID' };

    if (personType === 'student') {
      return giveStudentShirt(ss, personId, supervisor, chosenSize);
    } else if (personType === 'supervisor') {
      return giveSupervisorShirt(ss, personId, supervisor, chosenSize);
    }
    return { success: false, error: 'Invalid personType' };
  } finally {
    lock.releaseLock();
  }
}

function giveStudentShirt(ss, studentId, givenBy, chosenSize) {
  const sheet = ss.getSheetByName(STUDENTS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Names sheet not found' };

  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0].toString().trim() === studentId) {
      const registeredSize = (values[i][3] || '').toString().trim().toUpperCase(); // column D
      const givenAt = values[i][4];                                                 // column E

      if (givenAt) {
        return {
          success: false,
          error: 'Shirt already given',
          alreadyGiven: true,
          givenAt: givenAt,
          size: registeredSize
        };
      }

      const size = chosenSize || registeredSize;
      if (!size) {
        return { success: false, error: 'No shirt size selected' };
      }

      const now = new Date();
      const timeString = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      sheet.getRange(i + 1, 4).setValue(size);        // D - size actually handed out
      sheet.getRange(i + 1, 5).setValue(timeString);  // E
      sheet.getRange(i + 1, 6).setValue(givenBy);     // F

      const note = (registeredSize && registeredSize !== size) ? ('Changed from ' + registeredSize) : '';
      logShirt(ss, studentId, values[i][1], 'Student', size, givenBy, note);

      return { success: true, size: size, timestamp: timeString, name: values[i][1] };
    }
  }
  return { success: false, error: 'Student not found' };
}

function giveSupervisorShirt(ss, name, givenBy, chosenSize) {
  const sheet = ss.getSheetByName(SUPERVISORS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Supervisors sheet not found' };

  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0].toString().trim() === name.trim()) {
      const registeredSize = (values[i][1] || '').toString().trim().toUpperCase(); // column B
      const givenAt = values[i][2];                                                // column C

      if (givenAt) {
        return {
          success: false,
          error: 'Shirt already given',
          alreadyGiven: true,
          givenAt: givenAt,
          size: registeredSize
        };
      }

      const size = chosenSize || registeredSize;
      if (!size) {
        return { success: false, error: 'No shirt size selected' };
      }

      const now = new Date();
      const timeString = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      sheet.getRange(i + 1, 2).setValue(size);        // B - size actually handed out
      sheet.getRange(i + 1, 3).setValue(timeString);  // C
      sheet.getRange(i + 1, 4).setValue(givenBy);     // D

      const note = (registeredSize && registeredSize !== size) ? ('Changed from ' + registeredSize) : '';
      logShirt(ss, name, name, 'Supervisor', size, givenBy, note);

      return { success: true, size: size, timestamp: timeString, name: name };
    }
  }
  return { success: false, error: 'Supervisor not found' };
}

function logShirt(ss, id, name, type, size, givenBy, note) {
  let logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!logSheet) {
    logSheet = ss.insertSheet(LOG_SHEET_NAME);
    logSheet.appendRow(['Timestamp', 'ID', 'Name', 'Type', 'Size', 'Given By', 'Note']);
  }
  logSheet.appendRow([new Date(), id, name, type, size, givenBy, note || '']);
}
