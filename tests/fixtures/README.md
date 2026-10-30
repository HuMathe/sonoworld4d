# Published scene fixtures

These small JSON snapshots describe the scene bundle published in
`DerongJin/SonoWorld4D-Demo-Scenes` at Hugging Face commit
`1f980c1ae2ddbf5646cc40172a785cf499348d0b`, under
`output-scenes/test-vggt/{porsche,plane}/`.

The original export manifests provide the verified asset path, size, and SHA-256
allowlists. Tests use those lists to simulate asset responses; they never need
to read or download WAV, PLY, NPY, or video files. The copied source metadata and
Plane study render metadata match their manifest hashes. Plane's separate
viewer configuration preserves the aircraft's -6 dB adjustment and the default
VGGT camera; Porsche intentionally has no viewer configuration.

Keep these fixtures and the pinned production revision in sync when publishing
a new scene bundle. Preserve the original metadata provenance.
