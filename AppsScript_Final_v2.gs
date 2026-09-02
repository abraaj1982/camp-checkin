const SHEET_NAME = 'Bus';
const LOG_SHEET_NAME = 'CheckInLog';

// doGet - GET requests
function doGet(e) {
  const action = e.parameter.action;
  const studentId = e.parameter.studentId;
  
  try {
    if (action === 'lookup') {
      return ContentService.createTextOutput(JSON.stringify(findStudent(studentId)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    if (action === 'getDashboard') {
      return ContentService.createTextOutput(JSON.stringify(getDashboard()))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid action' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ 
      error: error.toString(),
      success: false 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// doPost - POST requests
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.requestType === 'shirt') {
      const shirtResult = distributeShirt(data);
      return ContentService.createTextOutput(JSON.stringify(shirtResult))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const result = saveCheckInOut(data);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ========== findStudent ==========
function findStudent(studentId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    return { found: false, error: 'Sheet not found' };
  }
  
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const id = data[i][0] ? data[i][0].toString().trim() : '';
    
    if (id === studentId.toString().trim()) {
      return {
        found: true,
        studentId: studentId,
        name: data[i][1] || '',
        photoUrl: data[i][6] || '',
        teamName: data[i][2] || '',
        busNumber: data[i][3] || '',
        className: data[i][5] || '',
        contactNumber: data[i][4] || '',
        checkInTime: data[i][7] || '',
        checkOutTime: data[i][8] || '',
        status: data[i][9] || 'Waiting',
        alreadyCheckedIn: (data[i][7] !== '' && data[i][8] === ''),
        alreadyCheckedOut: (data[i][8] !== '')
      };
    }
  }
  
  return { found: false, studentId: studentId };
}

// ========== getDashboard ==========
function getDashboard() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      return { success: false, error: 'Bus sheet not found' };
    }
    
    const data = sheet.getDataRange().getValues();
    
    let total = 0, checkedIn = 0, waiting = 0;
    let duplicates = [];
    let busMap = {};
    let checkinIds = {};
    
    for (let i = 1; i < data.length; i++) {
      const id = data[i][0] ? data[i][0].toString().trim() : '';
      const name = data[i][1] ? data[i][1].toString().trim() : '';
      const bus = data[i][3] ? data[i][3].toString().trim() : 'Unknown';
      const checkInTime = data[i][7] ? data[i][7].toString().trim() : '';
      
      if (!id || id === '') continue;
      
      total++;
      
      if (!busMap[bus]) {
        busMap[bus] = { name: 'Bus ' + bus, checkedIn: 0, capacity: 0 };
      }
      busMap[bus].capacity++;
      
      if (checkInTime !== '') {
        checkedIn++;
        busMap[bus].checkedIn++;
        
        if (checkinIds[id]) {
          checkinIds[id].count++;
          checkinIds[id].lastTime = checkInTime;
          if (!duplicates.find(d => d.id === id)) {
            duplicates.push(checkinIds[id]);
          }
        } else {
          checkinIds[id] = { 
            id: id, 
            name: name, 
            firstTime: checkInTime, 
            lastTime: checkInTime, 
            count: 1 
          };
        }
      } else {
        waiting++;
      }
    }
    
    let busList = [];
    for (const key in busMap) {
      busList.push(busMap[key]);
    }
    
    const filteredDuplicates = duplicates.filter(d => d.count > 1);
    
    return {
      success: true,
      totalStudents: total,
      checkedIn: checkedIn,
      waiting: waiting,
      duplicates: filteredDuplicates,
      busList: busList,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return { 
      success: false, 
      error: error.toString(),
      totalStudents: 0,
      checkedIn: 0,
      waiting: 0,
      duplicates: [],
      busList: []
    };
  }
}

// ========== saveCheckInOut ==========
function saveCheckInOut(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  const logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  
  if (!sheet || !logSheet) {
    return { success: false, error: 'Sheet not found' };
  }
  
  const studentId = data.studentId;
  const action = data.action;
  const supervisor = data.supervisor;
  const bus = data.bus;
  const notes = data.notes || '';
  
  const sheetData = sheet.getDataRange().getValues();
  let rowFound = -1;
  
  for (let i = 1; i < sheetData.length; i++) {
    if (sheetData[i][0].toString().trim() === studentId.toString().trim()) {
      rowFound = i + 1;
      break;
    }
  }
  
  if (rowFound === -1) {
    return { success: false, error: 'Student not found' };
  }
  
  const now = new Date();
  const timeString = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  
  if (action === 'check-in') {
    sheet.getRange(rowFound, 8).setValue(timeString);
    sheet.getRange(rowFound, 10).setValue('In Bus');
  } else if (action === 'check-out') {
    sheet.getRange(rowFound, 9).setValue(timeString);
    sheet.getRange(rowFound, 10).setValue('Left');
  } else if (action === 'withdrawn') {
    sheet.getRange(rowFound, 10).setValue('Withdrawn');
  }
  
  logSheet.appendRow([
    now,
    studentId,
    sheetData[rowFound - 1][1],
    bus,
    supervisor,
    action,
    notes
  ]);
  
  return {
    success: true,
    message: action + ' recorded successfully',
    studentId: studentId,
    timestamp: timeString
  };
}

// ========================================================================
// SHIRT DISTRIBUTION (S / M / L / XL) — for shirt_distribution.html
//
// Requires 3 extra columns on the "Bus" sheet:
//   K = Shirt Size, L = Shirt Given At, M = Shirt Given By
// and 2 new sheets:
//   "Supervisors"    -> A: Name | B: Shirt Size | C: Shirt Given At | D: Shirt Given By
//   "ShirtInventory" -> A: Size | B: Initial Stock | C: Low Stock Threshold
//   "ShirtLog"       -> append-only audit trail (created automatically on first write)
//
// All reads (search, inventory levels) are done client-side via the public
// gviz/tq JSON feed, same as dashboard_v3.html. This is the only endpoint
// this feature needs on the backend — it just marks a shirt as handed out.
// ========================================================================

const STUDENTS_SHEET_NAME = 'Bus';
const SUPERVISORS_SHEET_NAME = 'Supervisors';
const SHIRT_LOG_SHEET_NAME = 'ShirtLog';

// entry point called from doPost when data.requestType === 'shirt'
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

// chosenSize is picked by the supervisor at hand-out time (the UI pre-fills it
// with the registered size, but it can be overridden). It always wins over the
// sheet's registered size, and the sheet is updated to reflect what was
// actually handed out.
function giveStudentShirt(ss, studentId, givenBy, chosenSize) {
  const sheet = ss.getSheetByName(STUDENTS_SHEET_NAME);
  if (!sheet) return { success: false, error: 'Bus sheet not found' };

  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0].toString().trim() === studentId) {
      const registeredSize = (values[i][10] || '').toString().trim().toUpperCase(); // column K
      const givenAt = values[i][11];                                                 // column L

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
      sheet.getRange(i + 1, 11).setValue(size);       // K - size actually handed out
      sheet.getRange(i + 1, 12).setValue(timeString); // L
      sheet.getRange(i + 1, 13).setValue(givenBy);    // M

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
  let logSheet = ss.getSheetByName(SHIRT_LOG_SHEET_NAME);
  if (!logSheet) {
    logSheet = ss.insertSheet(SHIRT_LOG_SHEET_NAME);
    logSheet.appendRow(['Timestamp', 'ID', 'Name', 'Type', 'Size', 'Given By', 'Note']);
  }
  logSheet.appendRow([new Date(), id, name, type, size, givenBy, note || '']);
}
