# veyract observe

Unreleased work in progress: open-source, local-first observability for AI coding sessions ("Know what your coding agent did."). Nothing here is released, supported or stable yet.

Privacy contract:

- `metadata`: *strictly projected, content-excluding metadata* — closed enums, known-value allowlists, keyed pseudonyms (HMAC) for anything open-ended, validated opaque identifiers (UUIDs, tool-use ids) whose residual risk is documented.
- `detailed`: `metadata` plus readable tool/agent/model names and restricted command forms; **residual identifier disclosure risk**. No file paths.
- `sensitive-local`: repo-relative file paths and best-effort redacted free text, in a separate object, never exported in phase 1.

Observations are the agent's self-report (external-observed), not verified evidence.

## What's coming

- **Grafana dashboards (planned, illustrative preview):** an opt-in NDJSON export that Grafana Alloy, Loki and
  Grafana can consume. See [docs/preview/grafana.md](docs/preview/grafana.md) for screenshots from a prototype.
