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
