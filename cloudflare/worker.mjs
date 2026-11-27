import {passportAPI} from './passport.mjs';
const encoder = new TextEncoder();
const maxPdf = 12 * 1024 * 1024;
const headers = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'};
class HttpError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
function requireValue(condition,message,status=400){
  if(!condition) throw new HttpError(status,message);
}
function field(obj,key,max=300){
  const v=obj[key];
  requireValue(typeof v==='string' && v.trim() && v.length<=max,'กรุณาตรวจสอบ '+key);
  return v.trim();
}
function date(obj,key){
  const s=field(obj,key);
  const time=Date.parse(s+'T00:00:00Z');
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(time) && new Date(time).toISOString().slice(0,10)===s,'วันที่ไม่ถูกต้อง');
  return s;
}
function statement(db,sql,...args){return db.prepare(sql).bind(...args);}
function response(body,status=200,extra={}){return new Response(body,{status,headers:{...headers,...extra}});}
// Each schema statement is idempotent, including the revision-order trigger.
const initialSchema = [
  "CREATE TABLE IF NOT EXISTS users(login TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','lead','employee')), dc TEXT NOT NULL, dept TEXT NOT NULL, salt TEXT NOT NULL, digest TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS docs(code TEXT PRIMARY KEY,title TEXT NOT NULL,dc TEXT NOT NULL,dept TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS revs(id INTEGER PRIMARY KEY,code TEXT NOT NULL REFERENCES docs(code),rev INTEGER NOT NULL,effective TEXT NOT NULL,summary TEXT NOT NULL,retrain INTEGER NOT NULL,creator TEXT NOT NULL REFERENCES users(login),approved TEXT REFERENCES users(login),object_key TEXT NOT NULL UNIQUE,UNIQUE(code,rev));",
  "CREATE TRIGGER IF NOT EXISTS enforce_revision_order BEFORE INSERT ON revs WHEN EXISTS(SELECT 1 FROM revs WHERE code=NEW.code AND (rev>=NEW.rev OR effective>NEW.effective)) BEGIN SELECT RAISE(ABORT,'revision order'); END;",
  "CREATE TABLE IF NOT EXISTS training(id INTEGER PRIMARY KEY,employee TEXT NOT NULL REFERENCES users(login),revision INTEGER NOT NULL REFERENCES revs(id),day TEXT NOT NULL,trainer TEXT NOT NULL REFERENCES users(login),result TEXT NOT NULL);"
];
let initializedDB;
async function prepareDatabase(db){
  requireValue(db && typeof db.prepare==='function','ไม่พบ D1 binding ชื่อ DB ใน Worker',503);
  if(initializedDB===db)return;
  const objects=await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE (type='table' AND name IN ('users','docs','revs','training')) OR (type='trigger' AND name='enforce_revision_order')").first();
  if(objects.n!==5){
    for(const sql of initialSchema)await db.prepare(sql).run();
  }
  initializedDB=db;
}
async function pdfOperation(action){
  try{return await action();}catch{throw new HttpError(503,'เข้าถึงไฟล์ PDF ไม่สำเร็จ กรุณาตรวจ R2 binding ชื่อ PDFS');}
}
function hex(bytes){
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
async function passwordDigest(password,salt){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:100000,salt},key,256);
  return hex(bits);
}
function setupPage(body,status=200){
  return response('<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ตั้งค่าบัญชี DCC</title><main style="max-width:32rem;margin:8vh auto;padding:1rem;font:18px/1.6 system-ui"><h1>ตั้งค่าบัญชี DCC</h1>'+body+'</main></html>',status,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'","Referrer-Policy":"same-origin"});
}
async function setup(req,env){
  if(await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first()){
    return setupPage('<p>มีบัญชีในระบบแล้ว</p><a href="/">เข้าสู่ระบบ WI</a>');
  }
  const secret=env.WI_SETUP_KEY;
  if(typeof secret!=='string'){
    return setupPage('<p>Worker เวอร์ชันที่เปิดอยู่นี้ยังไม่ได้รับค่า <b>WI_SETUP_KEY</b></p><p>เปิด Cloudflare → Workers &amp; Pages → wi-training-center → Settings → Variables and Secrets ตรวจชื่อ WI_SETUP_KEY ใน Production ถ้ามีอยู่แล้ว ให้ตรวจใน Deployments ว่าเวอร์ชันที่บันทึก Secret ถูก Deploy แล้ว จากนั้นรีเฟรชหน้านี้</p>',503);
  }
  if(secret.length<16){
    return setupPage('<p>พบ WI_SETUP_KEY แล้ว แต่รหัสตั้งค่าสั้นกว่า 16 ตัวอักษร</p><p>เปิด Settings → Variables and Secrets กด <b>Rotate</b> ในแถว WI_SETUP_KEY กรอกรหัสใหม่อย่างน้อย 16 ตัวอักษร กด Deploy แล้วรีเฟรชหน้านี้</p>',503);
  }
  if(req.method==='GET')return setupPage('<form method="post" action="/setup"><p>ชื่อผู้ใช้ <b>dcc</b></p><p><label>รหัสตั้งค่าจาก Cloudflare<br><input type="password" name="token" required autocomplete="off"></label></p><p><label>ตั้งรหัสผ่านสำหรับเข้าเว็บ WI (อย่างน้อย 12 ตัว)<br><input type="password" name="password" required minlength="12" maxlength="128" autocomplete="new-password"></label></p><p><label>ยืนยันรหัสผ่าน<br><input type="password" name="confirm" required autocomplete="new-password"></label></p><button>สร้างบัญชี DCC</button></form>');
  requireValue(req.method==='POST','Method not allowed',405);
  const origin=req.headers.get('Origin');
  const sameOriginNavigation=(origin===null || origin==='null') && req.headers.get('Sec-Fetch-Site')==='same-origin';
  requireValue(origin===new URL(req.url).origin || sameOriginNavigation,'โปรดเปิด /setup ในแท็บใหม่ แล้วส่งแบบฟอร์มอีกครั้ง',403);
  requireValue(req.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded'),'รูปแบบข้อมูลไม่ถูกต้อง');
  requireValue(Number(req.headers.get('Content-Length')??0)<=8192,'ข้อมูลใหญ่เกินกำหนด',413);
  const form=new URLSearchParams(await req.text());
  const token=form.get('token')||'';
  const hash=value=>crypto.subtle.digest('SHA-256',encoder.encode(value));
  const [given,expected]=await Promise.all([hash(token),hash(secret)]);
  let diff=0;
  const a=new Uint8Array(given),b=new Uint8Array(expected);
  for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  requireValue(diff===0,'รหัสตั้งค่าไม่ตรงกับ WI_SETUP_KEY',403);
  const password=form.get('password');
  requireValue(password && password.length>=12 && password.length<=128 && password===form.get('confirm') && password!==token,'กรุณาตั้งรหัสผ่านใหม่ 12–128 ตัวให้ต่างจากรหัสตั้งค่า และยืนยันให้ตรงกัน');
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const digest=await passwordDigest(password,salt);
  const result=await statement(env.DB,"INSERT INTO users(login,name,role,dc,dept,salt,digest) SELECT 'dcc','Document Control','admin','PTT DC','QS',?,? WHERE NOT EXISTS(SELECT 1 FROM users)",hex(salt),digest).run();
  requireValue(result.meta.changes===1,'มีบัญชีในระบบแล้ว',409);
  return setupPage('<p>สร้างบัญชี <b>dcc</b> แล้ว ใช้รหัสผ่านที่เพิ่งตั้งเพื่อเปิดคลัง WI</p><a href="/">เข้าสู่ระบบ WI</a>');
}
async function authenticate(req,db){
  const raw=req.headers.get('Authorization') || '';
  if(!raw.startsWith('Basic ')) return null;
  let credentials;
  try{credentials=new TextDecoder().decode(Uint8Array.from(atob(raw.slice(6)),c=>c.charCodeAt(0)));}catch{return null;}
  const split=credentials.indexOf(':');
  if(split<1)return null;
  const user=await statement(db,'SELECT * FROM users WHERE login=?',credentials.slice(0,split)).first();
  if(!user){
    const existing=await db.prepare('SELECT 1 FROM users LIMIT 1').first();
    if(!existing)throw new HttpError(503,'เตรียมฐานข้อมูล WI แล้ว กรุณาให้ผู้ดูแลสร้างบัญชี DCC แรกใน D1 ตามคู่มือ');
    return null;
  }
  const salt=Uint8Array.from(user.salt.match(/../g),v=>parseInt(v,16));
  const digest=await passwordDigest(credentials.slice(split+1),salt);
  let diff=digest.length^user.digest.length;
  for(let i=0;i<digest.length;i++)diff|=digest.charCodeAt(i)^user.digest.charCodeAt(i);
  return diff===0?user:null;
}
async function snapshot(db,user,today){
  const conditions={admin:['1=1'],employee:['u.login=?',user.login],lead:['u.dc=? AND u.dept=?',user.dc,user.dept]};
  const [scope,...args]=conditions[user.role];
  const results=await db.batch([
    db.prepare('SELECT * FROM docs ORDER BY code'),
    db.prepare('SELECT id,code,rev,effective,summary,retrain,creator,approved FROM revs ORDER BY rev DESC'),
    statement(db,'SELECT login,name,dc,dept FROM users u WHERE '+scope+' ORDER BY name',...args),
    statement(db,'SELECT t.*,r.code,r.rev FROM training t JOIN revs r ON r.id=t.revision JOIN users u ON u.login=t.employee WHERE '+scope+' ORDER BY day DESC,t.id DESC',...args)
  ]);
  const [docs,revs,employees,history]=results.map(r=>r.results);
  const current=new Map(),minimum=new Map(),passed=new Map();
  for(const r of revs){
    if(!r.approved)r.status='รออนุมัติ';
    else if(r.effective>today)r.status='รอวันที่มีผล';
    else{
      r.status=current.has(r.code)?'ยกเลิกใช้แล้ว':'ใช้งาน';
      if(!current.has(r.code))current.set(r.code,r);
      if(r.retrain && !minimum.has(r.code))minimum.set(r.code,r.rev);
    }
  }
  for(const r of history){
    const key=JSON.stringify([r.employee,r.code]);
    if(r.result==='ผ่าน')passed.set(key,Math.max(r.rev,passed.get(key)??-1));
  }
  const tasks=[];
  for(const d of docs){
    if(!current.has(d.code))continue;
    for(const e of employees){
      if(!['*',e.dc].includes(d.dc)||!['*',e.dept].includes(d.dept))continue;
      const score=passed.get(JSON.stringify([e.login,d.code]))??-1;
      tasks.push({employee:e.login,name:e.name,code:d.code,rev:current.get(d.code).rev,status:score<0?'รออบรม':score<(minimum.get(d.code)??0)?'รออบรมซ้ำ':'ผ่านแล้ว'});
    }
  }
  return {docs,revs,employees,history,tasks,today,user:{login:user.login,name:user.name,role:user.role}};
}
async function upload(env,user,obj){
  const db=env.DB,code=field(obj,'code',64).toUpperCase(),rev=Number(obj.rev);
  requireValue(/^[A-Z0-9][A-Z0-9_.-]*$/.test(code)&&Number.isSafeInteger(rev)&&rev>=0,'ตรวจสอบรหัสและเลข Rev.');
  const day=date(obj,'effective'),summary=field(obj,'summary',2000);
  requireValue(typeof obj.pdf==='string' && obj.pdf.length<=4*maxPdf/3,'PDF ต้องมีขนาดไม่เกิน 12 MB');
  let bytes;
  try{bytes=Uint8Array.from(atob(obj.pdf),c=>c.charCodeAt(0));}catch{throw new HttpError(400,'ข้อมูล PDF ไม่ถูกต้อง');}
  requireValue(new TextDecoder().decode(bytes.slice(0,5))==='%PDF-','โปรดเลือกไฟล์ PDF');
  const writes=[];
  if(!await statement(db,'SELECT 1 FROM docs WHERE code=?',code).first()){
    writes.push(statement(db,'INSERT INTO docs VALUES(?,?,?,?)',code,field(obj,'title'),field(obj,'dc'),field(obj,'dept')));
  }
  const key=crypto.randomUUID()+'.pdf';
  writes.push(statement(db,'INSERT INTO revs(code,rev,effective,summary,retrain,creator,object_key) VALUES(?,?,?,?,?,?,?)',code,rev,day,summary,obj.retrain?1:0,user.login,key));
  await pdfOperation(()=>env.PDFS.put(key,bytes));
  try{await db.batch(writes);}catch(err){
    if(/revision order|UNIQUE constraint/i.test(String(err))){
      await env.PDFS.delete(key);
      throw new HttpError(409,'ตรวจสอบเลข Rev. และวันที่มีผล อาจมีการบันทึกฉบับนี้แล้ว');
    }
    throw err;
  }
}
async function train(db,user,obj,today){
  const day=date(obj,'day'),employee=field(obj,'employee');
  requireValue(day<=today && ['ผ่าน','ไม่ผ่าน'].includes(obj.result),'ตรวจสอบวันที่และผลอบรม');
  const result=await statement(db,`INSERT INTO training(employee,revision,day,trainer,result)
    SELECT u.login,r.id,?,?,? FROM users u JOIN revs r ON r.id=? WHERE u.login=?
    AND (?='admin' OR (u.dc=? AND u.dept=?)) AND r.id=(SELECT id FROM revs
    WHERE code=r.code AND approved IS NOT NULL AND effective<=? ORDER BY rev DESC LIMIT 1)`,
    day,user.login,obj.result,Number(obj.id),employee,user.role,user.dc,user.dept,day).run();
  requireValue(result.meta.changes===1,'ตรวจสอบพนักงานและ Rev. ที่มีผลในวันที่อบรม');
}
// This helper runs in the administrator's browser. Only D1 Console can apply its output.
function recoverPage(){
  const nonce=crypto.randomUUID().replaceAll('-','');
  const script=`const encoder=new TextEncoder();
function hex(bytes){
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
async function passwordDigest(password,salt){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:100000,salt},key,256);
  return hex(bits);
}

  const form=document.querySelector('form');
  const output=document.querySelector('textarea');
  const message=document.querySelector('[role="status"]');
  form.addEventListener('input',()=>{output.value='';message.textContent='';});
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const password=form.elements.password.value;
    if(password!==form.elements.confirm.value){
      message.textContent='รหัสผ่านทั้งสองช่องต้องตรงกัน';
      return;
    }
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const digest=await passwordDigest(password,salt);
    output.value="UPDATE users SET salt='"+hex(salt)+"', digest='"+digest+"' WHERE login='dcc' AND role='admin';";
    form.reset();
    output.select();
    message.textContent='คัดลอกคำสั่งด้านล่างไปรันใน D1 Console เพื่อยืนยันการเปลี่ยนรหัส';
  });`;
  const html=`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ตั้งรหัสผ่าน dcc ใหม่</title><main style="max-width:38rem;margin:6vh auto;padding:1rem;font:18px/1.6 system-ui"><h1>ตั้งรหัสผ่าน dcc ใหม่</h1><p>ขั้นที่ 1 ตั้งรหัสผ่านบนอุปกรณ์นี้</p><form><label>รหัสผ่านใหม่ (12–128 ตัวอักษร)<br><input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><p><label>ยืนยันรหัสผ่านใหม่<br><input name="confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label></p><button>สร้างคำสั่งเปลี่ยนรหัสผ่าน</button></form><p role="status"></p><textarea readonly rows="5" style="width:100%" aria-label="คำสั่ง SQL"></textarea><p>ขั้นที่ 2 เปิด Cloudflare Dashboard → D1 → wi-training-center-db → Console วางคำสั่งแล้วกด Execute หรือ Run เมื่อแก้ไขสำเร็จ 1 แถว ให้เปิดเว็บ WI ในหน้าต่างส่วนตัวและเข้าสู่ระบบด้วยชื่อ dcc และรหัสใหม่</p><a href="/">เปิดเว็บ WI</a></main><script nonce="${nonce}">${script}</script></html>`;
  return response(html,200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'","Referrer-Policy":"no-referrer"});
}
export default {async fetch(req,env){
  try{
    const url=new URL(req.url),path=url.pathname,db=env.DB;
    if(path==='/recover' && req.method==='GET')return recoverPage();
    await prepareDatabase(db);
    if(path==='/setup')return await setup(req,env);
    if(path==='/' && req.method==='GET' && !await db.prepare('SELECT 1 FROM users LIMIT 1').first()){
      return response(null,303,{Location:'/setup'});
    }
    const publicMode=url.searchParams.get('mode');
    if(path==='/api/pp-public' && (req.method==='POST'||['card','session','quiz'].includes(publicMode)))return passportAPI(req,db,null);
    if(req.method==='GET' && (path==='/passport-route.mjs'||path==='/passport-page.js'||path==='/passport-qr.js'||path==='/passport-public.css'||(path==='/passport'&&(url.searchParams.has('p')||url.searchParams.has('s'))))){
      const asset=path==='/passport'?'/passport-card':path;
      return env.ASSETS.fetch(new Request(new URL(asset,url.origin)));
    }
    const user=await authenticate(req,db);
    if(!user)return response('Sign in',401,{'WWW-Authenticate':'Basic realm="WI Center", charset="UTF-8"'});
    if(path==='/api/passport')return await passportAPI(req,db,user);
    const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
    if(req.method==='GET'){
      if(path==='/api/data')return response(JSON.stringify({...await snapshot(db,user,today),passportEnabled:true}),200,{'Content-Type':'application/json'});
      if(/^\/pdf\/\d+$/.test(path)){
        const row=await statement(db,'SELECT * FROM revs WHERE id=? AND (approved IS NOT NULL OR ?=\'admin\')',Number(path.slice(5)),user.role).first();
        requireValue(row,'ไม่พบไฟล์',404);
        const obj=await pdfOperation(()=>env.PDFS.get(row.object_key));
        requireValue(obj,'ไม่พบไฟล์',404);
        const mode=url.searchParams.has('download')?'attachment':'inline';
        return response(obj.body,200,{'Content-Type':'application/pdf','Content-Disposition':mode+'; filename="'+row.code+'_Rev'+String(row.rev).padStart(2,'0')+'.pdf"'});
      }
      if(path==='/passport-export-forms.txt' && user.role!=='admin')return response('เฉพาะผู้ดูแล DCC',403);
      if(['/','/app.js','/style.css','/passport-export-forms.txt'].includes(path)){
        const asset=await env.ASSETS.fetch(req);
        const out=new Response(asset.body,asset);
        for(const [k,v] of Object.entries(headers))out.headers.set(k,v);
        return out;
      }
      return response('Not found',404);
    }
    requireValue(req.method==='POST','Method not allowed',405);
    requireValue(req.headers.get('X-WI-Request')==='1' && req.headers.get('Content-Type')==='application/json','ไม่มีสิทธิ์ทำรายการ',403);
    requireValue(['/api/approve','/api/upload','/api/training'].includes(path),'Not found',404);
    requireValue(user.role==='admin'||(path==='/api/training'&&user.role==='lead'),'ไม่มีสิทธิ์ทำรายการ',403);
    requireValue(Number(req.headers.get('Content-Length'))<=17*1024*1024,'ข้อมูลใหญ่เกินกำหนด',413);
    const obj=await req.json();
    if(path==='/api/upload')await upload(env,user,obj);
    if(path==='/api/approve'){
      const r=await statement(db,'UPDATE revs SET approved=? WHERE id=? AND approved IS NULL',user.login,Number(obj.id)).run();
      requireValue(r.meta.changes===1,'ไม่พบฉบับที่รออนุมัติ',409);
    }
    if(path==='/api/training')await train(db,user,obj,today);
    return response('{}',200,{'Content-Type':'application/json'});
  }catch(err){
    if(err instanceof HttpError)return response(err.message,err.status);
    if(err instanceof SyntaxError)return response('ข้อมูลไม่ถูกต้อง',400);
    if(/D1_|SQLITE_|no such (table|column)/i.test(String(err)))return response('อ่านหรือบันทึกฐานข้อมูล WI ไม่สำเร็จ กรุณาตรวจ D1 binding DB และโครงสร้างตาราง',503);
    return response('ประมวลผลคำขอไม่สำเร็จ กรุณาแจ้งผู้ดูแลระบบ WI',503);
  }
}};
