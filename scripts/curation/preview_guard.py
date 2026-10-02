"""Ordinary Django middleware enforcing the task's local-preview capability."""
import os
from pathlib import Path


def preview_path(root, relative):
    root=Path(root)
    if root.is_symlink() or not isinstance(relative,str) or not relative or Path(relative).is_absolute():
        raise ValueError('PREVIEW_BOUNDARY_REFUSED')
    path=root/relative
    path.resolve(strict=True).relative_to(root.resolve(strict=True))
    for item in (path,*path.parents):
        if item.is_symlink():raise ValueError('PREVIEW_SYMLINK_REFUSED')
        if item==root:break
    if not path.is_file():raise ValueError('PREVIEW_FILE_REQUIRED')
    return path


class PreviewBoundaryMiddleware:
    def __init__(self,get_response):self.get_response=get_response
    def __call__(self,request):
        if request.path=='/data/local-files/':
            try:preview_path(os.environ['LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT'],request.GET.get('d'))
            except (ValueError,OSError):
                from django.http import HttpResponseForbidden
                return HttpResponseForbidden('PREVIEW_BOUNDARY_REFUSED')
        return self.get_response(request)
