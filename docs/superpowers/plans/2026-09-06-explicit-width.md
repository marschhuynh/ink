# OSC 66 Explicit Terminal Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate Ink's allocated grapheme widths with supporting terminals through OSC 66, without changing source text or unsupported-terminal rendering.

**Architecture:** The foreground Ink instance owns automatic capability negotiation and a bounded encoder. Plain frame comparisons, layout, wrapping, clipping, selection, and copy remain unchanged; only committed terminal text is encoded. Two private cursor reports negotiate support inside the first pending output row, before that row is printed, with a 200 ms overall deadline and fail-open output.

**Tech Stack:** Nested `@nuvin/ink` repository, Node >=22, TypeScript, React, npm/AVA, existing `string-width` and `Intl.Segmenter`; no dependency additions.

## Current execution state

- Task 1 is complete and independently approved, including strengthened cache-bound and exact-byte tests.
- **Task 2 is implemented.** Independent re-review of the cancellation-fix wave is still in progress. Seeded parser tests, 249 capability/input/manual tests, 301 lifecycle/render tests, and the dedicated overflow-fixture isolation are in place. Nested full AVA: **1466 passed / 4 known failures / 1 todo / exit 0**. Post-fix local consumers: **534 ink-input + 349 CLI tests, CLI build exit 0**.
- Preserve the approved overrides: **`INK_EXPLICIT_WIDTH=1`** forces encoding without probing on eligible interactive TTY output. **`INK_EXPLICIT_WIDTH=0`** disables detection/encoding; unset or other values use automatic detection. Explicit `explicitWidth: 'disabled'` overrides both. Unsupported terminals may hide wrapped text under force-on; automatic fallback remains raw.
- Automatic detection starts with the first nonempty frame; dynamic updates coalesce during its 200 ms window, while Static deltas are preserved. Empty initial commits retain eligibility. No cursor-positioning fallback or Unicode2027 port is included.
- User prefers subagents for remaining review and verification. Local Ink link remains unchanged; no commits or publishing. Automatic Kitty negotiation still needs a fresh foreground run without `INK_EXPLICIT_WIDTH=1`.

## Related references

- Approved design/handoff: `../handoffs/2026-09-06-explicit-width.md` (primary acceptance requirements).
- Kitty protocol: https://sw.kovidgoyal.net/kitty/text-sizing-protocol/
- OpenTUI v0.2.14: https://github.com/anomalyco/opentui/blob/v0.2.14/packages/core/src/zig/terminal.zig
- Earlier preservation plan: outer `docs/superpowers/plans/2026-09-06-preserve-emoji-output.md`.

## Global Constraints

- Work in the user-approved current checkout. No commits, pushes, publication, version changes, or destructive cleanup.
- Preserve existing uncommitted changes, especially `src/output.ts` and `test/output-rows.test.ts`; do not modify the outer unrelated runtime-memory reports or `.changeset/pre.json`.
- Unsupported terminals retain current rendering. No terminal-brand tables, global width overrides, emoji substitution, or selector stripping.
- Capability state belongs to the foreground Ink instance, not the daemon or a process-global mutable width function.
- Keep original Unicode text and plain frame data for layout, wrapping, clipping, frame comparisons, and selection/copy.
- Preserve complete ANSI/OSC control sequences and hyperlinks, including arbitrary control payloads. Encode only eligible printable graphemes at final output boundaries.
- No queries in redirected, noninteractive, debug, or screen-reader paths. Require real readable/raw-capable TTY input and TTY output; never assume a fake `isTTY` EventEmitter is a usable terminal.
- Preserve skip-identical-frame behavior and cached fast paths. Do not scan hidden suffixes or unchanged incremental rows on each frame. Verify deterministic work counts and stdout bytes.
- Use private CPR only (`ESC [ ? 6 n`, response `ESC [ ? row ; column R`); never consume modified-F3 public-CPR-shaped keys as replies.
- Never blindly home, erase shell content, or add a permanent probe newline. Drawing requires an immutable reservation of a first output row that will overwrite the probe cell.
- Protocol responses must not reach App's key handlers, paste events, or Nuvin's ink-input event channel. Arbitrary external listeners on physical stdin are outside Ink's input ownership; no stream monkey-patching/proxy architecture is required.
- Direct writes to physical terminal streams are outside Ink-managed output ownership; document exclusive ownership during negotiation. Ink-managed external writes must cancel/finish negotiation safely first.
- Tests must establish failures before production edits. Reviewers and review-fix agents use the powerful tier.
- Build nested Ink before consumer tests. Preserve exact outer YAML/lockfile (including existing patches). Ground truth found a pre-existing `link:packages/ink`, contrary to the handoff; user explicitly chose to preserve that local link after verification.
- Physical acceptance requires foreground-user terminal measurements of encoded output; do not claim synthetic tests establish real emulator behavior.

## File ownership and task interfaces

| Task | Files                                                                                                                                                                                                   | Responsibility                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | new `src/explicit-width.ts`, new `test/explicit-width.ts`, `src/log-update.ts`, new `test/log-update-explicit-width.ts`                                                                                 | Safe bounded encoder and comparison-before-encoding output seam                                       |
| 2    | new `src/explicit-width-detection.ts`, new focused detection/integration tests, `src/ink.tsx`, `src/components/App.tsx`, `src/input-parser.ts`, `src/render.ts`, related input/Kitty tests, `readme.md` | Per-instance negotiation, input routing, lifecycle, Static/full output integration and public option  |
| 3    | `docs/superpowers/reports/2026-09-06-explicit-width-verification.md`, ignored foreground diagnostics and test logs                                                                                      | Build/consumer verification, work/byte measurements, physical acceptance instructions and limitations |

### Task 1: Encode only terminal-bound text after plain-frame comparison

**Produces:** `createExplicitWidthEncoder(): (text: string) => string` from `src/explicit-width.ts`; optional `transformOutput?: (text: string) => string` in `logUpdate.create()` options. Default transform is identity. It is invoked for content actually written, not control-only cursor writes, identical frames, unchanged rows, or `sync()` cache priming. Ink integration in Task 2 supplies a closure that is identity until support is confirmed.

- [ ] Write focused failing AVA tests for original emoji/VS/ZWJ/combining/CJK preservation and valid exact `ESC ] 66 ; w=<width> ; <grapheme> ESC \\` bytes. Use `string-width` to match existing allocation, never its ANSI tokenizer's alternate width assumptions.
- [ ] Test complete CSI, OSC8 BEL/ST, OSC52, DCS/APC/PM/SOS, C1 controls, malformed/unterminated payloads, and pre-existing OSC66 preservation. No OSC payload may be recursively encoded. Payloads must be safe UTF-8, width 1..7, at most 4096 bytes; oversized/unsafe/ineligible clusters remain unchanged.
- [ ] Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/explicit-width.ts test/log-update-explicit-width.ts`; record expected RED evidence.
- [ ] Implement a per-instance bounded encoder with ASCII fast path, control-aware scanning, original-grapheme segmentation, and bounded cache. Avoid touching `Output` or selection code. Keep allocations for eligible clusters consistent with its existing grid policy.
- [ ] Add optional log transform at standard full/repaint writes and incremental first/repaint/changed-row writes. Store/compare original `str` and row data throughout. Example contract:

```ts
const calls: string[] = [];
const log = logUpdate.create(stdout, {
	incremental: true,
	transformOutput(text) {
		calls.push(text);
		return encode(text);
	},
});
log('⚡︎\nunchanged');
calls.length = 0;
log('⚡︎\nunchanged');
t.deepEqual(calls, []);
log('⚠️\nunchanged');
t.deepEqual(calls, ['⚠️']);
```

- [ ] Verify standard, incremental, repaint, sync, cursor-only, trailing-newline, scroll-shift and unchanged-row behavior with exact bytes and deterministic segmentation/encoding work assertions. Run new tests plus `test/log-update.tsx test/log-update-scroll-region.ts` and typecheck.
- [ ] Produce a report with RED/GREEN commands/results; obtain independent task-scoped spec/quality review. Do not commit.

### Task 2: Negotiate before first physical output and route terminal responses once

**Consumes:** Task 1 encoder and `logUpdate.create({transformOutput})`.

**Produces:** public `explicitWidth?: 'auto' | 'disabled'`, default `'auto'`; per-instance private startup state. Internal detector owns two-CPR parsing/state/deadline and reservation lifecycle, not process-global width state. Internal input parser accepts a terminal-response callback (with exact record type defined alongside parser); App forwards it before emitting application input, preserving paste. Ink's own encoder closure reads settled capability; no forced-support public mode.

- [ ] Add failing pure detector and real-Readable App integration tests. Cover two valid private replies, same-position unsupported reply, no reply, malformed/out-of-range replies, split/coalesced replies with keys/UTF-8, late replies, modified F3, ESC, paste containing CPR-like bytes, Kitty query coexistence, disabled/non-TTY/debug/screen-reader paths.
- [ ] Introduce protocol-record handling in the existing single App input-parser path; do not add a competing `data` listener and re-emit normal keys. Move eligible startup Kitty reply routing onto that same path as necessary; retain its public opt-in semantics. Hold protocol-specific partials across input chunks without exposing them via the ordinary ESC flush. Complete late private replies are consumed but cannot enable a timed-out/cancelled capability.
- [ ] Connect an input-ready/raw-mode notification from App to Ink. Do not issue queries until the readable/raw input path can receive replies. Notify before losing raw/readable readiness and settle pending detection before listener detachment/parser reset. No forced raw lease is required. Default auto eligibility must exclude synthetic EventEmitter-only TTY fixtures; tests use real readable fixtures rather than an unsafe force-enable option.
- [ ] Gate only physical writes; continue React rendering and collect ordered Static output exactly once. Retain the latest dynamic frame. Do not advance log/physical caches while pending. Include pending negotiation in `waitUntilRenderFlush()`.
- [ ] Start one 200 ms overall deadline when the first eligible physical frame is gated; waiting for raw/readable readiness counts toward it. If readiness never arrives, flush plain without querying and never restart for that instance. First query writes only `\u001B[?6n`. On first private report require column 1, terminal width >=2, and actual pending first-row text that overwrites column 1 after only safe rendition controls. Leading newline, cursor-control prefix, empty/zero-width initial content, or midline position settles plain without drawing.
- [ ] Freeze the output reservation before drawing. Emit `\u001B]66;w=1; \u001B\\\u001B[?6n\r` in one ordered write. Require the second private reply to have the same row and column 2. On support flush the reservation encoded; otherwise flush it plain. A newer empty frame must not abandon the overwrite: fulfill reservation then apply the latest replacement.
- [ ] Encode Ink-owned direct interactive `<Static>` and clear/replay output using the same encoder; keep raw fullStaticOutput/frame caches. External stdout/stderr strings are not encoded; restored Ink output is. All regular log writes already use Task 1's transform closure.
- [ ] At managed external writes, resize, public `clear()`, raw/readable readiness loss, or unmount: cancel detection before terminal ownership changes and fulfill a drawn reservation while writable. Cancel timers and prevent late callbacks from writing; preserve final-render ordering and exactly-once Static. Before drawing, fallback can flush latest pending output normally. Alternate-screen entry is constructor-only; preserve existing teardown. New instances reprobe; add no live transition or suspend/resume API.
- [ ] Add regression tests for Static during negotiation, dynamic updates becoming empty, first-row eligibility, resize/redraw, synchronous replies, startup cancellation, write errors/destroyed streams, final output, separate instances, and identical-frame behavior after capability settlement.
- [ ] Document option/default, 200 ms maximum eligible-startup delay, private-CPR requirement, input/output ownership, no-query paths, unsupported fallback, new-instance reprobe and physical-terminal limitation in `readme.md`.
- [ ] Run detector/integration/parser/Kitty tests plus log-update and lifecycle/resize/selection suites, `npm run typecheck`, `npm run build`, and changed-file formatting. Produce report and obtain independent powerful-tier review; fix Important findings with covering tests, then re-review. Do not commit.

### Task 3: Verify source and consumers; prepare real-terminal acceptance

**Consumes:** built nested Ink and completed Task 2 reports.

- [ ] Run focused OSC66/input/log lifecycle suites and the preserved geometry baseline:

```sh
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava \
  test/output-rows.test.ts test/text-width.tsx test/measure-text.tsx \
  test/borders.tsx test/overflow.tsx test/paint-selection.test.ts test/components.tsx
npm run typecheck
npm run build
```

- [ ] Report deterministic unchanged-frame work=0, changed incremental rows only, cache reuse, bounded cache/suffix behavior, and raw-vs-encoded stdout-byte overhead. Do not benchmark debug rendering as the production paint path.
- [ ] Compare hashes of preserved `src/output.ts` and `test/output-rows.test.ts` against outer `.superpowers/sdd/osc66-baseline/preserved.sha256`. Verify whitespace and no staging in both repositories.
- [ ] The CLI already resolves local nested `build/index.js`; verify resolution, then run the handoff's 27-suite CLI regression command and relevant ink-input tests. Build CLI using `pnpm --filter @nuvin/nuvin-code build`. No dependency toggle or install is needed.
- [ ] Verify exact baseline YAML/lockfile bytes remain unchanged and CLI still resolves the pre-existing local link, as explicitly confirmed by the user. Do not select published Ink or invoke the registry-upgrading `ink-mode npm` command.
- [ ] Use ignored outer `.superpowers/sdd/probe-osc66-width.mjs` (local built encoder) in normal user foreground shells. Its syntax and non-TTY refusal are tool-verifiable; real CPR measurements are not available inside tools. Ask user to measure Kitty, Terminal.app and Warp with original samples. Acceptance is actual encoded advance equals allocated width when support is negotiated, not raw-width equality. Also request near-right-edge wrap/redraw and terminal/Ink copy checks; keep physical results pending until observed.
- [ ] Write a concise verification report distinguishing source tests, consumer tests, foreground-pending acceptance, unsupported-terminal limitations, known XO missing-module issue, and publication not performed. Obtain final whole-change powerful-tier review and address any change-related Important findings.
