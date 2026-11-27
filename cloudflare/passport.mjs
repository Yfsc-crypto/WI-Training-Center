const origin='https://yfsc-training-passport.t-thanatcha04.chatgpt.site';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
async function upstream(path,accept){
  return fetch(new URL(path,origin),{headers:{Accept:accept},redirect:'manual',signal:AbortSignal.timeout(12000)});
}
export async function readPassport(req){
  if(req.headers.get('X-WI-Request')!=='1'||req.headers.get('Content-Type')!=='application/json')return reply({error:'กรุณาเปิดจากเว็บ WI'},403);
  const body=await req.json();
  let link;
  try{link=new URL(body.link);}catch{return reply({error:'กรุณาวางลิงก์จาก QR ประจำตัวพนักงาน'},400);}
  const token=link.searchParams.get('p');
  if(link.origin!==origin||link.pathname!=='/'||!token||token.length>300)return reply({error:'กรุณาใช้ลิงก์ QR ประจำตัวจาก Training Passport'},400);
  try{
    const res=await upstream('/api/training?'+new URLSearchParams({mode:'passport',token}),'application/json');
    if(res.status===404)return reply({error:'ไม่พบ Passport หรือ QR นี้ถูกยกเลิกแล้ว'},404);
    if(!res.ok)throw Error();
    const {employee,history}=await res.json();
    if(!employee?.id||!Array.isArray(history))throw Error();
    return reply({employee:{id:String(employee.id),name:employee.name,department:employee.department},history:history.map(({topic,document,revision,date,result})=>({topic,document,revision,date,result}))});
  }catch{return reply({error:'โหลดประวัติจาก Training Passport ไม่สำเร็จ กรุณาลองอีกครั้ง'},502);}
}
export async function readCourses(){
  try{
    const res=await upstream('/transport-training','text/html');
    if(!res.ok)throw Error();
    const courses=[];
    let course;
    const parser=new HTMLRewriter().on('.course-group article',{element(el){
      course={id:el.getAttribute('id'),topic:'',score:'',url:'',qr:''};courses.push(course);
    }});
    for(const [tag,key] of [['h3','topic'],['.course-info strong','score']]){
      parser.on('.course-group article '+tag,{text(chunk){if(course)course[key]+=chunk.text;}});
    }
    parser.on('.course-group article a.open-course',{element(el){
      const u=new URL(el.getAttribute('href'),origin);
      if(u.protocol==='https:')course.url=u.href;
    }}).on('.course-group article img',{element(el){
      const u=new URL(el.getAttribute('src'),origin);
      if(u.origin===origin&&u.pathname.startsWith('/transport-qr/'))course.qr=u.href;
    }});
    await parser.transform(res).arrayBuffer();
    const valid=courses.filter(c=>c.url&&c.topic.trim());
    if(!valid.length)throw Error();
    return reply({courses:valid});
  }catch{return reply({error:'โหลดรายการแบบอบรมไม่ได้'},502);}
}
