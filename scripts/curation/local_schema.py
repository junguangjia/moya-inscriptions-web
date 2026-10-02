"""Stage 2 schemas have local consumers only; no shared workspace contract."""
import json
from pathlib import Path
from registry import CurationError


def validate(name, value):
    from jsonschema import Draft202012Validator
    allowed = {'incremental-intake-v1', 'algorithm-dataset-v1'}
    if name not in allowed:
        raise CurationError('LOCAL_SCHEMA_UNKNOWN')
    schema = json.loads((Path(__file__).parent / 'schemas' / (name + '.schema.json')).read_text())
    if next(Draft202012Validator(schema).iter_errors(value), None):
        raise CurationError('LOCAL_SCHEMA_INVALID')
