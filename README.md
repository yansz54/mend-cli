# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yansz54/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yansz54/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats to a tree of
text files: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches,
and JSON text-editor tool calls. It finds the lines an edit names at the first of three
matching tiers (exact, trailing-whitespace-insensitive, indentation-insensitive), and it
changes every file or none: when any edit fails, no file is written.

## Run

    node main.ts [options] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree).
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, no file created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move)
and `ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n> edits`.
Exit 2 reports a usage, no-patch, format or parse error. `SPEC.md` is the whole contract.

Node 22 and its standard library only; no dependencies, no network, deterministic.

## Practice score

100/100 — practice score 1000 on the kit's public practice set
(`node check.ts program/generator/practice.json`), plus 80 extra edge-case checks of
SPEC sentences the practice set does not show (CRLF files and patches, files with no
final line break, empty-O insertion at the end, overlapping occurrences, unsafe paths
in every format, `--check` with failures, forced-format mismatches, stdin/`--`/duplicate
options, JSON array vs JSON Lines faults, V4A anchor/EOF failures, rename-only moves,
multi-edit atomicity, byte-order sorting, `ok: 0 files` / `ok: 1 file`).

## Files

- `main.ts`: the CLI.
- `runner.ts`: the kit's trial runner (kept as shipped).
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
