import catalog from './catalog.mjs';
const kinds=['people','courses','sessions','attendance','scores','issues'];
const results=['ผ่าน','ไม่ผ่าน'];
const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
class Problem extends Error{constructor(s,m){super(m);this.status=s;}}
function check(ok,msg,status=400){if(!ok)throw new Problem(status,msg);}
function str(value,max=250){return typeof value==='string'?value.trim().slice(0,max):'';}
const id=()=>crypto.randomUUID();
const today=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10);
const decode=row=>row?JSON.parse(row.body):null;
const get=async(db,k,key)=>decode(await db.prepare('SELECT body FROM passport_records WHERE kind=? AND id=?').bind(k,key).first());
const select=async(db,k)=> (await db.prepare('SELECT body FROM passport_records WHERE kind=? ORDER BY id').bind(k).all()).results.map(decode);
const byToken=async(db,k,t)=>t?decode(await db.prepare("SELECT body FROM passport_records WHERE kind=? AND json_extract(body,'$.token')=?").bind(k,t).first()):null;
const insert=(db,k,r)=>db.prepare('INSERT INTO passport_records(kind,id,body) VALUES(?,?,?)').bind(k,r.id,JSON.stringify(r));
let ready;
async function init(db){
 if(ready===db)return;
 await db.prepare('CREATE TABLE IF NOT EXISTS passport_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id))').run();
 await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS pp_token ON passport_records(kind,json_extract(body,'$.token')) WHERE json_extract(body,'$.token') IS NOT NULL").run();
 await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS pp_present ON passport_records(json_extract(body,'$.session'),json_extract(body,'$.person')) WHERE kind='attendance'").run();
 ready=db;
}
function visible(user,p){return p && (user.role==='admin'||(user.role==='lead'&&p.site===user.dc&&p.department===user.dept)||p.id===user.login);}
function safeCourse(c){return {id:c.id,topic:c.topic,type:c.type,document:c.document,revision:c.revision,pass:c.pass,active:c.active,version:c.version,max:c.max,questions:(c.questions||[]).map(({title,choices,points,kind,required})=>({title,choices,points,kind,required}))};}
function safeSession(s){return {id:s.id,topic:s.topic,revision:s.revision,date:s.date,start:s.start,end:s.end,status:s.status,location:s.location};}
function open(s){return s&&s.status==='Open'&&s.start<=Date.now()&&Date.now()<s.end;}
function courseList(rows){
 const map=new Map(catalog.map(c=>[c.id,{id:c.id,topic:c.topic,type:'Training',document:c.id,active:true,pass:c.passScore,max:c.maxScore,questions:[]}]));
 for(const r of rows){map.set(r.id,{...map.get(r.id),...r});}return [...map.values()];
}
async function history(db,p,includeWI=true){
 const records=(await db.prepare("SELECT body FROM passport_records WHERE kind IN ('attendance','scores') AND json_extract(body,'$.person')=?").bind(p.id).all()).results.map(decode);
 const wi=includeWI?(await db.prepare("SELECT t.day AS date,r.code AS topic,r.rev AS revision,t.result,t.trainer FROM training t JOIN revs r ON r.id=t.revision WHERE t.employee=?").bind(p.id).all()).results.map(x=>({...x,source:'WI'})):[];
 return {person:{id:p.id,name:p.name,department:p.department,plate:p.plate},history:[...records,...wi].map(({topic,date,revision,result,source,score,max,trainer})=>({topic,date,revision,result,source,score,max,trainer})).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')))};
}
function requireAdmin(user){check(user?.role==='admin','เฉพาะผู้ดูแล DCC',403);}
async function index(db,user){
 const [people,courses,sessions]=await Promise.all(['people','courses','sessions'].map(k=>select(db,k)));
 const admin=user.role==='admin';
 return {people:people.filter(p=>visible(user,p)).map(({id,name,plate,department,site,active,token})=>({id,name,plate,department,site,active,token:admin?token:undefined})),
 courses:courseList(courses).map(c=>admin?c:safeCourse(c)),sessions:sessions.map(s=>admin?s:safeSession(s)).sort((a,b)=>b.start-a.start),
 pending:admin?[...await select(db,'attendance'),...await select(db,'scores')].filter(r=>r.result==='รอตรวจสอบ'):[],
 issues:admin?await select(db,'issues'):[],admin};
}
async function recordCheckin(db,body){
 const session=await byToken(db,'sessions',str(body.token));check(open(session),'รอบนี้ยังไม่เปิดหรือปิดรับลงชื่อแล้ว');
 let p;
 if(body.external){
  const name=str(body.name),company=str(body.company),plate=str(body.plate,60);
  check(name&&company&&plate,'กรอกชื่อ บริษัท และทะเบียนรถ (กรณีไม่มี ให้กรอก ไม่มี)');
  const key=JSON.stringify([company,name].map(x=>x.normalize('NFC').toLowerCase().replace(/\s/g,'')));
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
  const extId='EXT-'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  p={id:extId,name,company,plate,department:company,site:'',active:true,token:id()};
 }else{
  p=await get(db,'people',str(body.person));check(p&&p.active!==false&&p.name.replace(/\s/g,'')===str(body.name).replace(/\s/g,''),'ชื่อหรือรหัสพนักงานไม่ตรงกับทะเบียน');
 }
 const r={id:id(),session:session.id,person:p.id,name:p.name,topic:session.topic,revision:session.revision,date:session.date,result:'รอตรวจสอบ',checked:Date.now(),source:'รอบอบรม'};
 const writes=[];
 if(body.external)writes.push(db.prepare("INSERT INTO passport_records VALUES('people',?,?) ON CONFLICT(kind,id) DO UPDATE SET body=json_set(passport_records.body,'$.plate',json_extract(excluded.body,'$.plate'))").bind(p.id,JSON.stringify(p)));
 writes.push(db.prepare("INSERT INTO passport_records SELECT 'attendance',?,? WHERE EXISTS(SELECT 1 FROM passport_records WHERE kind='sessions' AND id=? AND json_extract(body,'$.status')='Open' AND json_extract(body,'$.start')<=? AND json_extract(body,'$.end')>?)").bind(r.id,JSON.stringify(r),session.id,Date.now(),Date.now()));
 const done=await db.batch(writes);check(done.at(-1).meta.changes===1,'ปิดรับลงชื่อแล้ว',409);return {message:'ลงชื่อแล้ว รอผู้ฝึกอบรมตรวจผล'};
}
async function write(db,user,b){
 if(b.action==='checkin')return recordCheckin(db,b);
 if(b.action==='take'){
  const c=courseList(await select(db,'courses')).find(x=>x.id===b.course);
  check(c&&c.active!==false&&c.questions?.length,'หลักสูตรนี้ยังไม่เปิดแบบทดสอบ');
  const p=b.card?await byToken(db,'people',str(b.card)):await get(db,'people',user.login);
  check(p&&p.active!==false,'กรุณาใช้ Passport ประจำตัว หรือจับคู่รหัส WI กับทะเบียนพนักงาน');
  check(b.version===c.version,'แบบทดสอบเปลี่ยนแปลง กรุณาเปิดใหม่',409);
  check(Array.isArray(b.answers)&&b.answers.length===c.questions.length,'กรุณาตอบให้ครบ');
  let score=0,manual=false;
  c.questions.forEach((q,i)=>{
    const a=b.answers[i];
    if(q.kind==='text'||q.kind==='paragraph'){
      check(typeof a==='string'&&a.length<=5000&&(!q.required||a.trim()),'กรุณาตอบข้อ '+(i+1));
      if(q.points>0)manual=true;
    }else{
      check(Array.isArray(a)&&(!q.required||a.length)&&a.every(n=>Number.isInteger(n)&&n>=0&&n<q.choices.length)&&new Set(a).size===a.length&&(q.kind==='checkbox'||a.length<=1),'ตรวจคำตอบข้อ '+(i+1));
      if(q.points&&!q.correct.length)manual=true;
      if(q.correct.length&&a.length===q.correct.length&&q.correct.every(n=>a.includes(n)))score+=q.points;
    }
  });
  const result=manual||c.pass===null?'รอตรวจสอบ':score>=c.pass?'ผ่าน':'ไม่ผ่าน';
  const r={id:id(),person:p.id,name:p.name,topic:c.topic,revision:c.revision,date:today(),source:'แบบทดสอบ',score,max:c.questions.reduce((n,q)=>n+q.points,0),result,course:c.id,version:c.version,checked:Date.now(),answers:b.answers,questionTitles:c.questions.map(q=>q.title),answerText:c.questions.map((q,i)=>Array.isArray(b.answers[i])?b.answers[i].map(n=>q.choices[n]).join(', '):b.answers[i])};
  await insert(db,'scores',r).run();return {message:r.result+' · '+score+'/'+r.max+' คะแนน'};
 }
 requireAdmin(user);
 if(b.action==='import'){
  check(kinds.includes(b.kind)&&Array.isArray(b.rows)&&b.rows.length>0&&b.rows.length<=40,'ชุดนำเข้าไม่ถูกต้อง');
  const rows=b.rows.map(row=>{check(typeof row.id==='string'&&row.id.length&&row.id.length<=512,'ไม่พบรหัสรายการ');if((b.kind==='people'||b.kind==='sessions')&&!row.token)row.token=id();return db.prepare('INSERT INTO passport_records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO NOTHING').bind(b.kind,row.id,JSON.stringify(row));});
  const done=await db.batch(rows);return {added:done.reduce((n,r)=>n+r.meta.changes,0)};
 }
 if(b.action==='person'){
  const key=str(b.id),name=str(b.name),department=str(b.department);check(key&&name&&department,'กรอกรหัส ชื่อ และแผนก');
  const previous=await get(db,'people',key);check(b.edit?!!previous:!previous,'รหัสพนักงานซ้ำหรือไม่พบรายการเดิม',409);
  const r={...previous,id:key,name,department,site:str(b.site),plate:str(b.plate),active:b.active!==false,token:previous?.token||id()};
  if(previous)await db.prepare("UPDATE passport_records SET body=? WHERE kind='people' AND id=?").bind(JSON.stringify(r),key).run();
  else await insert(db,'people',r).run();return {};
 }
 if(b.action==='course'){
  const key=str(b.id),topic=str(b.topic,1000);check(key&&topic,'กรอกรหัสและหัวข้อ');
  const prev=await get(db,'courses',key);check(b.edit||!prev,'รหัสหลักสูตรซ้ำ',409);
  let r={...prev,id:key,topic,type:str(b.type),document:str(b.document)||key,revision:str(b.revision),active:true};
  if(b.questions!==undefined){
   check(Array.isArray(b.questions)&&b.questions.length<=100,'แบบทดสอบไม่ถูกต้อง');
   const qs=b.questions.map(q=>{
    const kind=q.kind||'single',choices=q.choices||[],correct=q.correct||[];
    check(str(q.title,1000)&&['single','checkbox','text','paragraph'].includes(kind)&&Number.isInteger(q.points)&&q.points>=0&&q.points<=100,'ตรวจคำถามและคะแนน');
    check(Array.isArray(choices)&&choices.length<=100&&choices.every(x=>str(x,1000))&&Array.isArray(correct)&&correct.every(n=>Number.isInteger(n)&&n>=0&&n<choices.length),'ตรวจตัวเลือกและเฉลย');
    if(kind==='single'||kind==='checkbox')check(choices.length>=1,'กรุณาระบุตัวเลือก');
    return {title:str(q.title,1000),kind,choices:choices.map(x=>str(x,1000)),correct,points:q.points,required:q.required!==false};
   });
   const max=qs.reduce((n,q)=>n+q.points,0);check(b.pass===null||(Number.isInteger(b.pass)&&b.pass>=0&&b.pass<=max),'เกณฑ์ผ่านเกินคะแนนเต็ม');
   r={...r,questions:qs,pass:b.pass,max,version:id()};
  }
  await db.prepare("INSERT INTO passport_records VALUES('courses',?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").bind(key,JSON.stringify(r)).run();return {};
 }
 if(b.action==='session'){
  const c=courseList(await select(db,'courses')).find(c=>c.id===b.course&&c.active!==false),start=Date.parse(b.start+'+07:00'),end=Date.parse(b.end+'+07:00');
  check(c&&Number.isFinite(start)&&end>start,'เลือกหัวข้อและเวลาปิดหลังเวลาเปิด');
  await insert(db,'sessions',{id:'TN-'+id().slice(0,12),course:c.id,topic:c.topic,revision:c.revision||'',date:b.start.slice(0,10),start,end,status:'Open',location:str(b.location),trainer:user.login,token:id()}).run();return {};
 }
 if(b.action==='resolve'){
  const done=await db.prepare("UPDATE passport_records SET body=json_patch(body,?) WHERE kind='issues' AND id=?").bind(JSON.stringify({resolution:str(b.remark,1000),reviewer:user.login,reviewed:Date.now()}),str(b.id,512)).run();
  check(done.meta.changes===1,'ไม่พบรายการ',404);return {};
 }
 if(b.action==='close'||b.action==='review'){
  const session=b.action==='close';
  if(!session)check(results.includes(b.result),'ผลอบรมไม่ถูกต้อง');
  const patch=session?{status:'Closed'}:{result:b.result,trainer:user.login,reviewed:Date.now(),remark:str(b.remark,1000)};
  if(!session&&b.kind==='scores'&&b.score!=null){
    const old=await get(db,'scores',str(b.id));check(old&&Number.isFinite(b.score)&&b.score>=0&&b.score<=old.max,'คะแนนผลตรวจไม่ถูกต้อง');
    patch.score=b.score;
  }
  const done=await db.prepare("UPDATE passport_records SET body=json_patch(body,?) WHERE kind=? AND id=? AND json_extract(body,?)=?").bind(JSON.stringify(patch),session?'sessions':b.kind==='scores'?'scores':'attendance',str(b.id),session?'$.status':'$.result',session?'Open':'รอตรวจสอบ').run();
  check(done.meta.changes===1,'รายการเปลี่ยนแปลงแล้ว กรุณาโหลดใหม่',409);return {};
 }
 throw new Problem(400,'คำสั่งไม่ถูกต้อง');
}
export async function passportAPI(req,db,user){
 try{
  await init(db);
  const url=new URL(req.url),mode=url.searchParams.get('mode');
  if(req.method==='GET'){
   if(mode==='quiz' && url.searchParams.get('p')){const p=await byToken(db,'people',str(url.searchParams.get('p')));check(p&&p.active!==false,'ไม่พบ Passport',404);return json({courses:courseList(await select(db,'courses')).filter(c=>c.questions?.length).map(safeCourse)});}
   if(mode==='session'){const s=await byToken(db,'sessions',str(url.searchParams.get('s')));check(s,'ไม่พบรอบอบรม',404);return json(safeSession(s));}
   if(mode==='card'){const p=await byToken(db,'people',str(url.searchParams.get('p')));check(p&&p.active!==false,'ไม่พบ Passport',404);return json(await history(db,p,false));}
   check(user,'กรุณาเข้าสู่ระบบ',401);
   if(mode==='history'){const p=await get(db,'people',str(url.searchParams.get('id'),512));check(visible(user,p),'ไม่พบพนักงานในขอบเขตสิทธิ์',404);return json(await history(db,p));}
   return json(await index(db,user));
  }
  check(req.method==='POST'&&req.headers.get('X-WI-Request')==='1'&&req.headers.get('Content-Type')==='application/json','คำขอไม่ถูกต้อง',403);
  const b=await req.json();check(user||b.action==='checkin'||(b.action==='take'&&b.card),'กรุณาเข้าสู่ระบบ',401);
  return json(await write(db,user,b));
 }catch(e){return json({error:e.status?e.message:/UNIQUE constraint/i.test(String(e))?'รายการซ้ำหรือเคยลงชื่อแล้ว':'ทำรายการ Passport ไม่สำเร็จ'},e.status||(/UNIQUE constraint/i.test(String(e))?409:500));}
}
