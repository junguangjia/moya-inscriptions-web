"""Authenticated, display-only companion inside native Label Studio."""
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from presentation import readonly, task_context
from review_scope import COOKIE, parse_focus, allow_request, focused_list, certified_asset, synthetic_preview
from registry import CurationError

ASSETS = {"companion.js": "text/javascript; charset=utf-8", "objects.css": "text/css; charset=utf-8"}


class ObjectCompanionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def local(self, request):
        origin = os.environ.get("LABEL_STUDIO_HOST", "")
        parts = urlsplit(origin)
        return parts.scheme == "http" and parts.hostname == "127.0.0.1" and request.META.get("HTTP_HOST") == parts.netloc and request.META.get("REMOTE_ADDR") == "127.0.0.1"

    def __call__(self, request):
        from django.http import HttpResponse, JsonResponse
        root = Path(os.environ["ARTVENN_CURATION_ROOT"])
        try:scope=parse_focus(request.COOKIES.get(COOKIE))
        except CurationError:return JsonResponse({"category":"FOCUSED_REVIEW_SCOPE_INVALID"},status=403)
        if scope:
            if not self.local(request) or not getattr(request.user,"is_authenticated",False):
                return JsonResponse({"category":"LOCAL_REVIEW_SESSION_REQUIRED"},status=403)
            # Upstream initializes editor history even outside label stream.
            # Return no navigation history without querying other native tasks.
            if request.method=='GET' and request.path.rstrip('/')==f"/api/projects/{scope['project']}/label-stream-history":
                response=JsonResponse([],safe=False)
                response['Cache-Control']='no-store'
                return response
            def lookup(kind,pk):
                from django.apps import apps
                model=apps.get_model('tasks',{'annotation':'Annotation','draft':'AnnotationDraft','prediction':'Prediction'}[kind])
                return model.objects.filter(pk=pk).values_list('task_id',flat=True).first()
            if not allow_request(request.path,request.GET,request.method,scope,lookup):
                return JsonResponse({"category":"FOCUSED_REVIEW_TASK_REQUIRED"},status=403)
            if request.path.rstrip('/')=='/api/tasks':request.GET=focused_list(request.GET,scope)
            if scope['synthetic'] and request.path=='/data/local-files/' and not synthetic_preview(root,request.path,request.GET):
                return JsonResponse({"category":"SYNTHETIC_PROVENANCE_REQUIRED"},status=403)
        if request.path.startswith("/curation/"):
            if request.method not in {"GET", "HEAD"} or not self.local(request) or not getattr(request.user, "is_authenticated", False):
                return JsonResponse({"category": "LOCAL_REVIEW_SESSION_REQUIRED"}, status=403)
            if request.path.removeprefix("/curation/") in ASSETS:
                name = request.path.removeprefix("/curation/")
                response = HttpResponse((Path(__file__).parent / "ui" / name).read_bytes(), content_type=ASSETS[name])
            elif request.path == "/curation/context":
                try:
                    task, project = int(request.GET.get("task", "")), int(request.GET.get("project", ""))
                    from django.apps import apps
                    Project = apps.get_model("projects", "Project")
                    if not Project.objects.for_user(request.user).filter(pk=project).exists():
                        return JsonResponse({"category": "REVIEW_PROJECT_PERMISSION_REQUIRED"}, status=403)
                    Task = apps.get_model("tasks", "Task")
                    native_data = Task.objects.filter(pk=task,project_id=project).values_list("data",flat=True).first()
                    if native_data is None:
                        return JsonResponse({"category": "REVIEW_CONTEXT_UNAVAILABLE"}, status=404)
                    root = Path(os.environ["ARTVENN_CURATION_ROOT"])
                    with readonly(root) as db:
                        value = task_context(root, db, task, project,native_data)
                    if scope and scope['synthetic']:
                        def clean(card):
                            class Reader:pass
                            reader=Reader();reader.db=db
                            return card.get('synthetic') and all(certified_asset(reader,a['id']) for a in card['assets'])
                        with readonly(root) as db:
                            if not clean(value['current']) or (value.get('other') and not clean(value['other'])):
                                return JsonResponse({'category':'SYNTHETIC_PROVENANCE_REQUIRED'},status=403)
                            for target in value.get('targets',[]):
                                if not clean(target['object']):
                                    target['object']={'code':'测试视图不可用','name':'此目标未通过合成资料核验','nameSource':'未显示','membership':'原选择值保留','materialLabel':'不可在测试视图查看','synthetic':False,'assets':[]}
                    value["directory"] = f"http://127.0.0.1:{int(os.environ['ARTVENN_CURATION_UI_PORT'])}/objects?focus={value['current']['id']}" + ('&material=synthetic' if scope and scope['synthetic'] else '')
                    response = JsonResponse(value, json_dumps_params={"ensure_ascii": False})
                except (CurationError, ValueError, KeyError, OSError):
                    return JsonResponse({"category": "REVIEW_CONTEXT_UNAVAILABLE"}, status=404)
            else:
                return JsonResponse({"category": "NOT_FOUND"}, status=404)
            response["Cache-Control"] = "no-store"
            response["X-Content-Type-Options"] = "nosniff"
            return response
        response = self.get_response(request)
        if (request.method == "GET" and re.fullmatch(r"/projects/\d+/data/", request.path)
                and self.local(request) and getattr(request.user, "is_authenticated", False)
                and response.status_code == 200 and not response.streaming
                and response.get("Content-Type", "").startswith("text/html") and not response.get("Content-Encoding")):
            addon = b'<link rel="stylesheet" href="/curation/objects.css"><script defer src="/curation/companion.js"></script>'
            if scope:
                styles=b'<style>.lsf-label-view__table,.lsf-tabs-dm-content{display:none!important}.lsf-label-view__lsf-wrapper_mode_explorer{margin-left:0!important}</style>'
                if b'</head>' in response.content:response.content=response.content.replace(b'</head>',styles+b'</head>',1)
                else:response.content=styles+response.content
            if b"</body>" in response.content:
                response.content = response.content.replace(b"</body>", addon + b"</body>", 1)
                response["Content-Length"] = len(response.content)
                response["Cache-Control"] = "no-store"
                if response.has_header("ETag"):
                    del response["ETag"]
        return response
