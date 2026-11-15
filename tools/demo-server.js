const vm=require('vm'),fs=require('fs'),crypto=require('crypto');
const book={};
function mkSheet(rows){return{rows,getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}),getLastRow:()=>rows.length,getLastColumn:()=>Math.max(...rows.map(r=>r.length),1),appendRow:(r)=>rows.push(r),
 getRange:(r,c,nr=1,nc=1)=>({setValue:(v)=>{rows[r-1]=rows[r-1]||[];rows[r-1][c-1]=v;},setValues:(vs)=>vs.forEach((row,i)=>{rows[r-1+i]=rows[r-1+i]||[];row.forEach((v,j)=>rows[r-1+i][c-1+j]=v);}),getValues:()=>{const o=[];for(let i=0;i<nr;i++){const row=[];for(let j=0;j<nc;j++)row.push((rows[r-1+i]||[])[c-1+j]??'');o.push(row);}return o;}})};}
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
vm.runInContext(fs.readFileSync(__dirname+'/../server/Auth.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Code.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Custody.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Health.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Media.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Shirts.gs','utf8')+'\n'+fs.readFileSync(__dirname+'/../server/Reports.gs','utf8'),ctx);
// ---------- DEMO SERVER: the REAL server code + invented data. Never touches any real sheet. ----------
const U=['Username','PasswordHash','Salt','FullName','Role','AssignedBus','Active','FailedAttempts','LockedUntil','TokenEpoch','LastActivityAt','CreatedAt','LastLogin'];
book.Users=mkSheet([U]);book.Settings=mkSheet([['Key','Value']]);book.AuditLog=mkSheet([['Timestamp','ActorUsername','Action','TargetUsername','Details']]);
const first=['محمد','أحمد','علي','حسن','حسين','يوسف','إبراهيم','عبدالله','خالد','سالم','سعيد','ناصر','مصطفى','مهدي','صادق','جعفر','باقر','عباس','زيد','عمر','هلال','راشد','مازن','طارق','فهد'];
const mid=['سالم','ناصر','خالد','حمد','سعيد','علي','محمد','راشد'];
const teams=['الأزرق','الأحمر','الأخضر','الأصفر'],allergies={4:'فول سوداني',11:'حليب، بيض',17:'مكسرات',23:'فول سوداني',31:'سمك',38:'بيض'};
const rows=[['Class','Name','Bus number','Student ID','Team name','Contact number','Photo URL','Food allergy','Shirt size']];
const sizes=['S','M','M','L','XL','M','L','S'];
for(let i=0;i<48;i++){rows.push([String(5+(i%4)),first[i%first.length]+' '+mid[(i*3)%mid.length]+' '+first[(i*7+3)%first.length],String(1+(i%4)),String(751+i*3),teams[(i*5)%4],'9999'+String(1000+i),'',allergies[i]||'',sizes[i%sizes.length]]);}
book.Bus=mkSheet(rows);
const run=(c)=>vm.runInContext(c,ctx);
const post=(o)=>JSON.parse(run('doPost')({postData:{contents:JSON.stringify(o)}}).t);
run('SETUP_createTabs')();
post({action:'createUser',username:'admin',password:'demo-1234',fullName:'مدير النظام (تجريبي)',bootstrapSecret:run('getBootstrapSecret_()')});
const T=post({action:'login',username:'admin',password:'demo-1234'}).token;
const mk=(u,n,role,bus,perms)=>post({action:'createUser',token:T,username:u,password:'demo-1234',fullName:n,role:role,assignedBus:bus||'',permissions:perms||undefined,committees:[]});
mk('sup1','مشرف الباص 1','supervisor','1');mk('sup2','مشرف الباص 2','supervisor','2');mk('sup3','مشرف الباص 3','supervisor','3');mk('sup4','مشرف الباص 4','supervisor','4');
mk('leader','قائد المخيم','camp_leader','',['dashboard','stats','allbuses']);mk('secr','السكرتارية','supervisor','',['reports','custody','print']);
mk('doctor','الطبيب','supervisor','',['medical']);mk('nutri','لجنة التغذية','supervisor','',['nutrition']);mk('scout','لجنة الكشافة','supervisor','',['gate']);mk('media','اللجنة الإعلامية','supervisor','',['announce','results','verify']);
const tok=u=>post({action:'login',username:u,password:'demo-1234'}).token;
const tokS=[1,2,3,4].map(i=>tok('sup'+i));
// settings
post({action:'setCampLocation',token:T,lat:23.6665718,lng:58.0084995});
const day=new Date(Date.now()+4*3600e3).toISOString().slice(0,10);
// boarding: most students on their bus, a few missing
const ids=rows.slice(1).map(r=>r[3]);
rows.slice(1).forEach((r,i)=>{ if(i%9===5) return; post({action:'scan',token:tokS[Number(r[2])-1],studentId:r[3],op:'board',method:'qr',clientId:'d'+i}); });
[[1,23.612,58.31,'onway',17],[2,23.640,58.15,'onway',20],[3,23.668,58.02,'arrived',2],[4,23.55,58.45,'departed',0]].forEach(b=>post({action:'busStatus',token:tokS[b[0]-1],status:b[3],lat:b[1],lng:b[2],acc:10,speed:b[4]}));
// nutrition / medical / custody-withdrawal / media
post({action:'nutritionSetStaff',token:T,count:34});
book.Staff.rows.push(['مشرف أول','L',''],['مشرف ثانٍ','M',''],['منسق الفعاليات','XL',''],['مسؤول التغذية','M','']);
[['S',12,3],['M',24,4],['L',14,3],['XL',6,2]].forEach(x=>post({action:'shirtStockSet',token:T,size:x[0],total:x[1],lowAt:x[2]}));
[0,1,2,3,4,5,6,7,8,9,10,11,12,13].forEach(i=>post({action:'shirtGive',token:T,kind:'student',id:ids[i],clientId:'sh'+i}));
const tm=tok('media'),td=tok('doctor'),tn=tok('nutri');
let r=post({action:'medOpen',token:td,studentId:ids[7],complaint:'صداع وحرارة خفيفة',severity:'normal',clientId:'m1'});
r=post({action:'medOpen',token:td,studentId:ids[20],complaint:'التواء بسيط في القدم',severity:'urgent',clientId:'m2'});
r=post({action:'medOpen',token:td,studentId:ids[33],complaint:'ألم في البطن',severity:'normal',clientId:'m3'});post({action:'medClose',token:td,id:r.id,treatment:'راحة وماء دافئ'});
r=post({action:'withdrawStart',token:T,studentId:ids[13],guardian:'والده (أبو سالم)',reason:'ظرف عائلي طارئ',clientId:'w1'});
const prayers=(d,v)=>post({action:'prayerSave',token:tm,date:d,times:v,iqamaMinutes:15});
for(let k=0;k<5;k++){const d=new Date(Date.now()+4*3600e3+k*864e5).toISOString().slice(0,10);prayers(d,{fajr:'05:28',dhuhr:'12:10',asr:'15:10',maghrib:'17:30',isha:'18:46'});}
const ann=(o)=>{const a=post(Object.assign({action:'annSave',token:tm,audience:'public'},o));if(a.success)post({action:'annStatus',token:tm,id:a.id,status:'published'});};
const at=(mins)=>new Date(Date.now()+mins*60000).toISOString();
ann({title:'سباق التتابع',body:'الملعب الرئيسي',kind:'event',startsAt:at(40)});ann({title:'المسابقة الثقافية',body:'القاعة الكبرى',kind:'event',startsAt:at(190)});ann({title:'عرض المسرحية',body:'المسرح',kind:'event',startsAt:at(330)});
ann({title:'الغداء يبدأ الساعة 1:00 ظهرًا',body:'في القاعة الرئيسية',kind:'announce'});ann({title:'فريق الأخضر ساعد في تنظيف الساحة بعد الفعالية',body:'شكرًا لهم',kind:'kudos'});
ann({title:'وَتَعَاوَنُوا عَلَى الْبِرِّ وَالتَّقْوَى',body:'سورة المائدة: 2',kind:'wisdom'});ann({title:'أهلاً بأبطال المخيم',body:'يومكم مليء بالخير',kind:'greeting'});
ann({title:'الحفل الختامي',body:'الساحة الكبرى',kind:'finale',startsAt:at(60*24*3+120)});
ann({title:'الطالب رقم 757',body:'يُرجى مراجعة السكرتارية',kind:'call'});
const tv=tm;[['سباق التتابع','الأزرق',1,30],['سباق التتابع','الأخضر',2,25],['سباق التتابع','الأحمر',3,20],['كرة القدم','الأخضر',1,40],['كرة القدم','الأزرق',2,30],['كرة القدم','الأصفر',3,20],['المسابقة الثقافية','الأحمر',1,35],['المسابقة الثقافية','الأخضر',2,30]].forEach(x=>{const q=post({action:'resSave',token:tm,competition:x[0],team:x[1],place:x[2],points:x[3],clientId:'r'+x.join('')});post({action:'resStatus',token:tm,id:q.id,status:'published'});});
const feedKey=run('ADMIN_createFeedKey')();
require('fs').writeFileSync(__dirname+'/.demo-feed-key',feedKey);
const http=require('http');
http.createServer((req,res)=>{const h={'access-control-allow-origin':'*','access-control-allow-headers':'*','content-type':'application/json'};
 if(req.method==='OPTIONS'){res.writeHead(204,h);return res.end();}
 let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{const out=req.method==='POST'?run('doPost')({postData:{contents:b}}):run('doGet')();res.writeHead(200,h);res.end(out.t);}catch(e){res.writeHead(500,h);res.end(JSON.stringify({success:false,error:String(e)}));}});
}).listen(8790,()=>console.log('demo server ready on 8790'));
