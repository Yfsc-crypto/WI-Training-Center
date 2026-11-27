(()=>{
'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(label,act,key='')=>'<button type="button" data-op="'+act+'" data-key="'+esc(key)+'">'+esc(label)+'</button>';
const field=(key,label,value='',type='text',required=true)=>'<label>'+esc(label)+'<input name="'+key+'" type="'+type+'" value="'+esc(value)+'" '+(required?'required':'')+'></label>';
const area=(key,label,value='')=>'<label>'+esc(label)+'<textarea name="'+key+'" rows="3">'+esc(value)+'</textarea></label>';
const form=(action,heading,html,save='บันทึก')=>'<form data-form="'+action+'"><h3>'+esc(heading)+'</h3>'+html+'<button type="submit">'+esc(save)+'</button></form>';
const opts=rows=>rows.map(([v,label])=>'<option value="'+esc(v)+'">'+esc(label)+'</option>').join('');
const dt=n=>n?new Date(n).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}):'';
const row=(title,sub,tools='')=>'<article><b>'+esc(title)+'</b><p>'+esc(sub)+'</p><div class="pp-tools">'+tools+'</div></article>';
const report=r=>'<h3>'+esc(r.person.name)+'</h3><p>'+esc([r.person.id,r.person.department,r.person.plate].filter(Boolean).join(' · '))+'</p>'+ (r.history.length?r.history.map(h=>row(h.topic,[h.date,h.revision!=null&&h.revision!==''?'Rev. '+h.revision:'',h.result,h.score!=null?h.score+'/'+(h.max??''):'',h.source].filter(Boolean).join(' · '))).join(''):'<p>ยังไม่มีประวัติอบรม</p>');
async function api(publicOnly,params={},data){
 const url=new URL(publicOnly?'/api/pp-public':'/api/passport',location.origin);
 for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
 const res=await fetch(url,{cache:'no-store',...(data?{method:'POST',headers:{'X-WI-Request':'1','Content-Type':'application/json'},body:JSON.stringify(data)}:{})});
 const out=await res.json();if(!res.ok)throw Error(out.error||'ทำรายการไม่สำเร็จ');return out;
}
function quiz(c){
 return form('take',c.topic,'<input type="hidden" name="course" value="'+esc(c.id)+'">'+c.questions.map((q,i)=>'<fieldset><legend>'+esc((i+1)+'. '+q.title)+'</legend>'+(q.kind==='text'||q.kind==='paragraph'?'<textarea name="q'+i+'" maxlength="5000" '+(q.required?'required':'')+'></textarea>':q.choices.map((v,j)=>'<label><input type="'+(q.kind==='checkbox'?'checkbox':'radio')+'" name="q'+i+'" value="'+j+'" '+(q.required&&q.kind!=='checkbox'?'required':'')+'> '+esc(v)+'</label>').join(''))+'</fieldset>').join(''),'ส่งคำตอบ');
}
async function start(root,isPublic=false){
 root.className='pp';root.innerHTML='<div role="status"></div><nav></nav><div data-pane></div><section data-detail></section>';
 const find=s=>root.querySelector(s),pane=find('[data-pane]'),detail=find('[data-detail]'),status=find('[role=status]');
 let state,tab='ประวัติพนักงาน',selected,query='',sessionToken,cardToken;
 const notify=(v,bad=false)=>{status.textContent=v;status.className=bad?'pp-error':'';};
 const show=x=>{detail.innerHTML=x;detail.scrollIntoView?.({block:'nearest'});};
 function listPeople(){
  const key=query.toLowerCase().trim();return state.people.filter(p=>[p.name,p.id,p.plate,p.department,p.site].some(x=>String(x||'').toLowerCase().includes(key))).map(p=>row(p.name,[p.id,p.department,p.plate,p.site].filter(Boolean).join(' · '),button('ดูประวัติ','history',p.id)+(state.admin?button('แก้ไข','person',p.id)+button('บัตร QR','card',p.id):''))).join('')||'<p>ไม่พบพนักงาน</p>';
 }
 function render(){
  const tabs=['ประวัติพนักงาน','หลักสูตรและแบบทดสอบ','รอบอบรม',...(state.admin?['ตรวจผล','นำเข้าทะเบียน']:[])];
  find('nav').innerHTML=tabs.map(t=>'<button data-op="tab" data-key="'+t+'" aria-pressed="'+(t===tab)+'">'+t+'</button>').join('');
  detail.innerHTML='';
  if(tab===tabs[0])pane.innerHTML='<label>ค้นหาชื่อ รหัส แผนก หรือทะเบียนรถ<input type="search" data-filter></label>'+(state.admin?button('เพิ่มพนักงาน','person')+button('พิมพ์บัตร QR ตามผลค้นหา','cards'):'')+'<section data-people>'+listPeople()+'</section>';
  if(tab===tabs[1])pane.innerHTML=(state.admin?button('เพิ่มหัวข้ออบรม','course')+button('นำเข้าข้อสอบ Google Forms','forms'):'')+state.courses.filter(c=>c.active!==false).map(c=>row(c.topic,[c.id,c.revision?'Rev. '+c.revision:'',c.questions?.length?c.questions.length+' ข้อ':'ยังไม่มีข้อสอบ',c.pass!=null?'เกณฑ์ผ่าน '+c.pass+(c.max!=null?'/'+c.max:''):''].filter(Boolean).join(' · '),(c.questions?.length?button('ทำแบบทดสอบ','quiz',c.id):'')+(state.admin?button('แก้ไขหลักสูตร','course',c.id):''))).join('');
  if(tab===tabs[2])pane.innerHTML=(state.admin?button('สร้างรอบอบรม','session'):'')+state.sessions.map(s=>row(s.topic,[s.id,dt(s.start),dt(s.end),s.location,s.status].join(' · '),state.admin?button('QR ลงชื่อ','sessionQR',s.id)+(s.status==='Open'?button('ปิดรอบ','close',s.id):''):'')).join('');
  if(tab==='ตรวจผล')pane.innerHTML=state.pending.map(r=>row(r.name+' · '+r.topic,[r.date,r.source,r.result].join(' · '),button('ตรวจและอนุมัติ','review',r.id))).join('')||'<p>ไม่มีรายการรอตรวจ</p>';
  if(tab==='นำเข้าทะเบียน')pane.innerHTML=form('import','นำเข้าข้อมูล Training Passport เดิม','<label>ไฟล์ทะเบียน Passport (.json)<input type="file" name="file" accept=".json" required></label>','นำเข้า')+'<details><summary>รายการเดิมที่ต้องตรวจสอบ ('+state.issues.length+')</summary>'+state.issues.map(r=>row(r.name||r.id,(r.resolution?'ตรวจแล้ว · '+r.resolution:r.reason||'รอตรวจสอบ'),button('บันทึกผลตรวจ','resolve',r.id))+'<details><summary>รายละเอียดต้นทาง</summary><pre>'+esc(JSON.stringify(r.details||r,null,2))+'</pre></details>').join('')+'</details>';
 }
 async function reload(){
  if(isPublic){
   const args=new URLSearchParams(location.search);cardToken=args.get('p');sessionToken=args.get('s');
   if(cardToken){
    const [h,c]=await Promise.all([api(true,{mode:'card',p:cardToken}),api(true,{mode:'quiz',p:cardToken})]);state=c;
    pane.innerHTML=report(h)+'<h2>แบบอบรมของฉัน</h2>'+state.courses.map(c=>row(c.topic,c.id,button('ทำแบบทดสอบ','quiz',c.id))).join('');
   }else{
    const s=await api(true,{mode:'session',s:sessionToken});pane.innerHTML=row(s.topic,[dt(s.start),dt(s.end),s.location,s.status].join(' · '));
    if(s.status==='Open'&&Date.now()>=s.start&&Date.now()<s.end)pane.innerHTML+=form('checkin','ลงชื่อเข้ารอบอบรม','<label>ประเภทผู้เข้าอบรม<select name="kind"><option value="employee">พนักงาน</option><option value="external">พนักงานภายนอก</option></select></label>'+field('name','ชื่อและนามสกุล')+'<div data-internal>'+field('person','รหัสพนักงาน')+'</div><div data-external hidden>'+field('company','บริษัทต้นสังกัด','','text',false)+field('plate','ทะเบียนรถ (ถ้าไม่มีให้พิมพ์ ไม่มี)','','text',false)+'</div>','ลงชื่อ');
   }
   detail.innerHTML='';return;
  }
  state=await api(false);render();
 }
 function qr(param,value){
  const u=new URL('/passport',location.origin);u.searchParams.set(param,value);
  show('<h3>QR '+(param==='s'?'ลงชื่อเข้ารอบอบรม':'ประจำตัวพนักงาน')+'</h3><canvas></canvas><p><a href="'+esc(u.href)+'" target="_blank" rel="noreferrer">เปิดหน้านี้ใน Cloudflare WI</a></p>'+button('พิมพ์ QR','print'));window.drawPassportQR(detail.querySelector('canvas'),u.href);
 }
 root.oninput=e=>{if(e.target.matches('[data-filter]')){query=e.target.value;find('[data-people]').innerHTML=listPeople();}};
 root.onchange=e=>{if(e.target.name==='kind'){const ext=e.target.value==='external';find('[data-external]').hidden=!ext;find('[data-internal]').hidden=ext;find('[name=person]').required=!ext;find('[name=company]').required=ext;find('[name=plate]').required=ext;}};
 root.onclick=async e=>{
  const b=e.target.closest('[data-op]');if(!b)return;const {op,key}=b.dataset;notify('');
  try{
   if(op==='tab'){tab=key;query='';render();return;}
   if(op==='history'){const r=await api(false,{mode:'history',id:key});show(report(r));}
   if(op==='person'){
    selected=state.people.find(p=>p.id===key)||{};show(form('person',key?'แก้ไขพนักงาน':'เพิ่มพนักงาน',field('id','รหัสพนักงาน',key)+field('name','ชื่อ–นามสกุล',selected.name)+field('department','แผนก / บริษัท',selected.department)+field('site','DC',selected.site,'text',false)+field('plate','ทะเบียนรถ',selected.plate,'text',false)+'<label><input type="checkbox" name="active" '+(selected.active!==false?'checked':'')+'> ใช้งาน</label>'));if(key)find('[name=id]').readOnly=true;
   }
   if(op==='course'){selected=state.courses.find(c=>c.id===key)||{};show(form('course','หลักสูตรและข้อสอบ',field('id','รหัสหลักสูตร',key)+field('topic','หัวข้อ',selected.topic)+field('type','ประเภท',selected.type||'Training')+field('revision','Rev.',selected.revision,'text',false)+field('pass','คะแนนผ่าน (เว้นว่างเพื่อตรวจผลเอง)',selected.pass??'','number',false)+'<fieldset><legend>ข้อสอบ</legend><div data-questions></div>'+button('เพิ่มคำถาม','question')+'</fieldset>'));if(key)find('[name=id]').readOnly=true;(selected.questions||[]).forEach(question);}
   if(op==='question')question({});
   if(op==='removeQ')b.closest('[data-q]').remove();
   if(op==='forms')show('<p>ผู้ดูแลส่งออกคำถามจากบัญชีเจ้าของ Google Forms ครั้งเดียว แล้วเลือกไฟล์ JSON ด้านล่าง <a href="/passport-export-forms.txt" download>ดาวน์โหลดสคริปต์ส่งออกพร้อมวิธีใช้</a></p>'+form('forms','นำเข้าแบบอบรมจาก Google Forms','<label>ไฟล์ข้อสอบที่ส่งออก (.json)<input name="file" type="file" accept=".json" required></label>','นำเข้าข้อสอบ'));
   if(op==='card')qr('p',state.people.find(p=>p.id===key).token);
   if(op==='sessionQR')qr('s',state.sessions.find(s=>s.id===key).token);
   if(op==='cards'){
    const needle=query.trim().toLowerCase(),people=state.people.filter(p=>p.active!==false&&p.token&&[p.name,p.id,p.plate,p.department,p.site].some(v=>String(v||'').toLowerCase().includes(needle)));
    if(!people.length)throw Error('ไม่พบบัตรตามเงื่อนไข');
    show(button('พิมพ์บัตร','print')+'<div class="pp-cards">'+people.map(p=>'<article><b>'+esc(p.name)+'</b><p>'+esc(p.id)+'</p><canvas></canvas></article>').join('')+'</div>');
    detail.querySelectorAll('canvas').forEach((canvas,i)=>{const u=new URL('/passport',location.origin);u.searchParams.set('p',people[i].token);window.drawPassportQR(canvas,u.href);});
   }
   if(op==='print')window.print();
   if(op==='quiz'){selected=state.courses.find(c=>c.id===key);show(quiz(selected));}
   if(op==='session')show(form('session','สร้างรอบอบรม','<label>หัวข้อ<select required name="course">'+opts(state.courses.filter(c=>c.active!==false).map(c=>[c.id,c.topic+' · '+c.id]))+'</select></label>'+field('start','เปิดลงชื่อ (เวลาไทย)','','datetime-local')+field('end','ปิดลงชื่อ (เวลาไทย)','','datetime-local')+field('location','สถานที่')));
   if(op==='close')show(form('close','ยืนยันปิดรับลงชื่อรอบ '+key,'<input type="hidden" name="id" value="'+esc(key)+'">','ปิดรับลงชื่อ'));
   if(op==='resolve')show(form('resolve','บันทึกผลตรวจข้อมูลเดิม','<input type="hidden" name="id" value="'+esc(key)+'">'+area('remark','ผลตรวจสอบ')));
   if(op==='review'){selected=state.pending.find(r=>r.id===key);show(form('review',selected.name+' · '+selected.topic,(selected.answerText||[]).map((v,i)=>row(selected.questionTitles[i],v)).join('')+(selected.source==='แบบทดสอบ'?field('score','คะแนนหลังตรวจ (เต็ม '+selected.max+')',selected.score,'number'): '')+'<label>ผล<select name="result"><option>ผ่าน</option><option>ไม่ผ่าน</option></select></label>'+area('remark','หมายเหตุ')));}
  }catch(err){notify(err.message,true);}
 };
 function question(q){
  const section=document.createElement('fieldset');section.dataset.q='';section.innerHTML=field('title','คำถาม',q.title)+
  '<label>ประเภท<select name="qkind">'+opts([['single','เลือกคำตอบเดียว'],['checkbox','เลือกหลายคำตอบ'],['text','คำตอบสั้น'],['paragraph','คำตอบยาว']])+'</select></label>'+area('choices','ตัวเลือก (บรรทัดละข้อ)',(q.choices||[]).join('\n'))+field('correct','ลำดับข้อถูก เช่น 1 หรือ 1,3 (เว้นว่างเพื่อตรวจเอง)',(q.correct||[]).map(i=>i+1).join(','),'text',false)+field('points','คะแนนเต็ม',q.points??1,'number')+'<label><input type="checkbox" name="qrequired" '+(q.required!==false?'checked':'')+'> ต้องตอบ</label>'+button('ลบคำถาม','removeQ');section.querySelector('[name=qkind]').value=q.kind||'single';find('[data-questions]').append(section);
 }
 root.onsubmit=async e=>{
  const f=e.target;if(!f.dataset.form)return;e.preventDefault();const action=f.dataset.form,fd=new FormData(f),b=Object.fromEntries(fd),submit=f.querySelector('[type=submit]');submit.disabled=true;notify('กำลังบันทึก…');
  try{
   let note='บันทึกแล้ว';
   if(action==='import'||action==='forms'){
    const file=JSON.parse(await fd.get('file').text());
    if(action==='forms'){
     if(file.format!=='yfsc-forms-v1'||!Array.isArray(file.courses))throw Error('รูปแบบไฟล์ข้อสอบไม่ถูกต้อง');
     for(const c of file.courses)await api(false,{}, {...c,action:'course',edit:true});
     note='นำเข้าข้อสอบ '+file.courses.length+' หลักสูตรแล้ว';
    }else{
     if(file.format!=='yfsc-passport-v1')throw Error('รูปแบบไฟล์ทะเบียนไม่ถูกต้อง');let added=0;
     for(const kind of ['people','courses','sessions','attendance','scores','issues']){
      const rows=file[kind]||[];for(let i=0;i<rows.length;i+=40){const r=await api(false,{},{action:'import',kind,rows:rows.slice(i,i+40)});added+=r.added;notify('นำเข้าแล้ว '+added+' รายการ');}
     }note='เพิ่ม '+added+' รายการ (ข้ามรหัสที่มีอยู่แล้ว)';
    }
   }else{
    b.action=action;
    if(action==='course'){
     b.edit=!!selected.id;b.pass=b.pass===''?null:Number(b.pass);b.questions=[...f.querySelectorAll('[data-q]')].map(q=>{const v=n=>q.querySelector('[name='+n+']').value.trim();return {title:v('title'),kind:v('qkind'),points:Number(v('points')),required:q.querySelector('[name=qrequired]').checked,choices:v('choices')?v('choices').split('\n').filter(Boolean):[],correct:v('correct')?v('correct').split(',').map(n=>Number(n.trim())-1):[]};});
     if(!b.questions.length){if(selected.questions?.length){b.pass=null;}else delete b.questions;}
    }
    if(action==='person'){b.edit=!!selected.id;b.active=fd.has('active');}
    if(action==='resolve'&&!b.remark.trim())throw Error('กรุณาระบุผลตรวจสอบ');
    if(action==='review'){if(b.score!==undefined)b.score=Number(b.score);b.id=selected.id;b.kind=selected.source==='แบบทดสอบ'?'scores':'attendance';}
    if(action==='checkin'){b.token=sessionToken;b.external=b.kind==='external';}
    if(action==='take'){b.version=selected.version;b.card=cardToken;b.answers=selected.questions.map((q,i)=>['text','paragraph'].includes(q.kind)?String(fd.get('q'+i)||''):fd.getAll('q'+i).map(Number));}
    const r=await api(isPublic,{},b);note=r.message||note;
   }
   await reload();notify(note);
  }catch(err){notify(err.message,true);}finally{submit.disabled=false;}
 };
 try{await reload();}catch(err){notify(err.message,true);}
}
window.startPassport=start;
const card=document.querySelector('#pp-card');if(card)start(card,true);
})();
