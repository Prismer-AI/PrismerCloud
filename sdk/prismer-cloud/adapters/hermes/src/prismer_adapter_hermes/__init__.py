"""
prismer_adapter_hermes — Prismer PARA adapter for Hermes (NousResearch) agents.

Public API:
    register(ctx, sink=None) -> HermesParaAdapter
    AdapterConfig (alias for HermesParaAdapter for typing convenience)
    __version__
"""

from .adapter import HermesParaAdapter
from .register import register
from .sink import default_jsonl_sink
from .descriptor import build_agent_descriptor

__version__ = "0.2.0"

# Expose HermesParaAdapter under the AdapterConfig alias so callers can do:
#   from prismer_adapter_hermes import AdapterConfig
AdapterConfig = HermesParaAdapter

__all__ = [
    "register",
    "HermesParaAdapter",
    "AdapterConfig",
    "default_jsonl_sink",
    "build_agent_descriptor",
    "__version__",
]
