## Agent skills

### Issue tracker

Issues live as GitHub issues in `sishoui/model-light`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Firmware build & host tests

Building firmware or running its host-side unit tests on this machine has non-obvious tool paths (cmake/ninja/gcc absolute locations, non-ASCII path mirroring). Always read `firmware/README.md` ("主机侧单元测试" and "构建") before invoking cmake/gcc/idf.py — do not search the filesystem for toolchains.

### Triage labels

Five default triage roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Host protocol modules

`host/shard_frame.py`, `host/token_state.py`, `host/status_frame.py`,
`host/arrangement.py` and `host/ota_session.py` do not exist on `master`;
they are implemented on closed wayfinder branches
`wayfinder/31-shard-frame`, `wayfinder/33-status-frame` and
`wayfinder/35-ota-session`. Merge them onto the base before building
`host/ble_suite/` so the imports resolve.
