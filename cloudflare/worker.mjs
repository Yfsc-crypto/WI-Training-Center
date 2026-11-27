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
async function authenticate(req,db){
  const raw=req.headers.get('Authorization') || '';
  if(!raw.startsWith('Basic ')) return null;
  let credentials;
  try{credentials=new TextDecoder().decode(Uint8Array.from(atob(raw.slice(6)),c=>c.charCodeAt(0)));}catch{return null;}
  const split=credentials.indexOf(':');
  if(split<1)return null;
  const user=await statement(db,'SELECT * FROM users WHERE login=?',credentials.slice(0,split)).first();
  if(!user)return null;
  const salt=Uint8Array.from(user.salt.match(/../g),v=>parseInt(v,16));
  const key=await crypto.subtle.importKey('raw',encoder.encode(credentials.slice(split+1)),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:100000,salt},key,256);
  const digest=Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,'0')).join('');
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
  await env.PDFS.put(key,bytes);
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
export default {async fetch(req,env){
  try{
    const url=new URL(req.url),path=url.pathname,db=env.DB;
    const user=await authenticate(req,db);
    if(!user)return response('Sign in',401,{'WWW-Authenticate':'Basic realm="WI Center", charset="UTF-8"'});
    const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
    if(req.method==='GET'){
      if(path==='/api/data')return response(JSON.stringify(await snapshot(db,user,today)),200,{'Content-Type':'application/json'});
      if(/^\/pdf\/\d+$/.test(path)){
        const row=await statement(db,'SELECT * FROM revs WHERE id=? AND (approved IS NOT NULL OR ?=\'admin\')',Number(path.slice(5)),user.role).first();
        requireValue(row,'ไม่พบไฟล์',404);
        const obj=await env.PDFS.get(row.object_key);
        requireValue(obj,'ไม่พบไฟล์',404);
        const mode=url.searchParams.has('download')?'attachment':'inline';
        return response(obj.body,200,{'Content-Type':'application/pdf','Content-Disposition':mode+'; filename="'+row.code+'_Rev'+String(row.rev).padStart(2,'0')+'.pdf"'});
      }
      if(['/','/app.js','/style.css'].includes(path)){
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
    return response('ระบบยังไม่พร้อม กรุณาตรวจสอบการตั้งค่า D1 และ R2',503);
  }
}};
