"""Artifact access only. Python/WasmEdge execution is not yet available.

This prerelease deliberately contains no substitute Python physics or
speculative runtime API. See the package README's dependency blockers.
"""
from ._version import __version__
from .artifacts import Artifact, ArtifactIntegrityError, get_artifact, list_artifacts

__all__ = ["__version__", "Artifact", "ArtifactIntegrityError", "get_artifact", "list_artifacts"]
