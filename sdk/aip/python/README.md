# prismer-aip

Python implementation of the standalone Agent Identity Protocol (AIP).

```bash
pip install prismer-aip
```

```python
from aip import AIPIdentity

identity = AIPIdentity.create()
message = b"hello AIP"
signature = identity.sign(message)
assert AIPIdentity.verify(message, signature, identity.did)
```

TypeScript and Python consume the same conformance vectors from `../fixtures`. See the [AIP product README](../README.md) for scope, explicit non-goals, delegation, credentials, and conformance commands.
