const vm=require('vm'),fs=require('fs'),crypto=require('crypto');
const book={};
function mkSheet(rows){return{rows,getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),getLastRow:()=>rows.length,getLastColumn:()=>Math.max(...rows.map(r=>r.length),1),appendRow:(r)=>rows.push(r),
 getRange:(r,c,nr=1,nc=1)=>({setValue:(v)=>{rows[r-1]=rows[r-1]||[];rows[r-1][c-1]=v;},setValues:(vs)=>vs.forEach((row,i)=>{rows[r-1+i]=rows[r-1+i]||[];row.forEach((v,j)=>rows[r-1+i][c-1+j]=v);}),getValues:()=>{const o=[];for(let i=0;i<nr;i++){const row=[];for(let j=0;j<nc;j++)row.push((rows[r-1+i]||[])[c-1+j]??'');o.push(row);}return o;}})};}
const ss={getSheetByName:n=>book[n]||null,insertSheet:n=>(book[n]=mkSheet([[]]))};
const props={},cache={};
const ctx={console,Logger:{log:()=>{}},Date,
 SpreadsheetApp:{openById:()=>ss},
 CacheService:{getScriptCache:()=>({get:k=>cache[k]||null,put:(k,v)=>{cache[k]=v},remove:k=>{delete cache[k]}})},
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
vm.runInContext(fs.readFileSync(__dirname+'/../server/Auth.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Code.gs','utf8'),ctx);
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
post({action:'createUser',username:'Admin',password:'pw',fullName:'م',bootstrapSecret:secret});
const T=post({action:'login',username:'Admin',password:'pw'}).token;
post({action:'createUser',token:T,username:'sup1',password:'p1',fullName:'مشرف 1',role:'supervisor',assignedBus:'1'});
post({action:'createUser',token:T,username:'sup2',password:'p2',fullName:'مشرف 2',role:'supervisor',assignedBus:'2'});
post({action:'createUser',token:T,username:'lead',password:'p3',fullName:'القائد',role:'camp_leader'});
const t1=post({action:'login',username:'sup1',password:'p1'}).token,t2=post({action:'login',username:'sup2',password:'p2'}).token,tl=post({action:'login',username:'lead',password:'p3'}).token;
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
book.BusLive.rows[1][5]=new Date(Date.now()-10*60e3);
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
post({action:'createUser',token:T,username:'prt',password:'p5',fullName:'طباعة',role:'supervisor',permissions:['print'],committees:[]});
const tp=post({action:'login',username:'prt',password:'p5'}).token;r=post({action:'printList',token:tp});assert(r.success,'print permission works');
// ---- sheet check
r=post({action:'checkStudentSheet',token:T});assert(r.success&&r.report.ok&&r.report.total===4,'student sheet check passes');
console.log(fails?`\n${fails} FAILED`:'\nALL PASSED');
