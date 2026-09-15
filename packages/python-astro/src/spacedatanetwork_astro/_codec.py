"""Generated-binding marshalling only; no astrodynamics is computed here."""
from importlib import import_module
import flatbuffers
import numpy as np


def binding(path, *, local=False):
    prefix = 'invoke' if local else 'sds'
    module = import_module(f'spacedatanetwork_astro.{prefix}.{path}')
    return getattr(module, path.rsplit('.', 1)[-1] + 'T')


def obj(path, *args, local=False, **kwargs):
    return binding(path, local=local)(*args, **kwargs)


def pack(value, identifier=None):
    builder = flatbuffers.Builder(1024)
    builder.Finish(value.Pack(builder), file_identifier=identifier.encode() if identifier else None)
    return bytes(builder.Output())


def unpack(path, payload, *, local=False):
    return binding(path, local=local).InitFromPackedBuf(payload)


def array(value, shape=None, *, name='array'):
    result = np.ascontiguousarray(value, dtype=np.float64)
    if shape is not None and result.shape != shape:
        raise ValueError(f'{name} must have shape {shape}, got {result.shape}')
    if not np.isfinite(result).all():
        raise ValueError(f'{name} must contain finite values')
    return result


def plain(value):
    if isinstance(value, bytes):
        return value.decode('utf8')
    if isinstance(value, np.ndarray):
        return value.copy()
    if isinstance(value, (list, tuple)):
        return [plain(x) for x in value]
    if hasattr(value, '__dict__'):
        return {k: plain(v) for k, v in vars(value).items()}
    return value
