#!/bin/zsh
set -eu
cd "${0:A:h}"
TASK_RUNTIME_ROOT="${HOME}/Developer/artifacts/moya-inscriptions-web/ai-curation-v1/runtime"
TASK_APP="${TASK_RUNTIME_ROOT:h}/ArtVenn Curation.app"
if [[ ! -x "${TASK_APP}/Contents/MacOS/ArtVennCuration" ]]; then
  "${TASK_RUNTIME_ROOT}/ls-env/bin/python" native/build_app.py --root "$TASK_RUNTIME_ROOT" --destination "$TASK_APP"
fi
/usr/bin/open "$TASK_APP"
