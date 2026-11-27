'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tabs=['คลัง WI','ประวัติการอบรม','ติดตามการอบรม','Dashboard'];
let data, tab=0, currentRows=[], currentHeaders=[];
const admin=()=>data.user.role==='admin';
const revLabel=r=>'Rev.'+String(r).padStart(2,'0');
const table=(heads,rows)=>rows.length?'<table><thead><tr>'+heads.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table>':'<p class="empty">ยังไม่มีรายการที่ตรงกับเงื่อนไข</p>';
const button=(action,label,value='',cls='')=>'<button class="'+cls+'" data-action="'+action+'" data-value="'+esc(value)+'">'+esc(label)+'</button>';
const options=rows=>rows.map(([v,t])=>'<option value="'+esc(v)+'">'+esc(t)+'</option>').join('');
const input=(name,label,type='text',attrs='')=>'<label>'+label+'<input required name="'+name+'" type="'+type+'" '+attrs+'></label>';
function fileLinks(id){return '<a href="/pdf/'+id+'" target="_blank" rel="noopener">เปิด PDF</a> · <a href="/pdf/'+id+'?download=1">ดาวน์โหลด</a>';}
async function load(){
 const res=await fetch('/api/data');if(!res.ok)throw Error('โหลดข้อมูลไม่สำเร็จ');
 data=await res.json();$('#user').textContent=data.user.name+' · '+({admin:'DCC / Q&S',lead:'หัวหน้างาน',employee:'พนักงาน'}[data.user.role]);
 render();
}
function render(){
 $('nav').innerHTML=tabs.map((t,i)=>button('tab',t,i,i===tab?'active':'')).join('');
 $('h1').textContent=tabs[tab];$('#stats').innerHTML='';$('#actions').innerHTML='';
 const query=$('#search').value.trim().toLowerCase();
 const match=r=>r.some(x=>String(x).toLowerCase().includes(query));
 let heads,rows,display;
 if(tab===0){
  heads=['รหัส WI','ชื่อเอกสาร','DC / แผนก','ฉบับปัจจุบัน','ไฟล์และประวัติ'];
  rows=data.docs.map(d=>{const r=data.revs.find(r=>r.code===d.code&&r.status==='ใช้งาน');return [d.code,d.title,d.dc+' / '+d.dept,r?revLabel(r.rev):'รอประกาศ',r?.id];}).filter(r=>match(r.slice(0,4)));
  display=rows.map(r=>[...r.slice(0,4).map(esc),(r[4]?fileLinks(r[4])+' ':'')+button('detail','ดูประวัติ',r[0])]);
  if(admin())$('#actions').innerHTML=button('upload','เพิ่ม WI ใหม่','','primary');
 }else if(tab===1){
  heads=['รหัสพนักงาน','ชื่อพนักงาน','รหัส WI','ฉบับที่อบรม','วันที่อบรม','ผู้บันทึก / ผู้สอน','ผล'];
  rows=data.history.map(r=>[r.employee,data.employees.find(e=>e.login===r.employee)?.name,r.code,revLabel(r.rev),r.day,r.trainer,r.result]).filter(match);
  if(data.user.role!=='employee')$('#actions').innerHTML=button('train','บันทึกการอบรม','','primary');
 }else{
  heads=['รหัสพนักงาน','ชื่อพนักงาน','DC / แผนก','รหัส WI','ฉบับปัจจุบัน','สถานะอบรม'];
  rows=data.tasks.map(t=>{const e=data.employees.find(e=>e.login===t.employee);return [t.employee,t.name,e.dc+' / '+e.dept,t.code,revLabel(t.rev),t.status];}).filter(match);
  if(tab===3){
   const stats=['ผ่านแล้ว','รออบรม','รออบรมซ้ำ'].map(s=>[s,rows.filter(r=>r[5]===s).length]);
   $('#stats').innerHTML='<div class="cards">'+stats.map(([s,n])=>'<div class="card">'+s+'<b>'+n+'</b></div>').join('')+'</div>';
  }
 }
 if(tab!==0)$('#actions').innerHTML+=button('csv','ส่งออก CSV');
 currentRows=rows;currentHeaders=heads;$('#content').innerHTML=table(heads,display??rows.map(r=>r.map(esc)));
}
function modal(html){$('#error').textContent='';$('#panel').innerHTML=html;if(!$('dialog').open)$('dialog').showModal();}
function detail(code){
 const d=data.docs.find(d=>d.code===code);
 const rows=data.revs.filter(r=>r.code===code).map(r=>[revLabel(r.rev),esc(r.effective),esc(r.status),esc(r.summary),r.retrain?'ต้องอบรมซ้ำ':'ตามผลเดิม',esc(r.approved||'—'),(r.approved||admin()?fileLinks(r.id):'')+(admin()&&!r.approved?' '+button('approve','อนุมัติ',r.id):'')]);
 modal('<small>'+esc(code)+'</small><h2>'+esc(d.title)+'</h2><div class="buttons">'+(admin()?button('upload','อัปโหลด Rev. ใหม่',code,'primary'):'')+'</div><div class="scroll">'+table(['ฉบับ','วันที่มีผล','สถานะ','สิ่งที่แก้ไข','การอบรม','ผู้อนุมัติ','ไฟล์'],rows)+'</div>');
}
function form(kind,title,body){modal('<h2>'+title+'</h2><form class="entry" id="entry" data-kind="'+kind+'">'+body+'<button class="primary">บันทึก</button></form>');}
function upload(code){
 const d=data.docs.find(d=>d.code===code);
 const next=d?Math.max(...data.revs.filter(r=>r.code===code).map(r=>r.rev))+1:0;
 form('upload',d?'อัปโหลด Rev. ใหม่':'เพิ่ม WI ใหม่',input('code','รหัส WI','text',d?'readonly value="'+esc(code)+'"':'maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]*"')+
 (d?'':input('title','ชื่อ WI')+input('dc','DC ที่ต้องอบรม (ทุก DC ใช้ *)')+input('dept','แผนกที่ต้องอบรม (ทุกแผนกใช้ *)'))+
 input('rev','เลข Rev.','number','min="'+next+'" value="'+next+'"')+input('effective','วันที่มีผล','date','value="'+data.today+'"')+
 '<label>สรุปสิ่งที่แก้ไข<textarea required maxlength="2000" name="summary"></textarea></label><label class="check"><input type="checkbox" name="retrain"> กำหนดให้ผู้ที่เคยผ่านต้องอบรมซ้ำ</label>'+input('file','ไฟล์ PDF (ไม่เกิน 12 MB)','file','accept="application/pdf,.pdf"'));
}
function train(){
 const revs=data.revs.filter(r=>r.approved&&r.effective<=data.today);
 if(!revs.length){modal('<h2>ยังไม่มี WI สำหรับบันทึกการอบรม</h2><p>เลือกบันทึกได้เมื่อ WI ได้รับอนุมัติและถึงวันที่มีผลค่ะ</p>');return;}
 form('training','บันทึกการอบรม','<label>พนักงาน<select name="employee">'+options(data.employees.map(e=>[e.login,e.login+' · '+e.name]))+'</select></label><label>WI และ Rev. ที่อบรม<select name="id">'+options(revs.map(r=>[r.id,r.code+' · '+revLabel(r.rev)]))+'</select></label>'+input('day','วันที่อบรม','date','max="'+data.today+'" value="'+data.today+'"')+'<label>ผลการอบรม<select name="result">'+options([['ผ่าน','ผ่าน'],['ไม่ผ่าน','ไม่ผ่าน']])+'</select></label>');
}
async function post(path,obj){const res=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-WI-Request':'1'},body:JSON.stringify(obj)});if(!res.ok)throw Error(await res.text());await load();}
document.addEventListener('click',async ev=>{
 const b=ev.target.closest('[data-action]');if(!b)return;
 const {action,value}=b.dataset;
 if(action==='tab'){tab=Number(value);$('#search').value='';render();}
 if(action==='detail')detail(value);
 if(action==='upload')upload(value);
 if(action==='train')train();
 if(action==='approve'){b.disabled=true;try{const r=data.revs.find(r=>r.id===Number(value));await post('approve',{id:r.id});detail(r.code);}catch(e){$('#error').textContent=e.message;b.disabled=false;}}
 if(action==='csv'){
 const safe=v=>{const s=String(v??'');return '"'+(/^[=+@\-\t\r]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';};
 const url=URL.createObjectURL(new Blob(['\ufeff'+[currentHeaders,...currentRows].map(r=>r.map(safe).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='WI-'+tabs[tab]+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
});
document.addEventListener('submit',async ev=>{
 if(ev.target.id!=='entry')return;ev.preventDefault();const f=ev.target,b=f.querySelector('button');b.disabled=true;
 try{const obj=Object.fromEntries(new FormData(f));
 if(f.dataset.kind==='upload'){
 if(obj.file.size>12*1024*1024)throw Error('ไฟล์ใหญ่เกิน 12 MB');
 const reader=new FileReader();obj.pdf=await new Promise((ok,fail)=>{reader.onload=()=>ok(reader.result.split(',')[1]);reader.onerror=()=>fail(Error('อ่านไฟล์ไม่ได้'));reader.readAsDataURL(obj.file);});delete obj.file;
 }
 await post(f.dataset.kind,obj);if(f.dataset.kind==='upload')detail(obj.code.toUpperCase());else $('dialog').close();
 }catch(e){$('#error').textContent=e.message;}finally{b.disabled=false;}
});
$('#search').addEventListener('input',render);
load().catch(e=>$('#status').textContent=e.message);
