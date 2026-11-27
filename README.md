# YFSC WI & Training Center

เว็บภาษาไทยสำหรับคลัง WI และประวัติการอบรม เก็บข้อมูลและไฟล์ PDF ใน SQLite บนเซิร์ฟเวอร์ ทุกคนใช้ฐานข้อมูลเดียวกัน

## เปิดใช้งานบน Cloudflare

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/Yfsc-crypto/WI-Training-Center)

เลือกบัญชี Cloudflare ของบริษัทและ repository นี้ใน Workers & Pages ใช้ Worker ชื่อ `wi-training-center` เลือกหรือสร้าง D1 สำหรับ binding `DB` และ private R2 bucket สำหรับ binding `PDFS` ตาม wrangler.jsonc หากตั้งค่าผ่าน Git integration ให้ใช้ deploy command `npx wrangler deploy` และ root เป็นโฟลเดอร์หลักของ repository

หลัง deploy ครั้งแรก เปิด **Storage & databases → D1 → ฐานข้อมูลของแอป → Console** แล้วรันคำสั่งใน [cloudflare/schema.sql](cloudflare/schema.sql) ให้ครบ จากนั้นสร้างบัญชี DCC บนเครื่องของผู้ดูแลด้วยคำสั่งนี้

```sh
python cloudflare/user_sql.py --login dcc --name "Document Control" --role admin --dc "PTT DC" --dept QS
```

ตั้งรหัสผ่านใน Terminal แล้วนำเฉพาะคำสั่ง INSERT ที่ได้ไปรันใน D1 Console เพิ่มบัญชีหัวหน้าและพนักงานด้วยวิธีเดียวกันโดยใช้ role `lead` หรือ `employee` เปิด URL workers.dev จากหน้า Worker และเข้าสู่ระบบเพื่อเริ่มใช้ เก็บ SQL ที่สร้างบัญชีไว้เป็นความลับ ห้ามนำขึ้น GitHub

## เริ่มใช้งาน Python ในเครื่อง

ใช้ Python 3.11 ขึ้นไป บนเครื่องที่มีฐานข้อมูลเขตเวลา IANA (บน Windows อาจต้องติดตั้ง tzdata) เปิด Terminal ในโฟลเดอร์ที่มี app.py

```sh
python app.py user --login dcc --name "Document Control" --role admin --dc "PTT DC" --dept "QS"
python app.py user --login wh-lead --name "หัวหน้าคลัง" --role lead --dc "PTT DC" --dept "WH"
python app.py user --login emp001 --name "พนักงานตัวอย่าง" --role employee --dc "PTT DC" --dept "WH"
python app.py serve
```

ตั้งรหัสผ่านเมื่อโปรแกรมถาม เปิด http://127.0.0.1:8000 แล้วเข้าสู่ระบบผ่านหน้าต่างของเบราว์เซอร์ เปลี่ยนรหัสพนักงาน ชื่อ DC และแผนกในคำสั่งให้ตรงกับหน่วยงานก่อนสร้างบัญชี

## การควบคุมเอกสาร

1. DCC เปิด **คลัง WI → เพิ่ม WI ใหม่** ระบุรหัส ชื่อ DC และแผนกที่ต้องอบรม ใช้ * สำหรับทุก DC หรือทุกแผนก อัปโหลด PDF ไม่เกิน 12 MB
2. ใน **ดูประวัติ** กด **อนุมัติ** ระบบเลือก Rev. สูงสุดที่อนุมัติและถึงวันที่มีผลตามเวลาไทยเป็นฉบับปัจจุบัน
3. การแก้เอกสารเดิมให้เปิด **ดูประวัติ → อัปโหลด Rev. ใหม่** ระบุเลข Rev. ที่สูงขึ้น สรุปการเปลี่ยนแปลง และเลือกว่าต้องอบรมซ้ำหรือไม่ หน้าเดียวกันเปิดและดาวน์โหลด PDF ย้อนหลังแยกตาม Rev. ได้
4. หัวหน้างานบันทึกผลของพนักงานใน DC และแผนกของตน เลือกฉบับที่มีผลในวันที่อบรม ผู้บันทึกเป็นผู้สอนตามบัญชีที่เข้าสู่ระบบ พนักงานดูประวัติของตนเองได้ DCC ดูภาพรวมทุกทีม
5. เมนูติดตามจับคู่ขอบเขต WI กับ DC และแผนกของพนักงาน Dashboard นับคู่พนักงาน–WI และส่งออก CSV ภาษาไทยสำหรับเปิดใน Excel ได้

## การเปิดให้ทีมใช้งานบนเซิร์ฟเวอร์ Python

GitHub เก็บซอร์สโค้ด แอปนี้ต้องใช้เซิร์ฟเวอร์ Python พร้อมพื้นที่เก็บข้อมูลถาวร GitHub Pages ให้บริการไฟล์สแตติก จึงรันส่วนบันทึกข้อมูลของแอปนี้ไม่ได้

สำหรับการใช้งานร่วมกัน ให้ตั้ง HTTPS ผ่าน reverse proxy บนเครือข่ายองค์กร ใช้ production WSGI server เช่น Gunicorn (Linux) แทนคำสั่ง serve ที่ใช้ทดสอบในเครื่อง ตั้ง WI_DATABASE เป็นพาธบน persistent volume ให้ผู้รันมีสิทธิ์อ่านเขียน ก่อนเริ่มให้สร้างบัญชีด้วยคำสั่งด้านบนโดยใช้ WI_DATABASE ค่าเดียวกับเซิร์ฟเวอร์ ตัวอย่างคำสั่งหลังติดตั้ง Gunicorn และสร้างฐานข้อมูลแล้ว

```sh
gunicorn --workers 2 --bind 127.0.0.1:8000 app:application
```

ตั้ง proxy ให้รับ request body ได้ 17 MB และส่ง Authorization header ต่อไปยังแอป สำรอง SQLite ด้วย SQLite backup API หรือหยุดบริการก่อนคัดลอกฐานข้อมูล ไฟล์ PDF อยู่ในฐานข้อมูลเดียวกัน เก็บฐานข้อมูลและรหัสผ่านไว้นอก Git

## ตรวจสอบ

```sh
python -m unittest -v
```
