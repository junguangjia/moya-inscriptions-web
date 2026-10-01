#!/bin/zsh
set -eu
cd "${0:A:h}"
python3 setup.py --interactive --open
