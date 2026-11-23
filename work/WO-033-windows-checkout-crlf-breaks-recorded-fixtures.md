# WO-033: On Windows, Git checks the recorded fixtures out with CRLF and the byte-for-byte tests fail

| | |
|---|---|
| Status | Done |
| Severity | Medium |
| Feature | The test fixtures and recorded cases (`rust/app-fixtures/`, `rust/app-cases/`, `rust/app/tests/unit-cases/`) on Windows |
| Opened | 2026-11-23, by Claude (first CI run on Windows: https://github.com/mko1989/acCompaniment/actions/runs/45260956244) |
| Reproduction test | `rust/app/tests/seed_roundtrip.rs` - "seed_json_round_trips_byte_for_byte" (fails on a Windows checkout) |
| Related | ADR-006, ADR-009 |

## Feature
The seed data dir and the recorded cases are the specification (ADR-006, ADR-020): the server
must read the seed's JSON files and write them back byte for byte, and the replay compares the
data dir after each request.

## Problem
The repo had no `.gitattributes`, and Git for Windows (as on the GitHub runner) defaults to
`core.autocrlf=true`: every text file is checked out with CRLF line ends. The seed's
`audio/library.json` then starts `{\r\n  "version"`; the server writes LF (as the Node original
did, `JSON.stringify(_, null, 2)`), so `seed_json_round_trips_byte_for_byte`
(`rust/app/tests/seed_roundtrip.rs:28`) fails. `cargo test` stops there, so the 12,916 recorded
unit cases and the JS suites never ran on Windows.

Not an app bug: the server writes LF on every platform, and user data written by the app is LF.
The fixtures just aren't the bytes that were recorded.

## Proposed solution
`.gitattributes` with `* text=auto eol=lf`: text files are LF in every checkout. Renormalizing
the repo changes no file (everything is LF already). Acceptance: the Windows CI job gets past
`cargo test`.

Alternative: mark only the fixture folders `-text`. Rejected: every text file in this repo is
written for LF (shell scripts in `packaging/` must be LF to run), and one rule is simpler.

## What has been done
- 2026-11-23: found in the first Windows CI run; cause confirmed from the assertion (bytes
  13, 10 in the checked-out file). `.gitattributes` added; `git add --renormalize .` changed
  nothing.
- 2026-11-23: CI run 45265130852 on Windows: `seed_roundtrip` passes, and so do the 12,916
  recorded unit cases (8/8 suites), which hadn't run on Windows before.

## Decision
- 2026-11-23, Claude on the owner's delegation (ADR-016): `.gitattributes` with `eol=lf` for the
  whole repo (no behavior users rely on is involved).
