"""Stands in for ssh in the tool's own tests: runs the remote command locally, with this Python for the profile's
remote Python (the first word of the remote command whose name holds `python`; anything before it, such as a privilege
wrapper, is dropped)."""
import os
import shlex
import sys

words = shlex.split(sys.argv[-1])
at = next(i for i, word in enumerate(words) if 'python' in os.path.basename(word))
os.execv(sys.executable, [sys.executable] + words[at + 1:])
