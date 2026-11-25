# veyract observe

Unreleased work in progress: open-source, local-first observability for AI coding sessions ("Know what your coding agent did."). Nothing here is released, supported or stable yet.

Privacy contract:

- `metadata`: *strictly projected, content-excluding metadata* — closed enums, known-value allowlists, keyed pseudonyms (HMAC) for anything open-ended, validated opaque identifiers (UUIDs, tool-use ids) whose residual risk is documented.
- `detailed`: `metadata` plus repo-relative file paths, readable tool/agent/model names and restricted command forms; **residual identifier and file-name disclosure risk**.
- `sensitive-local`: best-effort redacted free text, separate object, never exported in phase 1.

Observations are the agent's self-report (external-observed), not verified evidence.
