# Handoff: explicit terminal-cell widths in the Nuvin Ink fork

## Immediate task and current stopping point

The user wants the TUI width calculation/output to agree with real terminal cursor advancement **without replacing emoji or removing variation selectors**. This is a cell-width problem, not a complaint about glyph shapes or colors.

After comparing OpenCode/OpenTUI, the user approved working on an OpenTUI-style solution: **OSC 66 capability negotiation plus explicit-width terminal output in our Ink fork**, with existing behavior retained on unsupported terminals. Their latest request was to stop and hand off to a fresh agent.

**OSC 66 implementation has NOT started.** No new capability detector, output encoder, public option, or implementation plan for this phase has been written. A source search at handoff found no explicit-width/OSC 66 implementation in `packages/ink/src`. We only inspected integration points and loaded planning/TDD workflows. No implementation subagent is running for this phase.

Start by reading this handoff, checking current diffs, and writing a bounded implementation plan for the approved design. Do not restart the completed content-preservation/clipping work described below.

## Workspace and safety

- Main checkout: `/Users/marsch/Projects/nuvin/nuvin-agent`, branch `main`.
- Ink checkout: `/Users/marsch/Projects/nuvin/nuvin-agent/packages/ink`, **separate nested Git repository**, branch `master` at handoff.
- User explicitly chose working in the current checkout. No new worktree is required unless they change that preference.
- **No commits, pushes, publication, or destructive cleanup without user direction.** None were performed in the preceding work.
- Preserve all existing uncommitted changes. In particular, nested Ink already has reviewed changes in `src/output.ts` and `test/output-rows.test.ts`.
- Leave unrelated main-checkout `docs/superpowers/reports/runtime-memory/` untouched.
- Ink planning/design documents belong under `packages/ink/docs/superpowers/`.
- OpenCode reference checkout: `/Users/marsch/Projects/opencode`. User granted access; reads subsequently succeeded. It is reference material only—do not edit it. It already had modified `bun.lock` and several untracked files before our inspection.
- Main project uses pnpm/Vitest; nested Ink uses npm/AVA, Node >=22, ESM. Native repository boundaries matter.

## Ground truth: actual terminal measurements

The user ran `.superpowers/sdd/probe-emoji-width.mjs` in ordinary foreground shells. It queries cursor positions before/after each sequence plus an ASCII sentinel. ASCII control passed in all three terminals. These are measured advances, not inferred pixel widths.

| Original sequence | Code points | Kitty | Terminal.app | Warp | Current CLI/Ink calculators |
|---|---|---:|---:|---:|---:|
| lightning | `26A1` | 2 | 2 | 2 | 2 |
| lightning + VS15 | `26A1 FE0E` | **1** | 2 | 2 | 2 |
| lightning + VS16 | `26A1 FE0F` | 2 | 2 | **3** | 2 |
| warning + VS16 | `26A0 FE0F` | 2 | **1** | 2 | 2 |
| check | `2705` | 2 | 2 | 2 | 2 |
| cross | `274C` | 2 | 2 | 2 | 2 |
| full line below | — | **24** | **24** | **26** | **25** |

Exact full line: `- ⚡, ⚡︎, ⚡️, ⚠️, ✅, ❌,`

Terminal identities supplied by the user:
- Kitty: `TERM=xterm-kitty`; TERM_PROGRAM/version unavailable in probe output.
- Terminal.app: `TERM_PROGRAM=Apple_Terminal`, version `470.2`, `TERM=xterm-256color`.
- Warp: `TERM_PROGRAM=WarpTerminal`, version `v0.2026.08.12.21.54.stable_00`, `TERM=xterm-256color`.

These samples do not justify generalizing to every BMP emoji, every VS15/VS16 sequence, or every version of a terminal.

### Tool execution is not a terminal

Moving the user's UI into Kitty did not give Bash tools a controlling terminal. We verified stdin/stdout were non-TTY and `/dev/tty` failed with `ENXIO` / Device not configured. Run physical cursor probes in a **normal foreground shell outside Nuvin**, with user assistance. Do not redirect probes into the active TUI or assume a `!command` foreground execution feature exists; an earlier response suggested it without verification.

The existing probe is a diagnostic scratch file under the main checkout, not production code. Its syntax and non-TTY refusal were checked; the user supplied real execution results. It measures **raw text**, not OSC 66 output.

## What OpenCode/OpenTUI actually does

OpenCode's root manifest pins `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` to **0.2.14**. Installed core also reports 0.2.14.

### OpenCode application wiring

Under `/Users/marsch/Projects/opencode`:
- `packages/opencode/src/cli/cmd/tui/app.tsx:119–140`: `rendererConfig` has no application-level emoji-width overrides.
- `app.tsx:185`: calls `createCliRenderer(rendererConfig(input.config))`.
- Installed `packages/opencode/node_modules/@opentui/core/index-3fq5hq97.js:22255–22257`: `widthMethod` reads renderer capabilities, choosing `wcwidth` or `unicode`.
- Same bundle `:23335–23368`: startup activates capability/CPR routing; a five-second capability window is closed and input handlers cleaned up.

### Native implementation, pinned release sources

Repository: `https://github.com/anomalyco/opentui`, tag **v0.2.14**. Native Zig source was not installed locally, so these release sources were fetched read-only.

1. `packages/core/src/zig/terminal.zig:287–293`: sends an explicit-width probe, then requests cursor position; also probes scaled text.
2. `terminal.zig:922–971`: parses CPR replies. Probe coordinates enable `explicit_width` and `scaled_text` capabilities.
3. `packages/core/src/zig/ansi.zig:363`: explicit-width probe is `ESC ] 66 ; w=1 ; <space> ESC \\`.
4. `ansi.zig:276–277`: `explicitWidthOutput(writer, width, text)` emits `ESC ] 66 ; w=<width> ; <original text> ESC \\`.
5. `packages/core/src/zig/renderer.zig:1385–1404`: emits grapheme bytes through explicit-width output when supported. Otherwise writes original bytes; on selected fallback configurations it then explicitly positions the cursor at the next allocated cell.
6. `terminal.zig:620–629`: Apple Terminal selects `wcwidth`.
7. `terminal.zig:1013–1019`: tmux selects `wcwidth` plus explicit cursor positioning; Alacritty enables explicit cursor positioning.
8. `terminal.zig:348–350` and `ansi.zig:375`: can enable Unicode mode 2027 when appropriate and explicit-width output is unavailable.

Source URL pattern: `https://github.com/anomalyco/opentui/blob/v0.2.14/packages/core/src/zig/<file>#L<line>`.

Kitty specification: `https://sw.kovidgoyal.net/kitty/text-sizing-protocol/`. Raw documentation also available at `https://raw.githubusercontent.com/kovidgoyal/kitty/master/docs/text-sizing-protocol.rst`. It explicitly states that nonzero `w` tells the terminal the cell allocation; this is intended to address width disagreements.

### Important verification limitation

We ran the installed native `resolveRenderLib().encodeUnicode()` and the actual `TextBuffer`/`TextBufferView.measureForDimensions()` path with both `unicode` and `wcwidth` modes. **Both returned 2 for every sample and 25 for the complete line.**

Therefore:
- Copying OpenTUI's calculator or its `wcwidth` switch alone does not establish a fix for our measured discrepancies.
- Its important additional technique is coordinating calculated widths with terminal output using OSC 66.
- We have **not** tested full OpenCode rendering or OSC 66 support on the user's three terminal installations. Do not claim OpenCode solves all three cases.

## Approved design direction for the next phase

The user asked whether we can apply the same logic to Ink, then said: "is that a quick changes, can you work on it". We accepted the bounded scope below, then they requested this handoff.

### Capability ownership and negotiation

- Capability state belongs to the foreground **Ink instance**, not the daemon and not a process-global mutable width function.
- Detect explicit-width support for eligible interactive TTY streams; do not infer it solely from terminal brand/environment.
- Integrate with existing terminal/input negotiation. Correctly handle split/coalesced replies, timeout, cancellation/unmount, ordinary keys arriving alongside replies, and existing Kitty keyboard negotiation.
- Do not let CPR response bytes reach application key handlers or swallow/replay normal keys twice.
- Probe only in safely owned terminal space. **Do not blindly copy OpenTUI's `home` probe sequence into inline Ink**, where the top-left may contain unrelated shell content.
- No queries in redirected/noninteractive/screen-reader paths; debug behavior and resume lifecycle must be explicitly considered.

### Encoding ownership

- Keep original Unicode text and plain frame data for layout, wrapping, clipping, frame comparisons, and selection/copy.
- When the capability is confirmed, encode eligible non-ASCII graphemes at the terminal-output boundary with their already allocated cell width.
- Preserve complete ANSI/OSC control sequences and hyperlinks. Never run a naive regex replacement through arbitrary control payloads, OSC 52 clipboard data, URLs, etc.
- Cover both full and incremental rendering, `<Static>` output, resizing/redraws, and final output as appropriate to the interactive lifetime.
- Do not add OSC wrappers early enough that `string-width`, wrapping, truncation, or tokenizers must interpret the new protocol as text.
- Preserve skip-identical-frame behavior and cached fast paths. Avoid scanning/encoding hidden suffixes or unchanged rows on every frame. Measure both work and stdout-byte overhead.
- Capability transitions must not reuse stale encoded output or leave an initial plain frame permanently uncorrected. Decide startup timing/cache invalidation explicitly.

### Fallback and scope boundaries

- **Unsupported terminals retain current behavior in this first pass.** Terminal.app/Warp width fallbacks are separate work; this phase does not promise to fix them without protocol support.
- No new terminal-specific emoji tables, no global `string-width@8.2.2` override, and no v4/v8 terminal-rule patches were implemented or approved as the current approach.
- A previous proposal for those patches was superseded by the OpenTUI investigation. Do not resume it automatically.
- No emoji substitution or selector stripping.
- Public API/default/opt-out details are **not finalized**. Resolve these in the implementation plan without silently changing scope or claiming user approval of a particular option name.
- If safe automatic negotiation requires a substantially broader startup/input refactor, surface that rather than producing another cascade of speculative changes.

### Acceptance must test encoded output

A correct supported-terminal outcome can be:

```text
Raw ⚡︎ in Kitty:           1 cell
Ink allocation:            2 cells
OSC-66 encoded ⚡︎:         2 cells
```

The original raw probe may still disagree with Ink after this feature. That is not failure of explicit-width output. Acceptance is **actual cursor advance of the encoded output equals allocated cells**, with original codepoints preserved, followed by near-right-edge wrapping/redraw/copy tests.

## Ink integration points inspected

Paths below are relative to the main checkout; line numbers can drift.

- `packages/ink/src/ink.tsx:1318–1359`: `confirmKittySupport`, stdin response buffering, timeout, cleanup, re-emission of nonresponse data. This is a pattern to inspect, not proof it can be copied unchanged for CPR handling.
- `ink.tsx:400–405`: interactive-mode/TTY determination.
- `ink.tsx:435–460`: creation of normal/incremental log updater and throttled output.
- `ink.tsx:597–660`: render result and separate debug, noninteractive, screen-reader paths.
- `ink.tsx:750` onward: external stdout/stderr handling and redraw paths; do not indiscriminately encode external control traffic.
- `packages/ink/src/log-update.ts:494–521`: incremental row comparison and final stream write. Preserve the comparison-before-write optimization.
- `packages/ink/src/output.ts`: grapheme grid, ANSI serialization, masks/plain rows, width/cache logic. It already contains substantial reviewed work from the preceding phase.
- `packages/ink/src/render.ts`: public options and instance construction; defaults around lines 203–215.
- `packages/ink/src/components/App.tsx`, `src/input-parser.ts`, `src/kitty-keyboard.ts`: existing input lifecycle/protocol parsing.
- `packages/ink-input/src/input.ts:476` onward: Nuvin's higher-level input path; protocol responses must not become keys here.

Existing tests:
- `packages/ink/test/kitty-keyboard.tsx`
- `test/hooks-use-input-kitty.tsx`, `test/input-parser.ts`
- `test/log-update.tsx`, `test/log-update-scroll-region.ts`
- `test/output-rows.test.ts`, `test/text-width.tsx`, `test/paint-selection.test.ts`
- `test/helpers/create-stdout.ts`: fake stdout defaults `isTTY=true`; account for synthetic TTYs when assessing default auto-detection test impact.

Codegraph sometimes resolves the nested Ink path to the parent index and returns unrelated symbols. Use focused direct reads/searches when this happens; do not create indexes or other metadata in reference repositories without need.

## Existing uncommitted work: keep it intact

This earlier phase is complete and reviewed, but does **not** by itself resolve the real terminal-width disagreements.

### Main checkout

- Removed `normalizeAmbiguousEmojiWidth` from agent shell normalization and all CLI callers; removed obsolete CLI helper/tests.
- Kept U+200D so valid joined emoji survive shell control filtering.
- Fixed Markdown hard-wrap code-unit slicing using grapheme/cell iteration.
- Added version-pinned pnpm patches:
  - `patches/string-width@4.2.3.patch`: remaining VS15/VS16 count zero after emoji recognition.
  - `patches/cli-table3@0.6.5.patch`: whole-grapheme truncation plus SGR/OSC-8 handling/valid hyperlink termination.
- `packages/cli/tsup.config.ts` bundles `cli-table3` and `string-width` so these patches ship in CLI artifacts.
- Added table, hyperlink, component preservation, and isolated production-config bundle tests.
- Updated pending `.changeset/ambiguous-emoji-width-collapse.md` to describe preservation rather than destructive collapsing. **Do not edit `.changeset/pre.json`.**

### Nested Ink checkout

Only tracked changes at handoff: `src/output.ts`, `test/output-rows.test.ts`.

- Corrected wide-grapheme clipping so surviving text retains its original columns.
- Preserved masks/selection and empty-line transformer placement.
- Bounded tokenization/traversal of invisible right-hand suffixes.
- Cached verified complete-line geometry and styled characters to preserve the fully-inside fast path.
- Reviews caught major performance regressions during intermediate attempts; all were resolved. **Do not regress to eager whole-line clipping or repeated parsing of identical ANSI rows.**

### Existing verification baseline

- Shell: **82 tests passed**; agent-core build passed.
- CLI: **349 targeted tests passed** (27 files), including against the final built local Ink fork.
- Ink: **322 targeted tests passed**; typecheck/build/format/diff checks passed.
- Full CLI release build passed: production typecheck, tsup, native assets, guides, obfuscation.
- Final bundled OSC-8 emoji/table fixture passed on **Node 22.0.0**.
- Full test-inclusive CLI `tsc --noEmit` has **132 pre-existing diagnostics**, but none in changed/new CLI files after correcting the bundle test's static out-of-rootDir config import.
- Ink XO is blocked by a missing installed `xo/dist/cli.js`. Do not claim that lint passed or repair unrelated tooling without reason. Changed-file Prettier and typecheck/build passed.
- Legacy v4 width handling still has a nonblocking ST-hyperlink spare-cell padding limitation; documented in the prior plan. It is not the primary task.

## Dependency wiring and delivery

The main workspace currently selects **published `ink: npm:@nuvin/ink@7.6.0-alpha`**, not the nested source. Prior local integration tests temporarily linked the fork, then restored the exact published configuration and lockfile.

- Editing/building nested Ink does not automatically deliver changes to the running CLI.
- `make ink-local` / `scripts/ink-mode.mjs local` select the local checkout for development.
- Before temporary linking, save the current YAML and lockfile **including the existing table patches**. Restore those exact files afterwards and run a frozen install.
- Do not use `make ink-npm` blindly to restore: its script can select the newest registry version, not necessarily the original version.
- Root pnpm installs can rewrite comments and touch the nested dependency environment. Coordinate installs; avoid unnecessary scripts/reinstalls.
- Publication/upgrading the fork requires separate user direction. Do not leave a local link in commit-ready release configuration silently.

## Useful commands

Nested Ink (explicit env avoids prior React `act`/color test false failures):

```sh
cd /Users/marsch/Projects/nuvin/nuvin-agent/packages/ink
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava \
  test/output-rows.test.ts test/text-width.tsx test/measure-text.tsx \
  test/borders.tsx test/overflow.tsx test/paint-selection.test.ts test/components.tsx
npm run typecheck
npm run build
```

Add focused negotiation/encoding/log-update tests for the new feature; the command above is the prior geometry baseline, not sufficient new-feature coverage.

Main CLI regression command:

```sh
pnpm --filter @nuvin/nuvin-code exec vitest run \
  src/components/tool-renders \
  src/components/MessageList.sticky-bottom-flash.test.tsx \
  src/components/ToolMessageRow.test.tsx \
  src/components/TranscriptVisualSnapshot.test.tsx \
  src/components/PlainText.test.tsx src/components/Markdown.test.tsx \
  src/components/MessageRow.test.tsx src/lib/markdown \
  src/tsup-patched-table-bundle.test.ts
```

Full CLI build: `pnpm --filter @nuvin/nuvin-code build` (allow ~180 seconds; obfuscation can exceed a 30-second tool timeout). It uses `tsconfig.build.json`, so pre-existing test-inclusive type errors do not block this build. Existing warning about private `daemon-lib.d.ts` re-exports is unrelated.

## Existing records

Under main checkout:
- `docs/superpowers/plans/2026-09-06-preserve-emoji-output.md`
- `.superpowers/sdd/progress.md` — contains other older tasks too; use the emoji section, do not overwrite unrelated history.
- `.superpowers/sdd/emoji-cli-report.md`
- `.superpowers/sdd/emoji-ink-report.md` — final append contains 322-test/cache evidence; earlier sections describe intermediate failures.
- `.superpowers/sdd/emoji-main-review-fix.md`
- `.superpowers/sdd/emoji-bundle-report.md`
- `.superpowers/sdd/emoji-cli-full-build-final.txt`
- `.superpowers/sdd/emoji-final-test-types.txt`
- `.superpowers/sdd/probe-emoji-width.mjs`

Some early reports were superseded by later corrections. Use the final append/review outcomes and current code, not an intermediate claim that all widths were universally correct.

## Suggested next actions

1. Recheck both Git states and read the Ink startup, input, and output seams above.
2. Write the bounded OSC 66 plan in nested Ink docs. Decide public option/default, safe probe lifecycle, reply ownership, and encoding placement explicitly.
3. Implement with TDD: first pure encoding/control-preservation and response-parser tests, then renderer lifecycle/full/incremental/static integration. Keep one owner for tightly coupled input/output changes.
4. Add deterministic unchanged-row/ASCII work guards and measure emitted-byte overhead; preserve existing clipping/cache performance.
5. Obtain independent review, run affected Ink and consumer tests against a built local fork, and validate fallback/non-TTY behavior.
6. Prepare or extend a foreground probe to measure **OSC-66 encoded output**, not only raw text. Ask the user to run it in Kitty/other terminals; do not fabricate physical-terminal verification from mocks.
7. Report exactly what is supported and what remains fallback behavior. Leave changes uncommitted unless asked otherwise.
