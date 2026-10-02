"""Synthetic boundary tests for menu receipt handling; no service/network calls."""
import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
import app
from registry import private_json, CurationError


class DailyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='artvenn-daily-review-')
        self.root=Path(self.tmp.name)
        (self.root/'state').mkdir()
        self.menu=app.Application.__new__(app.Application)
        self.menu.root=self.root
        self.menu.worker=None
        self.menu.selected=None
        self.package=self.root/'state/package.json'
        private_json(self.package,{'version':1,'synthetic':True,'objects':[{'objectId':'synthetic-object'}]})
        private_json(self.root/'state/prepared-package.json',{'path':str(self.package),'synthetic':True})
        self.mapping={'id':12,'expectedRevision':3,'instance':'development','baseURL':'http://127.0.0.1:3590'}
        self.calls=[]
        self.provenance=patch('worker.synthetic_package_verified',return_value=True)
        self.provenance.start()

    def tearDown(self):self.provenance.stop();self.tmp.cleanup()

    def child(self, partial=False, ordinary_failure=False):
        def run(args,**kwargs):
            self.calls.append(args)
            if str(app.CODE/'adapter.mjs') in args:
                self.assertIn('draft',args)
                summary={'succeeded':1,'failed':1 if partial else 0,'results':[{'status':'verified','objectId':'synthetic-object','cmsDraft':self.mapping}]}
                if partial:summary['results'].append({'status':'failed','objectId':'failed-object','category':'SYNTHETIC_CONFLICT'})
                private_json(Path(args[-1])/'integration-summary.json',summary)
                receipt={'developmentIntegration':'PARTIAL' if partial else 'PASS','succeeded':1,'failed':1 if partial else 0,'productionPublication':'NOT AUTHORIZED'}
                if ordinary_failure:receipt={'category':'SYNTHETIC_CHILD_FAILURE'}
                return subprocess.CompletedProcess(args,1 if partial or ordinary_failure else 0,json.dumps(receipt),'')
            return subprocess.CompletedProcess(args,0,'{"status":"ready"}','')
        return run

    def test_restart_probe_refuses_live_listener_but_reuses_closed_owned_http_socket(self):
        from service import available
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            server.bind(("127.0.0.1",0));server.listen()
            port=server.getsockname()[1]
            self.assertFalse(available(port))
            with socket.socket() as client:
                client.connect(("127.0.0.1",port))
                peer,_=server.accept()
                peer.close()
        self.assertTrue(available(port))

    def test_restart_probe_refuses_wildcard_listener_even_when_reuse_bind_would_succeed(self):
        from service import available
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            server.bind(("0.0.0.0",0));server.listen()
            port=server.getsockname()[1]
            self.assertFalse(available(port))
        self.assertTrue(available(port))

    def test_verified_mapping_persists_new_revision(self):
        private_json(self.root/'state/cms-draft-mappings.json',{'other-object':{'id':1,'expectedRevision':1},'synthetic-object':{**self.mapping,'expectedRevision':2}})
        with patch.object(app.subprocess,'run',side_effect=self.child()):result=self.menu.action({'action':'development'})
        self.assertEqual(result['status'],'development_draft_verified')
        mappings=json.loads((self.root/'state/cms-draft-mappings.json').read_text())
        self.assertEqual(mappings['synthetic-object'],self.mapping)
        self.assertIn('other-object',mappings)

    def test_partial_nonzero_persists_only_verified_mappings_and_reports_partial(self):
        with patch.object(app.subprocess,'run',side_effect=self.child(partial=True)):result=self.menu.action({'action':'development'})
        self.assertEqual(result['status'],'development_partial')
        self.assertEqual(result['failed'],1)
        self.assertEqual(json.loads((self.root/'state/cms-draft-mappings.json').read_text()),{'synthetic-object':self.mapping})
        self.assertEqual(json.loads((self.root/'state/development-result.json').read_text())['developmentIntegration'],'PARTIAL')

    def test_non_synthetic_package_refused_before_any_child(self):
        private_json(self.root/'state/prepared-package.json',{'path':str(self.package),'synthetic':False})
        with patch.object(app.subprocess,'run') as child:
            with self.assertRaisesRegex(CurationError,'REAL_MATERIAL_TRANSFER_NOT_AUTHORIZED'):self.menu.action({'action':'development'})
        child.assert_not_called()

    def test_stop_uses_detached_controller_after_response(self):
        with patch.object(app.threading,'Timer') as timer, patch.object(app.subprocess,'Popen') as child:
            result=self.menu.action({'action':'stop'})
            self.assertEqual(result['status'],'stopping_persistent_data_retained')
            child.assert_not_called()
            delay,callback=timer.call_args.args
            self.assertEqual(delay,.5)
            timer.return_value.start.assert_called_once_with()
            callback()
            child.assert_called_once_with(
                [str(self.root/'ls-env/bin/python'),str(app.CODE/'service.py'),'stop','--root',str(self.root)],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)

    def test_generic_nonzero_child_never_writes_mapping(self):
        with patch.object(app.subprocess,'run',side_effect=self.child(ordinary_failure=True)):
            with self.assertRaisesRegex(CurationError,'SYNTHETIC_CHILD_FAILURE'):self.menu.action({'action':'development'})
        self.assertFalse((self.root/'state/cms-draft-mappings.json').exists())


if __name__=='__main__':unittest.main()
