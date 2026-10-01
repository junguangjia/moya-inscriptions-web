"""Use upstream LS unchanged, with local preview containment and a display-only object companion."""
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','label_studio.core.settings.label_studio')
from label_studio.server import main, LS_PATH
import sys
sys.path.insert(0,LS_PATH)
from django.conf import settings
settings.MIDDLEWARE=['preview_guard.PreviewBoundaryMiddleware',*settings.MIDDLEWARE,'companion.ObjectCompanionMiddleware']
main()
