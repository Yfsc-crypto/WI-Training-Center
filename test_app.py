import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from wsgiref.util import setup_testing_defaults
import app

class Workflow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        previous = app.DB
        self.addCleanup(setattr, app, "DB", previous)
        app.DB = Path(self.temp.name)/"test.db"
        with app.connect() as db:
            db.executescript(app.SCHEMA)
            for name,role in [('dcc','admin'),('staff','employee')]:
                salt = name.encode()
                db.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)",(name,name,role,'PTT','WH',salt,app.password_hash("sample",salt)))

    def call(self, path, payload=None, account='dcc', query=''):
        env = {}
        setup_testing_defaults(env)
        env.update(PATH_INFO=path, QUERY_STRING=query, HTTP_AUTHORIZATION='Basic '+base64.b64encode((account+':sample').encode()).decode())
        if payload is not None:
            raw=json.dumps(payload).encode()
            env.update(REQUEST_METHOD='POST', CONTENT_TYPE='application/json', CONTENT_LENGTH=str(len(raw)), HTTP_X_WI_REQUEST='1')
            env['wsgi.input']=io.BytesIO(raw)
        response=[]
        body=b''.join(app.application(env,lambda s,h: response.extend([s,dict(h)])))
        return int(response[0][:3]),response[1],body

    def test_revision_training_workflow(self):
        payload=dict(code='WI-01', title='รับพาเลท',dc='PTT',dept='WH', rev=1,effective='2025-01-01',summary='เริ่มใช้',pdf=base64.b64encode(b'%PDF-test1').decode())
        self.assertEqual(self.call('/api/upload',payload,account='staff')[0],403)
        self.assertEqual(self.call('/api/upload',payload)[0],200)
        self.assertEqual(self.call('/pdf/1',account='staff')[0],404)
        self.assertEqual(self.call('/api/approve',{'id':1})[0],200)
        self.assertEqual(self.call('/api/training',dict(id=1,employee='staff',day='2025-01-15',result='ผ่าน'))[0],200)
        payload.update(rev=2,effective='2025-02-01',retrain=True,pdf=base64.b64encode(b'%PDF-test2').decode())
        self.assertEqual(self.call('/api/upload',payload)[0],200)
        self.assertEqual(self.call('/api/approve',{'id':2})[0],200)
        payload.update(rev=3,effective='2099-01-01')
        self.assertEqual(self.call('/api/upload',payload)[0],200)
        self.assertEqual(self.call('/api/approve',{'id':3})[0],200)
        snapshot=json.loads(self.call('/api/data',account='staff')[2])
        self.assertEqual([r['status'] for r in snapshot['revs']],['รอวันที่มีผล','ใช้งาน','ยกเลิกใช้แล้ว'])
        self.assertEqual(snapshot['history'][0]['rev'],1)
        self.assertEqual(snapshot['tasks'][0]['status'],'รออบรมซ้ำ')
        for n in (1,2):
            status,headers,body=self.call('/pdf/'+str(n),account='staff',query='download=1')
            self.assertEqual(status,200)
            self.assertEqual(body,('%PDF-test'+str(n)).encode())
            self.assertIn('attachment',headers['Content-Disposition'])
        self.assertEqual(self.call('/api/upload',payload)[0],400)
