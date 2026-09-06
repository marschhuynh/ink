# Ink Runtime Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Planning-only. The designs are approved for implementation planning; implementation, commits, publication, dependency pinning, and release are not authorized.

**Goal:** Bound Ink's retained text-cache data, remove per-blank-cell allocation, evaluate compact private raster masks without changing exported boolean selection contracts, and free each interactive Ink root Yoga node exactly once without changing output, terminal transitions, effects, or teardown.

**Architecture:** Keep each optimization in its current owner: `measure-text.ts` and `wrap-text.ts` retain their independent LRUs, `Output` retains frame-grid ownership, `TextSelectionController.captureRows` remains the private-to-public selection boundary, and `Ink.unmount` retains interactive-root lifecycle ownership. Land no generic cache framework, object pool, bitset, cross-frame buffer scheme, terminal-diff rewrite, or new public tuning surface. Each candidate is measured and reviewed independently. I3 may be rejected under the design; an unproven I4 remains an explicit completion blocker rather than a successful omission.

**Tech Stack:** TypeScript 5.8, React 19, AVA 7, XO, `@alcalzone/ansi-tokenize`, `wrap-ansi`, `cli-truncate`, Yoga 3.2, npm in the nested Ink repository, and pnpm/Vitest for development-only outer integration.

**Approved designs:**

- Nested: `docs/superpowers/specs/2026-09-05-runtime-memory-design.md`
- Parent: `../../../../../docs/superpowers/specs/2026-09-05-tui-runtime-memory-design.md`

## Global Constraints

- Ink output parity is literal: identical committed trees/options must produce identical frame bytes and terminal transitions. The parent's approved `00000r`/`000020` Markdown collision correction belongs to outer T2 and creates no Ink behavior exception.
- Preserve every public signature, especially exported `SelectionRow = {text: string; mask?: readonly boolean[]}` and the existing `mask[cell] === false` missing/out-of-range semantics.
- Preserve wide-glyph leading/trailing cells, combining and zero-width behavior, ANSI styles, backgrounds, clipping, selectable flags, selected whitespace, static output, screen-reader output, debug output, normal/incremental output, alternate-screen effects, and `waitUntilExit()` ordering.
- Previously captured selection rows/snapshots must not change after later paint, scroll, resize, viewport switching, or teardown.
- Keep the existing 256-entry ceilings. Add independent retained-text and per-entry ceilings; do not hash source keys or introduce a shared cache service.
- Cache accounting is a conservative UTF-16 code-unit estimate (`string.length * 2`), not an assertion about exact V8 heap size. Wrapping accounting counts both its source-containing serialized key and result even when strings may share storage.
- Blank-cell sharing is private and immutable. Rows remain distinct mutable arrays; written/highlighted cells replace slots rather than mutating a shared cell or style list.
- Private byte-mask trials require I3's extent/presence proof first; fixed-width or zero-filled growth alone is unsafe. Retain booleans if proof, conversion costs, or measured benefit do not pass; no unreviewed encoding or bitsets.
- Free child Yoga nodes through the reconciler as today, then free the separately owned interactive root once. Do not alter or double-free `renderToString`'s separately correct root cleanup.
- No forced GC in timed frame loops, new debounce/throttle, lower FPS, background cleanup loop, public feature flag, broad renderer rewrite, snapshot regeneration to hide differences, or claimed savings unsupported by a recorded measurement.
- Every implementation task ends at review readiness. Do not stage or commit automatically; prior plans' commit permissions do not carry forward.
- Outer CLI dependencies and the committed override use published `@nuvin/ink@7.6.0-alpha`. A rebuilt local link is development-only; restore npm mode and leave no override/lockfile link diff. Publication/pinning is separately authorized.

## Coordination and ordering

| ID | Owner | Deliverable / dependency |
|---|---|---|
| Outer T1 | outer repository | Baseline/parity harness plus `docs/superpowers/reports/2026-09-05-tui-runtime-memory-baseline.md` and nested `docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md`. It records revisions, package resolution, exact harness commands, output-byte oracles, transition-suite results, bounded capture behavior, and measurement noise. |
| Outer T2 | outer repository | CLI Markdown/tool-preview cache work, including the approved collision regression against `enableCache: false`; not implemented in this nested plan. |
| I1 | nested repository | Ink cache calibration report section plus independently count/byte/per-entry-bounded caches. Requires T1. |
| I2 | nested repository | Immutable shared blank cell. Requires T1; independent of I1. |
| I3 | nested repository | Bounded extent/presence proof before private byte masks and cropped boolean conversion; retain booleans if unproven/rejected. Run after I2; acceptance remains independent. |
| I4 | nested repository | Exact-once interactive-root Yoga disposal, blocked on null-commit/passive-cleanup ownership addendum. Requires T1; independent of I1-I3. |
| I5 | nested + development-only outer validation | Combined review, nested build, local-link consumer validation, parity/latency comparison, and handoff to outer T3. Requires accepted/reviewed I1-I4 candidates. |
| Outer T3 | outer repository | Consumes only the reviewed, rebuilt local Ink result. Publishing or committed dependency changes remain a separate authorization. |

T1 is a hard prerequisite, not work to recreate here. There is currently no committed outer terminal-cell helper. `applyTerminalWrite` is local to `test/log-update-scroll-region.ts`; do not invent or import a nonexistent helper. T1 uses output-byte parity plus current nested transition tests. The bounded optional extraction in I5 is the only permitted route if those proofs become insufficient.

### Per-candidate provenance gate P (canonical for I1-I5 and outer T3)

Every outer candidate measurement must run inside this **one** Gate P invocation, from the active outer worktree root. I5 and outer T3 consume this gate, not copies of its link/build/restore logic. No standalone open/close tool calls: the same Bash process runs preflight → snapshot → build/link → consumer builds → the complete workload → failure-safe restoration. Do not run measurements in a later tool after this shell exits.

During later authorized validation only, save the following complete script as ignored `packages/ink/.superpowers/sdd/runtime-memory-validation/gate-p.sh` (verify `git -C packages/ink check-ignore .superpowers/sdd/runtime-memory-validation/gate-p.sh` first). No tracked product/tool script is created by this plan. Invoke with `bash packages/ink/.superpowers/sdd/runtime-memory-validation/gate-p.sh bash <ignored-workload-script>`; the workload contains that candidate's exact T1 commands, or I5 Steps 5-6 plus T1 commands. It must run synchronously, fail fast, and neither edit candidate/control files nor leave background work running. Do not overlap gate invocations or edit either worktree during a run.

```bash
#!/usr/bin/env bash
set -euo pipefail
OUTER_ROOT="$(pwd -P)"
INK_ROOT="$OUTER_ROOT/packages/ink"
export OUTER_ROOT INK_ROOT
test "$#" -gt 0
test "$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" = "$OUTER_ROOT"
test "$(cd "$(git -C "$INK_ROOT" rev-parse --show-toplevel)" && pwd -P)" = "$INK_ROOT"
# Preflight BEFORE any file creation, build, link, or install. No resetting user work.
for file in pnpm-workspace.yaml pnpm-lock.yaml; do
  git ls-files --error-unmatch -- "$file" >/dev/null
  test -f "$file" && test ! -L "$file"
  git diff --quiet -- "$file"
  git diff --cached --quiet -- "$file"
done
node --input-type=module -e '
  import {readFileSync} from "node:fs";
  if (!/^  ink: "npm:@nuvin\/ink@7\.6\.0-alpha"$/m.test(
    readFileSync("pnpm-workspace.yaml", "utf8"))) process.exit(1);
'
resolve_ink() {
  corepack pnpm --filter "$1" exec node --input-type=module -e '
    import {realpathSync, readFileSync} from "node:fs";
    import {pathToFileURL} from "node:url";
    const url = pathToFileURL(realpathSync(new URL(import.meta.resolve("ink"))));
    const pkg = JSON.parse(readFileSync(new URL("../package.json", url), "utf8"));
    if (pkg.name !== "@nuvin/ink" || pkg.version !== "7.6.0-alpha") process.exit(1);
    console.log(url.href);
  '
}
# Canonical expected URL does not require an old build to exist.
expected_ink="$(node --input-type=module -e '
  import {realpathSync} from "node:fs";
  import {pathToFileURL} from "node:url";
  console.log(pathToFileURL(realpathSync("packages/ink") + "/build/index.js").href);
')"
original_cli="$(resolve_ink @nuvin/nuvin-code)"
original_vl="$(resolve_ink @nuvin/ink-virtualized-list)"
test "$original_cli" != "$expected_ink"
test "$original_vl" != "$expected_ink"
# Capture exact original bytes and resolutions before any workspace mutation.
snapshot="$(mktemp -d "${TMPDIR:-/tmp}/ink-gate-p.XXXXXX")"
cp pnpm-workspace.yaml "$snapshot/pnpm-workspace.yaml"
cp pnpm-lock.yaml "$snapshot/pnpm-lock.yaml"
printf '%s\n' "$original_cli" > "$snapshot/cli-url"
printf '%s\n' "$original_vl" > "$snapshot/vl-url"
local_mutation_started=0
restore() {
  local status="$?" failed=0 restored_cli='' restored_vl=''
  trap - EXIT INT TERM
  set +e
  # No link-control mutation was attempted: do not overwrite files or reinstall.
  if test "$local_mutation_started" -eq 0; then
    rm -r "$snapshot"
    exit "$status"
  fi
  cd "$OUTER_ROOT" || { printf 'Recovery originals: %s\n' "$snapshot" >&2; exit 1; }
  cp "$snapshot/pnpm-workspace.yaml" pnpm-workspace.yaml || failed=1
  cp "$snapshot/pnpm-lock.yaml" pnpm-lock.yaml || failed=1
  if test "$failed" -eq 0; then
    corepack pnpm install --frozen-lockfile || failed=1
  fi
  cmp -s "$snapshot/pnpm-workspace.yaml" pnpm-workspace.yaml || failed=1
  cmp -s "$snapshot/pnpm-lock.yaml" pnpm-lock.yaml || failed=1
  restored_cli="$(resolve_ink @nuvin/nuvin-code)" || failed=1
  restored_vl="$(resolve_ink @nuvin/ink-virtualized-list)" || failed=1
  test "$restored_cli" = "$original_cli" || failed=1
  test "$restored_vl" = "$original_vl" || failed=1
  git diff --quiet -- pnpm-workspace.yaml pnpm-lock.yaml || failed=1
  git diff --cached --quiet -- pnpm-workspace.yaml pnpm-lock.yaml || failed=1
  printf 'RESTORED_CLI_INK=%s\nRESTORED_VL_INK=%s\nRESTORE_FAILED=%s\n' \
    "$restored_cli" "$restored_vl" "$failed"
  if test "$failed" -ne 0; then
    printf 'Gate P restoration blocked; exact originals retained at %s\n' "$snapshot" >&2
    exit 1
  fi
  rm -r "$snapshot"
  exit "$status"
}
# Install finally before the first potentially mutating build/link/install.
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'OUTER_ROOT=%s\nOUTER_HEAD=%s\nINK_ROOT=%s\nINK_HEAD=%s\n' \
  "$OUTER_ROOT" "$(git rev-parse HEAD)" "$INK_ROOT" "$(git -C "$INK_ROOT" rev-parse HEAD)"
node --version
npm --version
corepack pnpm --version
printf 'ORIGINAL_CLI_INK=%s\nORIGINAL_VL_INK=%s\n' "$original_cli" "$original_vl"
shasum -a 256 "$snapshot/pnpm-workspace.yaml" "$snapshot/pnpm-lock.yaml"
# Includes staged + unstaged source/config changes; print untracked inputs too.
git -C "$INK_ROOT" diff HEAD --binary -- src package.json package-lock.json tsconfig.json \
  | shasum -a 256
node --input-type=module -e '
  import {execFileSync} from "node:child_process";
  import {readFileSync} from "node:fs";
  import {createHash} from "node:crypto";
  const paths = execFileSync("git", ["ls-files", "--cached", "--others",
    "--exclude-standard", "-z", "--", "src", "package.json", "package-lock.json",
    "tsconfig.json"], {cwd: process.env.INK_ROOT}).toString().split("\0").filter(Boolean);
  for (const path of [...new Set(paths)].sort()) {
    let bytes;
    try { bytes = readFileSync(`${process.env.INK_ROOT}/${path}`); }
    catch (error) { if (error.code === "ENOENT") { console.log("DELETED", path); continue; } throw error; }
    console.log("INK_INPUT", createHash("sha256").update(bytes).digest("hex"), JSON.stringify(path));
  }
'
npm --prefix "$INK_ROOT" run build
# Hash all generated modules, not just index.js (which mostly re-exports them).
find "$INK_ROOT/build" -type f -exec shasum -a 256 {} \; | LC_ALL=C sort
# Equivalent to Makefile ink-local, using the repository's pinned pnpm toolchain.
local_mutation_started=1 # Own recovery BEFORE a partial rewrite/install can fail.
node scripts/ink-mode.mjs local
corepack pnpm install --no-frozen-lockfile
cli_ink="$(resolve_ink @nuvin/nuvin-code)"
vl_ink="$(resolve_ink @nuvin/ink-virtualized-list)"
printf 'EXPECTED_INK=%s\nCLI_INK=%s\nVL_INK=%s\n' "$expected_ink" "$cli_ink" "$vl_ink"
test "$cli_ink" = "$expected_ink"
test "$vl_ink" = "$expected_ink"
corepack pnpm --filter @nuvin/ink-input build
corepack pnpm --filter @nuvin/ink-text-input build
corepack pnpm --filter @nuvin/ink-virtualized-list build
corepack pnpm --filter @nuvin/nuvin-code build
"$@"
```

Keep the complete log (including restoration) beside each candidate result, with the exact workload script/commands and outer T1 revision/diff provenance. Exact canonical URL equality for **both CLI and VL**, input hashes (including staged/untracked source), and generated-module hashes identify the active candidate; suffix matching or `index.js` hashing alone is insufficient. Any ignored source/build input or changed compiler configuration outside the enumerated inputs requires explicit additional provenance before admitting a result. Gate P fails if original installs/resolutions are missing, controls are dirty/staged, or the baseline is not the approved published version; stop rather than normalize them.

Restoration is byte-for-byte from the saved originals plus `corepack pnpm install --frozen-lockfile`, then exact original CLI/VL resolution equality, not merely “not local”. Never invoke `make ink-npm` or `scripts/ink-mode.mjs npm`: that branch queries npm latest and can silently change the approved baseline. Preflight failures never arm restoration; a build failure before local mutation only removes the owned snapshot, without rewriting controls or installing. Partial local rewrite/install and measurement failures both enter restoration. Install/restoration failure blocks handoff even if measurements passed; retained backups permit explicit recovery without checkout/reset/clean. Uncatchable termination (e.g. SIGKILL) requires the same manual exact-byte/frozen-install recovery before any next validation.

A proven nested-only harness may instead import current `src` modules directly, but must print canonical imported module URLs, nested HEAD, and staged/unstaged/untracked input hashes. That alternative is only nested evidence; it cannot establish real outer CLI/VL resolution.

All nested command blocks below run from the active nested root. In a shell starting at the active outer root, set `OUTER_ROOT="$(pwd -P)"; INK_ROOT="$OUTER_ROOT/packages/ink"` and verify the two Git roots as in Gate P before `cd "$INK_ROOT"`. Do not reuse a path from another worktree.

## File Structure

### Nested Ink repository (`packages/ink`)

- Modify `src/measure-text.ts` — keep the current LRU and add calibrated entry/total byte admission and exact accounting.
- Modify `src/wrap-text.ts` — keep complete source/width/mode keys and add calibrated entry/total byte admission and exact accounting.
- Modify `test/text-cache.ts` — deterministic count/byte, Unicode, oversize, hit/eviction/clear, key distinction, and cached/uncached parity tests.
- Modify `docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md` — append measured cache calibration, chosen literal constants, candidate evidence, and decisions; T1 creates the file first.
- Modify `src/output.ts` — shared frozen blank cell; byte-mask changes only after I3's extent/presence proof is reviewed.
- Modify `test/output-rows.test.ts` — blank identity/immutability, row independence, frame stability, wide overwrite, overflow/gap parity, and conditional private-representation tests.
- Conditionally modify `src/paint-selection.ts` — only I3's reviewed private-mask reader, preserving explicit-true-only highlighting.
- Modify `test/paint-selection.test.ts` — blank/highlight isolation and conditional private-mask parity.
- Conditionally modify `src/text-selection-controller.ts` — only I3's reviewed cropped conversion preserving logical extent and sparse/missing semantics at `captureRows`.
- Modify `test/text-selection-controller.test.ts` — conversion, viewport cropping, out-of-range behavior, and captured ownership.
- Modify `test/text-selection.test.ts` — preserve exported `SelectionRow` boolean type and strict-false semantics.
- Conditionally modify `src/ink.tsx` — exact-once root disposal only after I4's null-commit/passive-cleanup ownership addendum is reviewed.
- Modify `test/render.tsx` — deterministic Yoga root free-count/order tests across legacy, concurrent, initial-effect exits, repeated, pending, error, and process-exit teardown.
- Optional create `test/helpers/terminal-screen.ts` and modify `test/log-update-scroll-region.ts` only if I5's byte/transition proof is inconclusive; move the current local model without behavior changes before using it from an ignored nested validator.

### Outer repository (validation only; owned by T1/T3)

- Consume T1's helpers under `packages/cli/src/test-support/` and its explicitly invoked benchmark scripts. Do not place imported benchmark helpers outside CLI `src`, because `packages/cli/tsconfig.json` has `rootDir: "./src"` and would report TS6059.
- Vitest only discovers `packages/cli/src/**/*.test.{ts,tsx}`. Do not assume scripts or `src/test-support` run as tests; invoke the T1 command recorded in its report.
- If I5 needs the optional terminal model, create only an ignored validator under `packages/ink/.superpowers/sdd/runtime-memory-validation/`; it may import the newly extracted nested test helper and outer T1 fixture support. No tracked outer test may import nested repository test code.
- Do not modify tracked outer source, snapshots, `pnpm-workspace.yaml`, or `pnpm-lock.yaml` in this plan.

---

### Task I1: Calibrate and bound the two existing text caches

**Files:**

- Modify: `src/measure-text.ts:3-44`
- Modify: `src/wrap-text.ts:5-67`
- Modify: `test/text-cache.ts:1-22`
- Modify: `docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md`
- Do not modify: `src/diagnostics.ts`, `src/index.ts`, wrapping/measurement algorithms, or public options

**Interfaces:**

- Consumes: T1b's nested baseline report and exact recorded harness commands; T1c's trial/acceptance procedure (not pre-accepted constants); current `measureText(text: string): {width: number; height: number}`; current `wrapText(text: string, maxWidth: number, wrapType: Styles['textWrap']): string`.
- Preserves: `measureTextCacheMax = 256`, `wrapTextCacheMax = 256`, `getMeasureTextCacheSize(): number`, `getWrapTextCacheSize(): number`, and public `InkCacheSizes` count-only shape.
- Produces internally for focused tests: `measureTextCacheMaxBytes`, `measureTextCacheMaxEntryBytes`, `getMeasureTextCacheRetainedBytes(): number`, `clearMeasureTextCache(): void`, and wrapping equivalents named `wrapTextCacheMaxBytes`, `wrapTextCacheMaxEntryBytes`, `getWrapTextCacheRetainedBytes(): number`, `clearWrapTextCache(): void`.
- Internal test-only recency snapshots: `getMeasureTextCacheKeys(): readonly string[]` and `getWrapTextCacheKeys(): readonly string[]`, each returning `[...cache.keys()]`; no live Map exposure or public re-export.
- Accounting rule: measurement entry bytes are `text.length * 2`; wrapping entry bytes are `(cacheKey.length + wrappedText.length) * 2`, where `cacheKey` remains `JSON.stringify([text, maxWidth, wrapType])`.

- [ ] **Step 1: Enforce T1b/T1c prerequisites and select provisional trial constants**

From the outer root, verify both reports exist. The nested report must identify published `7.6.0-alpha`, the nested source revision, Node version, production renderer options, 120x40 and 200x60 geometries, bounded stdout capture, warmups, at least five isolated latency runs with at least 30 committed samples, separate post-GC retained/allocation/peak/RSS fields, and a separately labeled direct-fixture charge distribution for Ink's two text functions:

```bash
test -f docs/superpowers/reports/2026-09-05-tui-runtime-memory-baseline.md
test -f packages/ink/docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md
grep -n "7.6.0-alpha\|120x40\|200x60\|Node\|revision\|command" \
  packages/ink/docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md
grep -n "direct-fixture" \
  packages/ink/docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md
```

Stop if T1 is absent, package resolution is ambiguous, output captures grow without bound, baseline variability is not established, or the direct-fixture distribution is absent. Do not substitute the existing unbounded write logs or a guessed renderer-wide cache-traffic histogram for this bounded input.

Append a **provisional Ink trial protocol** section before RED/product-source implementation. Its size input is only T1b's deterministic representative direct fixtures: known strings passed directly to `measureText`, plus known string/width/mode tuples passed directly to `wrapText`. Compute measurement charge as `text.length * 2`; compute each wrapping charge from the known `JSON.stringify([text, maxWidth, wrapType])` key and the actual returned wrapped string as `(cacheKey.length + wrappedText.length) * 2`. Label these as direct-fixture distributions, not end-to-end cache traffic, renderer-wide hit rates, warm working-set retention, or candidate performance. They require neither budget controls nor new instrumentation APIs.

Choose and record four **provisional trial constants**, clearly labeled non-accepted. For each cache, set the initial per-entry trial to the next power of two at or above the direct-fixture p95 charge; set the initial total trial to the next power of two at or above the sum of the representative distinct fixture charges, considering no more than the existing 256-entry cap. Record adjacent lower/higher powers of two as the bounded candidate sweep; discard nonpositive pairs and pairs where per-entry exceeds total. This yields at most nine pairs per cache. If the direct-fixture p95 or summed charge is missing, stop rather than guessing. These values only compile and exercise the first real size-aware cache; they make no claim about actual UI traffic, savings, or accepted budgets.

The report must contain four literal, copy-ready provisional TypeScript declarations before Step 2. I1 then implements the actual caches with those internal constants. Only after those controls exist does Step 7 run real long-text render, warm UI hit/retention, remount, and scroll calibration while varying the source constants; Step 8 replaces provisional literals with the smallest passing accepted constants before review. No constructor, environment variable, public option, dynamic renderer histogram, or nonexistent pre-implementation budget API is required.

- [ ] **Step 2: Write focused failing cache tests**

Replace shared-state assumptions with explicit cleanup, import the four provisional internal constants and accounting helpers, and add these concrete cases:

```ts
import cliTruncate from 'cli-truncate';
import widestLine from 'widest-line';
import wrapAnsi from 'wrap-ansi';
import measureText, {
	clearMeasureTextCache,
	getMeasureTextCacheRetainedBytes,
	getMeasureTextCacheSize,
	measureTextCacheMax,
	measureTextCacheMaxBytes,
	measureTextCacheMaxEntryBytes,
} from '../src/measure-text.js';
import wrapText, {
	clearWrapTextCache,
	getWrapTextCacheRetainedBytes,
	getWrapTextCacheSize,
	wrapTextCacheMax,
	wrapTextCacheMaxBytes,
	wrapTextCacheMaxEntryBytes,
} from '../src/wrap-text.js';

test.beforeEach(() => {
	clearMeasureTextCache();
	clearWrapTextCache();
});

test.after.always(() => {
	clearMeasureTextCache();
	clearWrapTextCache();
});

const uncachedWrap = (
	text: string,
	width: number,
	mode: 'wrap' | 'hard' | 'truncate' | 'truncate-middle' | 'truncate-start',
): string => {
	if (mode === 'wrap') return wrapAnsi(text, width, {trim: false, hard: true});
	if (mode === 'hard') {
		return wrapAnsi(text, width, {trim: false, hard: true, wordWrap: false});
	}

	const position =
		mode === 'truncate-middle'
			? 'middle'
			: mode === 'truncate-start'
				? 'start'
				: 'end';
	return cliTruncate(text, width, {position});
};
```

Convert the two existing count-bound cases and every new case in `test/text-cache.ts` to `test.serial(...)`. The module-level caches and clear hooks are shared process state; explicit serialization prevents one case from clearing another case's cache even if AVA execution settings change.

```ts
test.serial('measureText bypasses oversized Unicode entries without changing output', t => {
	const text = '界'.repeat(Math.floor(measureTextCacheMaxEntryBytes / 2) + 1);
	t.deepEqual(measureText(text), {
		width: widestLine(text),
		height: text.split('\n').length,
	});
	t.is(getMeasureTextCacheSize(), 0);
	t.is(getMeasureTextCacheRetainedBytes(), 0);
});

test.serial('wrapText bypasses oversized entries and matches the uncached oracle', t => {
	const text = '🙂ab '.repeat(Math.floor(wrapTextCacheMaxEntryBytes / 8) + 1);
	const expected = uncachedWrap(text, 17, 'hard');
	t.is(wrapText(text, 17, 'hard'), expected);
	t.is(getWrapTextCacheSize(), 0);
	t.is(getWrapTextCacheRetainedBytes(), 0);
});

test.serial('cache hits, eviction, and clear keep accounting exact and bounded', t => {
	measureText('界a');
	const measuredBytes = getMeasureTextCacheRetainedBytes();
	t.is(measuredBytes, '界a'.length * 2);
	measureText('界a');
	t.is(getMeasureTextCacheRetainedBytes(), measuredBytes);

	const wrapped = wrapText('alpha beta', 5, 'wrap');
	const key = JSON.stringify(['alpha beta', 5, 'wrap']);
	const wrappedBytes = (key.length + wrapped.length) * 2;
	t.is(getWrapTextCacheRetainedBytes(), wrappedBytes);
	wrapText('alpha beta', 5, 'wrap');
	t.is(getWrapTextCacheRetainedBytes(), wrappedBytes);

	clearMeasureTextCache();
	clearWrapTextCache();
	t.is(getMeasureTextCacheSize(), 0);
	t.is(getMeasureTextCacheRetainedBytes(), 0);
	t.is(getWrapTextCacheSize(), 0);
	t.is(getWrapTextCacheRetainedBytes(), 0);
});
```

The former near-entry-limit wrapping loop is invalid: its source-containing JSON key **plus wrapped result and inserted newlines** can exceed the entry ceiling, leaving an empty cache and vacuous upper-bound assertions. Add this separate total-budget/LRU fixture, using actual uncached charges to construct admissible equal-charge entries (fixed-width ASCII IDs keep charges equal):

```ts
test.serial('wrapText total budget evicts the least-recent admissible entry', t => {
	const target = Math.min(wrapTextCacheMaxEntryBytes, Math.floor(wrapTextCacheMaxBytes / 2));
	const fixture = (id: number, length: number) => {
		const text = String(id).padStart(3, '0') + ':' + 'w'.repeat(length);
		const key = JSON.stringify([text, 20, 'hard']);
		const result = uncachedWrap(text, 20, 'hard');
		return {text, key, result, charge: (key.length + result.length) * 2};
	};
	// ASCII hard-wrap charge is monotone; search by measured charge, not source length.
	let low = 0;
	let high = Math.floor(target / 2);
	if (fixture(0, low).charge > target) {
		t.fail('budget must admit the fixture');
		return;
	}
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fixture(0, middle).charge <= target) low = middle;
		else high = middle - 1;
	}
	const charge = fixture(0, low).charge;
	const count = Math.floor(wrapTextCacheMaxBytes / charge) + 1;
	if (count < 3 || count > wrapTextCacheMax) {
		t.fail('must exercise byte eviction before count eviction');
		return;
	}
	const entries = Array.from({length: count}, (_, id) => fixture(id, low));
	for (const entry of entries) {
		t.is(entry.charge, charge);
		t.true(entry.charge <= wrapTextCacheMaxEntryBytes);
		t.true(entry.charge <= wrapTextCacheMaxBytes);
	}
	t.true((count - 1) * charge <= wrapTextCacheMaxBytes);
	t.true(count * charge > wrapTextCacheMaxBytes);
	for (const [index, entry] of entries.slice(0, -1).entries()) {
		t.is(wrapText(entry.text, 20, 'hard'), entry.result);
		t.is(getWrapTextCacheSize(), index + 1);
		t.is(getWrapTextCacheRetainedBytes(), (index + 1) * charge);
	}
	const first = entries[0]!;
	const last = entries.at(-1)!;
	t.is(wrapText(first.text, 20, 'hard'), first.result); // Refresh A: B is now oldest.
	t.is(getWrapTextCacheRetainedBytes(), (count - 1) * charge);
	t.deepEqual(getWrapTextCacheKeys(), [...entries.slice(1, -1).map(entry => entry.key), first.key]);
	t.is(wrapText(last.text, 20, 'hard'), last.result);
	t.is(getWrapTextCacheSize(), count - 1); // Nonempty, exact, not just <= a ceiling.
	t.is(getWrapTextCacheRetainedBytes(), (count - 1) * charge);
	t.deepEqual(getWrapTextCacheKeys(), [...entries.slice(2, -1).map(entry => entry.key), first.key, last.key]);
});
```

Import/implement only an internal direct-module test helper `getWrapTextCacheKeys(): readonly string[]`, returning a newly allocated `[...cache.keys()]` in LRU order; never export it through `src/index.ts` or public diagnostics. This narrow observation proves the **exact victim and hit recency**, which equal-charge count/byte assertions cannot distinguish. Repeat the same deterministic model for measurement entries with charge `text.length * 2` and an analogous internal `getMeasureTextCacheKeys` helper. Verify clear resets both count and charge, and hits do not double-charge. Keep separate admissible small-entry count-ceiling fixtures and oversized bypass tests; no hardware-dependent heap assertion belongs here.

If a trial's total budget is unreachable before 256 admissible entries (or too small for these fixtures), stop and record that binding-constraint issue; do not label bypass/count eviction as successful byte-eviction evidence or skip the preconditions into a pass. Use a separately reviewed internal test seam only if needed to exercise a mathematically redundant limit, not a new public budget knob. Rerun fixture preconditions for the accepted literals.

Add a `test.serial(...)` table-driven case over `''`, ASCII, CJK, emoji, combining text, widths `1/5/20`, and every current wrap mode. For each case, clear before the first call, compare against `uncachedWrap`, call again warm, and require the same result/accounting. Include the same source at different widths/modes to prove keys remain distinct. Empty-string output must be a real hit with stable accounting rather than relying on truthiness.

- [ ] **Step 3: Run the focused tests and verify RED**

```bash
cd "$INK_ROOT"
NODE_ENV=test npm exec -- ava test/text-cache.ts
```

Expected: compilation/test failure because the byte constants and accounting/clear helpers do not exist. Existing count-bound assertions must remain present.

- [ ] **Step 4: Implement minimal independent accounting in `measure-text.ts`**

Copy the report's two provisional measurement declarations verbatim. Keep accounting in this file; do not create a cache class. Use a record so every delete knows its exact contribution:

```ts
type CacheEntry = {
	dimensions: Output;
	retainedBytes: number;
};

const cache = new Map<string, CacheEntry>();
let cacheRetainedBytes = 0;

const deleteCached = (text: string): void => {
	const existing = cache.get(text);
	if (!existing) return;
	cache.delete(text);
	cacheRetainedBytes -= existing.retainedBytes;
};

const admit = (text: string, dimensions: Output): void => {
	const retainedBytes = text.length * 2;
	deleteCached(text);
	if (
		retainedBytes > measureTextCacheMaxEntryBytes ||
		retainedBytes > measureTextCacheMaxBytes
	) {
		return;
	}

	cache.set(text, {dimensions, retainedBytes});
	cacheRetainedBytes += retainedBytes;
	while (
		cache.size > measureTextCacheMax ||
		cacheRetainedBytes > measureTextCacheMaxBytes
	) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) break;
		deleteCached(oldestKey);
	}
};
```

On a hit, delete/reinsert the same record for LRU recency without changing `cacheRetainedBytes`. On a miss, compute with the existing `widestLine`/newline logic and call `admit`. Export exact reads/clear without changing `src/diagnostics.ts`:

```ts
export const getMeasureTextCacheRetainedBytes = (): number =>
	cacheRetainedBytes;

export const clearMeasureTextCache = (): void => {
	cache.clear();
	cacheRetainedBytes = 0;
};
```

- [ ] **Step 5: Implement the corresponding local accounting in `wrap-text.ts`**

Copy the report's two provisional wrapping declarations verbatim. Keep the existing serialized key and wrapping/truncation branches. Store `{wrappedText, retainedBytes}` and calculate only after the result exists:

```ts
type CacheEntry = {
	wrappedText: string;
	retainedBytes: number;
};

const cache = new Map<string, CacheEntry>();
let cacheRetainedBytes = 0;

const retainedBytesFor = (cacheKey: string, wrappedText: string): number =>
	(cacheKey.length + wrappedText.length) * 2;
```

Use `cache.get(cacheKey) !== undefined`, not truthiness, so cached empty results refresh LRU correctly. Admission, replacement, oldest-entry eviction, and clear mirror the measurement logic using the current provisional—and ultimately accepted—wrapping limits. Export only the internal direct-module helpers named in Interfaces; do not add them to `src/index.ts` or `InkCacheSizes`.

- [ ] **Step 6: Verify GREEN with the provisional real caches**

```bash
NODE_ENV=test npm exec -- ava test/text-cache.ts test/measure-text.tsx test/text.tsx
npm run typecheck
npm run lint
```

Expected: all commands pass with the provisional constants; both retained counters are nonnegative and at/below their current trial budgets; cache/no-cache oracles are byte-for-byte identical. This GREEN establishes a working trial implementation, not accepted constants or measured savings.

- [ ] **Step 7: Calibrate the implemented caches with actual rendering**

Before **every** constant-pair trial using an outer workload, invoke canonical Gate P with that trial's complete workload; wait for its exact restoration before changing constants. A direct-source nested result must use gate P's nested-only provenance alternative and cannot stand in for warm outer UI evidence.

Use the exact T1 commands recorded in the nested report. Evaluate at most nine pairs per cache, varying one cache while the other remains at its provisional value; then verify the two selected values together. For each pair, temporarily change only that cache's two internal source constants, rebuild as required by the recorded harness, and run actual long-text render, warm remount, and warm scroll workloads in isolated processes with identical revisions/options/payload/geometries. Do not add a runtime knob or simulate hit rates instead of executing the real caches.

Record per candidate: literal constants, final entry counts, conservative retained estimate, post-GC heap, allocation/peak observations, exact output-byte comparison, and at least five isolated latency runs with per-run median/p95. Do not require admission/eviction event counters that the cache does not expose. The selection rule is the smallest pair that (a) preserves small-entry/warm fixture reuse, (b) gives a repeatable target retention improvement, (c) preserves exact output bytes, and (d) has no repeatable latency regression outside T1 baseline noise. A noisy or inconclusive result is not passing evidence.

- [ ] **Step 8: Freeze accepted literals and rerun deterministic verification**

Replace the provisional declarations in both source files with the selected literal values and update the report labels from provisional to accepted, preserving the raw trial table. Then run:

```bash
NODE_ENV=test npm exec -- ava test/text-cache.ts test/measure-text.tsx test/text.tsx
npm run typecheck
npm run lint
```

Expected: all commands pass with exactly the accepted literals recorded in the report. If no candidate passes, restore only I1 source/test changes, retain the original count-only cache behavior, and record I1 as rejected; do not freeze arbitrary trial values or weaken parity/latency gates.

- [ ] **Step 9: Prepare I1 for independent review (no commit)**

```bash
git diff --check
git status --short
git diff -- src/measure-text.ts src/wrap-text.ts test/text-cache.ts \
  docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md
```

Review packet: baseline-derived provisional constants, all actual-cache trials, selected accepted literals (or rejection), red/green output, parity evidence, latency distributions, and the scoped diff. Stop for review; do not stage or commit.

---

### Task I2: Share one immutable blank cell while keeping rows independent

**Files:**

- Modify: `src/output.ts:226-255,357-409`
- Modify: `test/output-rows.test.ts`
- Modify: `test/paint-selection.test.ts`

**Interfaces:**

- Consumes: `StyledChar`, the existing `StyledChar[][]` paint grid, slot-replacement writers in `Output.get`, and `paintSelection`'s existing cell replacement.
- Produces: one module-private frozen blank `StyledChar` and one frozen empty `StyledChar['styles']` array shared only by untouched/cleared blank slots.
- Preserves: independent row arrays, `Output.get()` return shape, output bytes, plain rows, boolean masks until I3, and all written/styled cell behavior.

- [ ] **Step 1: Add failing identity, immutability, and isolation tests**

Add to `test/output-rows.test.ts`:

```ts
test('blank cells share one frozen value but rows remain independent', t => {
	const output = new Output({width: 4, height: 2});
	output.get({
		paint(grid) {
			const blank = grid[0]![0]!;
			t.is(grid[0]![1], blank);
			t.is(grid[1]![0], blank);
			t.not(grid[0], grid[1]);
			t.true(Object.isFrozen(blank));
			t.true(Object.isFrozen(blank.styles));

			grid[0]![0] = {...blank, value: 'x', styles: []};
			t.is(grid[0]![1]!.value, ' ');
			t.is(grid[1]![0]!.value, ' ');
		},
	});
});

test('a later frame cannot observe prior blank-slot replacement', t => {
	const output = new Output({width: 3, height: 1});
	output.get({paint: grid => void (grid[0]![0] = {...grid[0]![0]!, value: 'x'})});
	t.is(output.get().output, '');
});

test('wide-glyph boundary repair replaces only affected cells', t => {
	const output = new Output({width: 5, height: 1});
	output.write(0, 0, '中', {transformers: [], selectable: true});
	output.write(1, 0, 'a', {transformers: []});
	t.is(output.get().output, ' a');
});
```

Extend `test/paint-selection.test.ts` with two equal blank-padded rows, select selectable spaces written into only one row, and assert inverse styling appears only in that row. This catches mutation of either the shared blank or its style list.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
NODE_ENV=test npm exec -- ava test/output-rows.test.ts test/paint-selection.test.ts \
  --match='*blank*' --match='*wide-glyph boundary repair*'
```

Expected: the identity/frozen assertion fails because current initialization creates one object and style array per cell. The output-isolation assertions document behavior that must remain green.

- [ ] **Step 3: Add the frozen singleton and fill each distinct row with it**

Near `GetOptions` in `src/output.ts`, create mutable-compatible dependency types and freeze them at runtime without an unsafe cast:

```ts
const blankStyles: StyledChar['styles'] = [];
Object.freeze(blankStyles);

const blankCell: StyledChar = {
	type: 'char',
	value: ' ',
	fullWidth: false,
	styles: blankStyles,
};
Object.freeze(blankCell);
```

Replace only the nested per-cell object loop:

```ts
for (let y = 0; y < this.height; y++) {
	output.push(Array.from({length: this.width}, () => blankCell));
	mask.push(Array.from({length: this.width}, () => false));
}
```

Reuse `blankCell` for wide-character boundary cleanup instead of allocating the local `spaceCell`. Keep parsed character objects and wide trailing placeholders unchanged. Every writer must continue assigning `currentLine[index] = value`; no code may mutate `.value`, `.fullWidth`, or `.styles` in place. `paintSelection` already replaces with `{...cell, styles: [...cell.styles, inverseCode]}` and must remain replacement-based.

- [ ] **Step 4: Verify frame behavior and broad grid writers**

```bash
NODE_ENV=test npm exec -- ava \
  test/output-rows.test.ts \
  test/paint-selection.test.ts \
  test/background.tsx \
  test/border-backgrounds.tsx \
  test/borders.tsx \
  test/overflow.tsx \
  test/padding.tsx \
  test/text-width.tsx
npm run typecheck
npm run lint
```

Expected: all pass with unchanged output. The identity test is deterministic allocation evidence: equal-sized frames use one blank object/style list rather than one per untouched cell. Do not translate that fact into an unmeasured heap-savings number.

- [ ] **Step 5: Compare I2 alone against T1 and prepare review (no commit)**

Run every outer T1 allocation/latency command for the I2-only candidate inside canonical Gate P; require its CLI/VL provenance and exact restoration before the keep/reject decision.

Run the exact T1 allocation and latency commands with equal frame counts and payloads, append the raw result and output-byte equality to the nested report, then inspect:

```bash
git diff --check
git diff -- src/output.ts test/output-rows.test.ts test/paint-selection.test.ts \
  docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md
```

Keep only if output/transition parity is exact, per-blank allocations are removed, and latency has no repeatable regression. Stop for independent I2 review; do not stage or commit.

---

### Task I3: Prove private-mask extent and missing semantics before a byte-mask trial

**Files (conditional on the proof gate):** `src/output.ts`, `src/paint-selection.ts`, `src/text-selection-controller.ts`; focused tests in `test/output-rows.test.ts`, `test/paint-selection.test.ts`, `test/text-selection-controller.test.ts`, and `test/text-selection.test.ts`. Keep `src/text-selection.ts` and `src/index.ts` unchanged.

**Disposition:** No executable fixed-width byte-mask conversion is approved by this plan. Retain current boolean raster masks unless the bounded proof/review below establishes a safe representation within nested design §6. Rejecting I3 remains explicitly permitted; changing output extent or public missing semantics is not.

**Source findings:** `Output.get` initializes in-width mask slots to `false` (`src/output.ts:239-254`), but actual writes at `379-399` assign beyond `this.width`, growing ordinary arrays. Transformers run after clipping (`344-348`) and may increase the written extent. Wide placeholders also extend rows; boundary repair writes false at `375-376,406-408`. A write starting beyond the current length creates **holes** between the old end and that write. Initial false slots, new holes, explicitly written false/true, and access beyond logical length are not interchangeable. Public selection treats only `mask[cell] === false` as unselectable; missing entries remain selectable. Painting instead requires `maskRow[x] === true` (`src/paint-selection.ts:37-39`), so both false and holes are non-highlighted. Do not unify these distinct readers.

`new Uint8Array(width)` silently drops overflow stamps. Growing and copying into a larger zero-filled buffer still turns sparse gaps into false on conversion. Neither preserves the approved behavior, and cropping to the nominal width or padding holes with false is forbidden. The old fixed-width conversion recipe is withdrawn, not left as a runnable Step 3/4.

- [ ] **Step 1: Establish boolean-reference fixtures before any representation change**

Add focused behavior fixtures using current boolean arrays, then keep them as the candidate oracle:

- Width 2, height 1: write selectable `abcd` at x=0 without a clip. Require mask length 4 and four true stamps, and preserve literal output/plain-row bytes and visual extent. Repeat with false writes/overwrites beyond x=2.
- Width 2: write `x` at x=0 with a transformer returning `abcd`; repeat with an explicit horizontal clip applied before the transformer. Require current post-transform overflow, not new clipping.
- Width 2: write `中` at x=1; require the leading and trailing placeholder stamps at indices 1 and 2, logical length 3, and identical copy/highlight behavior when either cell is selected. Overwrite the trailing cell and then the leading cell to exercise both boundary repairs. Repeat for a transformer producing wide text across the edge.
- Width 2: write selectable `a` at x=4. Require length 5, own false slots 0/1, **absent** slots 2/3 (`Object.hasOwn` false), and true at 4. Repeat with false, a wide glyph at x=4 (length 6), and later writes into just one hole. Do not infer mask coordinates from the plain string: serialization filters missing grid slots (`419-424,437`); preserve that existing behavior literally.
- Feed matched sparse boolean reference masks through `captureRows` and public selection, including `{text: 'abc', mask: [false]}`, omitted masks/rows, a hole within the selected range, and beyond-length access. Require exact copied text and highlight bytes separately; public missing-selectable behavior must not become private missing-highlighted behavior.
- Crop across initialized slots, sparse overflow gaps, actual writes, and beyond logical extent. Preserve existing `sliceMask` (`489-500`) array-slice length, hole positions and `ToIntegerOrInfinity`/relative-index behavior, including fractional/NaN/infinite viewport inputs. Preserve the `width === Infinity` slice-to-end branch and current coordinate/sliceRow behavior.
- Verify captured booleans are newly owned and unchanged after subsequent writes, raster growth, paint, scroll, resize, viewport switching, and teardown. Keep exported `readonly boolean[]` type fixtures and the numeric-mask rejection fixture; do not expose a typed view or use casts.

These parity fixtures should pass with booleans. A later candidate-specific representation assertion provides RED only after a representation is reviewed; do not claim baseline behavior fixtures themselves must fail.

- [ ] **Step 2: Bounded representation proof/review gate (before product edits)**

Audit all writes/reads in the three owning modules and the renderer capture/paint call sites. Submit one focused I3 evidence section specifying an **exact** private row shape and operations: capacity versus actual logical written length, presence versus value for sparse gaps, initial false initialization, growth at every leading/placeholder/repair write, and handling of every supported index. Specify the cropped conversion algorithm using logical length (not capacity), preserving holes and omitted rows without a temporary full-width boolean array, and private highlight reads that accept only explicitly true cells. Any extra presence representation or encoding must be reviewed against design §6's initial byte-row/explicit 0/1 scope; this plan does not silently authorize a sentinel encoding, bitset, or hybrid redesign.

Prove each Step 1 fixture against the unchanged boolean oracle, including exact output, logical extent, own-slot presence, selected text, and highlight bytes. Count growth/presence storage and cropped conversion in allocation/latency evidence, not only nominal byte-buffer size. If the safe representation is not proven within this bounded owner audit, or needs a new design choice, record **“I3 rejected/deferred; boolean raster retained”** and stop I3 product edits. Request a focused implementation addendum for any further representation proposal; do not weaken approved correctness goals.

- [ ] **Step 3: Only after proof approval, implement the reviewed representation and verify**

Write the candidate-specific failing tests, apply only the approved owner changes, then run:

```bash
NODE_ENV=test npm exec -- ava \
  test/output-rows.test.ts test/paint-selection.test.ts \
  test/text-selection.test.ts test/text-selection-controller.test.ts \
  test/text-selection-hook.test.tsx test/fork-scroll.tsx test/vlbox.tsx
npm run typecheck
npm run build
grep -n "mask.*readonly boolean" build/text-selection.d.ts
```

Expected: exact parity including overflow/gaps, one cropped owned boolean conversion, unchanged public declarations, no unsafe casts, no new clipping. Run I3-only T1 frame/interaction/allocation/latency workloads **inside canonical Gate P**; no independent link/restore sequence. Include active drag across scroll/resize, select-all/copy, cached offscreen rows, and viewport switching with equal frame counts and no timed-loop GC. Keep only a meaningful measured benefit with no repeatable latency regression; neutral/noisy/inconclusive results reject I3. Restore only I3 changes, not I2's shared blank work, on rejection.

- [ ] **Step 4: Independent I3 review (no commit)**

Review the exact representation proof/addendum, RED/GREEN results, output/selection/highlight parity, actual extent and sparse semantics, capture ownership, complete allocation costs, Gate P provenance/restoration, and keep/reject evidence. Record unresolved proof or rejection explicitly; no source implementation is implied by this planning-only document.

---

### Task I4: Prove the null-commit and passive-cleanup ownership barrier

**Files (conditional on a reviewed implementation addendum):** `src/ink.tsx`, `test/render.tsx`; audit `src/reconciler.ts`, installed `react-reconciler` development **and production** builds, and `src/render-to-string.ts` without changing them. Run existing exit/terminal/lifecycle suites.

**Disposition:** Exact-once interactive-root disposal remains an approved goal, but implementation is **blocked on a focused I4 ownership proof/addendum**. Do not publish or implement a guessed disposer after `flushSyncWork()` or before `instances.delete`. Unlike the approved I3 rejection option, leaving the root unchanged pending proof is an open I4 blocker, not successful completion or a reduced correctness target.

**Source findings:** `Ink.unmount` (`810-950`) performs final layout/render, marks unmounted, settles log throttles/restores console, submits a null update, and calls `finishUnmount`. React's installed `flushSyncWork` (development `14539-14543`; corresponding production implementation) skips work inside Render/CommitContext. Both initial `useLayoutEffect` and `useEffect` can call `exit()` in commit context; the null update then commits later. That commit invokes `resetAfterCommit` → `rootNode.onComputeLayout` (`src/reconciler.ts:243-245`) → `calculateLayout` (`src/ink.tsx:583-594`), which still dereferences the root even though `onRender` separately guards `isUnmounted`. Freeing/clearing root in the current `finishUnmount` can therefore cause use-after-free/undefined layout. An optional passive flush call is not proof of completion: React runs passive unmount/mount effects in CommitContext and rejects reentrant flushing (development `15913-15914,15975-16025`).

**Required invariant:** Native root free must follow the **actual null commit**, reconciler child removal/free, completion of all required passive cleanup, and every final layout-dependent action; it occurs exactly once without swallowing free errors. Preserve existing final-frame/static/debug/non-interactive bytes, console restoration, resize/kitty/cursor/alternate-screen transitions, error propagation, instance ownership, stdout write-barrier behavior, and `waitUntilExit` resolution/rejection ordering, including synchronous process-exit handling (`927-932`). `renderToString` keeps its independent cleanup unchanged.

- [ ] **Step 1: Add deterministic lifecycle probes/tests before product changes**

Use serial Sinon Yoga instrumentation, scoped/restored in `finally`, wrapping `Yoga.Node.create` and the **new root's** `free` inside the creation wrapper, before returning it. Installing the free observer after `render()` misses initial-effect exit. Do not spy on an arbitrary later child or add a product test hook. Record an event trace of root creation, layout calls, null commit/child removal, layout/passive cleanup, native free, terminal writes, and exit settlement; assert no Yoga calls after free. Call the original native methods; assert child count zero immediately before free, never by querying an already freed node.

Add the Cartesian matrix `{concurrent: false/true}` × `{initial useEffect / initial useLayoutEffect}` × `{exit() / exit(new Error('boom'))}`. Each fixture exits **inside its first effect**, returns an effect cleanup marker, and includes child layout/passive cleanup markers (including cleanup returned after the exit call). Do not wait for an initial render flush before installing observers or triggering exit. Await `waitUntilExit` with resolve/reject assertions and then `waitUntilRenderFlush`; require every cleanup once, root free once after actual null commit and passive completion, no later layout/native use, and unchanged stdout bytes/effect ordering against the baseline trace. These tests must catch both premature free and leaked root, not merely absence of exceptions.

Also cover external unmount after committed effects in both modes, repeated `unmount`/cleanup, reentrant exit from cleanup and stdout writes, pending render/log throttles and timers, alternate screen/kitty/cursor teardown, delayed writable barriers, closed streams, and error exit. Advance fake scheduled work after completion and verify no extra free/render. Exercise the numeric/null process-exit path in a subprocess fixture so assertions do not depend on a later microtask/timer running during shutdown. Existing root-free assertions should fail with zero frees on unchanged source; record any baseline ordering failure separately rather than changing the oracle to hide it. No RSS/heap threshold stands in for a native free counter.

- [ ] **Step 2: Verify this bounded direction; it is not an assumed fix**

Trace installed React `updateContainerSync` callback execution through commit callbacks, `resetAfterCommit`, layout effects, and passive effects in both builds/modes. Probe whether the callback for **this null update** can be used solely to mark actual commit completion. It executes within commit work, so it must not itself free the root or flush passive effects.

Evaluate one focused state/ownership sequence in an ignored probe: null-update callback marks committed; a synchronous non-reentrant caller finalizes only after `flushSyncWork` has returned outside commit and passive cleanup has completed; a reentrant caller uses a post-commit microtask to flush required passive cleanup outside commit and then finalize. A single exact-once finalization guard must cover both routes and repeated/reentrant exit. Prove how the caller distinguishes these routes without guessed React execution-context access, how the callback/microtask retains the correct Ink root, and why no stale scheduled callback can use it after finalization. Neither a callback alone, an optional flush returning false, nor a microtask delay alone establishes the whole barrier. Do not flush passive effects inside commit, poll, add arbitrary timer delays, or clear layout callbacks merely to suppress evidence of premature free.

The proof must account for signal/process shutdown: the existing numeric/null exit branch resolves synchronously because asynchronous callbacks may not run. Do not route all exits through a microtask or silently defer that branch. Show how synchronous supported shutdown completes the same ownership barrier, and how an exit arriving during commit can satisfy the existing output/settlement contract. Audit any nested updates from cleanup and all pending callback/timer owners before freeing. If existing effect-time terminal/exit ordering conflicts with the approved completion barrier, report the exact baseline/candidate trace and seek an explicit addendum decision; do not silently redefine “preserve ordering”.

- [ ] **Step 3: Stop for the I4 implementation addendum before choosing disposer placement**

Deliver a source/version-anchored ownership table and probe traces for every Step 1 route, an exact finalization algorithm with state transitions and callback scheduling, the synchronous shutdown proof, and the unchanged terminal/write-barrier ordering proof. Request focused independent review of that addendum. If any supported path remains unproven or requires a new lifecycle choice, leave `src/ink.tsx` unchanged and carry **I4 blocked** into I5/T3. Do not insert a free before `instances.delete`, append one after an optional flush, detach the root prematurely, or claim children/effects are necessarily gone when `flushSyncWork` returns reentrantly.

Only after approval, write algorithm-specific failing assertions and implement the smallest private exact-once disposal under the proven completion barrier; no public option, native exception swallowing, child `freeRecursive` changes, or `renderToString` edits.

- [ ] **Step 4: Verify lifecycle contracts and review (conditional on the addendum)**

```bash
NODE_ENV=test npm exec -- ava \
  test/render.tsx test/render-to-string.tsx test/exit.tsx \
  test/kitty-keyboard.tsx test/use-animation.tsx test/use-box-metrics.tsx
npm run typecheck
npm run lint
git diff --check
git diff -- src/ink.tsx test/render.tsx src/reconciler.ts src/render-to-string.ts
```

Require exact-once native free after the proven barrier, identical output/transitions/effects and exit settlement, all initial-effect combinations, repeated/pending/error/process-exit routes, and unchanged string-render cleanup. Run T1 repeated mount/unmount profiling only as supplemental evidence **inside canonical Gate P**, recording counts and separate post-GC heap/RSS/external/arrayBuffers without claiming allocator bytes per root. Review the addendum, deterministic tests, provenance/restoration, and every remaining owner; stop without staging or committing. No successful I4/combined-completion claim while the proof gate is open.

---

### Task I5: Combined nested verification and development-only outer handoff

**Files:**

- Modify: `docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md`
- Optional create: `test/helpers/terminal-screen.ts` only under the inconclusive-transition rule below
- Optional modify: `test/log-update-scroll-region.ts` only to import the behavior-identical extracted helper
- Ignored optional artifact: `.superpowers/sdd/runtime-memory-validation/outer-terminal-parity.tsx`
- Do not modify tracked outer files

**Interfaces:**

- Consumes: reviewed accepted I1-I4 candidates, T1's two reports/harness commands, built nested `build/`, canonical Gate P's development-only linking and exact-original restoration, and outer T3's producer-before-consumer contract.
- Produces: a reviewed nested build, exact nested/full and outer focused results, package-resolution proof, combined parity/latency evidence, explicit accepted/rejected candidate list, and a clean npm-mode handoff for outer T3.
- Does not produce: a commit, publication, package version, changeset, lockfile pin, local-link override, canonical snapshot update, or tracked outer dependency on unpublished behavior.

- [ ] **Step 1: Run the complete nested quality gate**

From the nested repository:

```bash
cd "$INK_ROOT"
npm run typecheck
npm run lint
npm exec -- ava \
  test/text-cache.ts \
  test/output-rows.test.ts \
  test/paint-selection.test.ts \
  test/text-selection.test.ts \
  test/text-selection-controller.test.ts \
  test/text-selection-hook.test.tsx \
  test/render.tsx \
  test/render-to-string.tsx \
  test/log-update.tsx \
  test/log-update-scroll-region.ts \
  test/fork-scroll.tsx \
  test/vlbox.tsx
npm test
npm run build
```

These commands are manifest-grounded: `npm test` runs typecheck, XO, and AVA; `npm run build` runs `tsc`. Do not describe them as passing until executed after implementation.

- [ ] **Step 2: Apply the bounded transition-model branch only if byte proof is inconclusive**

Default: do not edit the terminal model. Since memory changes do not touch `log-update` and accepted candidates must reproduce identical generated frame bytes, T1 byte parity plus the existing nested `test/log-update-scroll-region.ts` transition suite is the required proof.

Only if a byte mismatch or unexplained intermediate transition remains, first move lines 24 onward's `TerminalSnapshot`, `TerminalResult`, `blankTerminalRows`, and `applyTerminalWrite` from `test/log-update-scroll-region.ts` into `test/helpers/terminal-screen.ts`, export them, import them back, and run:

```bash
NODE_ENV=test npm exec -- ava test/log-update-scroll-region.ts
```

Expected: pass before any cross-repository validator is written; extraction itself changes no assertions or model behavior. Then place cross-repository validation only at `packages/ink/.superpowers/sdd/runtime-memory-validation/outer-terminal-parity.tsx`, importing the extracted nested helper and T1's outer `packages/cli/src/test-support` fixture support. Execute it explicitly with nested `npm exec -- tsx`; never add an outer tracked import of nested tests and never rely on implicit Vitest discovery.

- [ ] **Step 3: Invoke canonical Gate P for the combined candidate**

From the active outer root, run **Gate P** with one ignored fail-fast workload script containing Steps 5-6 and the exact T1 commands. Do not duplicate its preflight, build, link, URL checks, or restore commands here or in outer T3. Its preflight rejects dirty/staged controls before mutation; its finally owns restoration even on partial local-install or measurement failure. Save its full provenance/restoration log with the result.

- [ ] **Step 4: Require Gate P's producer-before-consumer build order**

Gate P builds nested Ink first, asserts both CLI and VL canonical resolutions equal that active build, then builds ink-input → ink-text-input → ink-virtualized-list → CLI. These are prerequisites inside the same invocation, not commands to rerun after it exits. Stop on type/build drift rather than working around unpublished APIs. An open I4 proof gate permits only a clearly labeled partial validation, not combined completion.

- [ ] **Step 5: Run existing outer parity and interaction suites explicitly**

Inside the workload passed to canonical Gate P (not as a later independent shell):

```bash
set -euo pipefail
corepack pnpm --filter @nuvin/ink-input test
corepack pnpm --filter @nuvin/ink-text-input test
corepack pnpm --filter @nuvin/ink-virtualized-list test
corepack pnpm --filter @nuvin/nuvin-code test -- \
  src/components/TranscriptVisualSnapshot.test.tsx \
  src/components/MessageRow.test.tsx \
  src/components/ReasoningRow.click.test.tsx \
  src/components/ToolDetailModal.test.tsx
```

Run T1's explicit MessageList+Composer and ToolDetailModal commands from its report for 120x40, 200x60, and the existing wide modal geometry. Cover Unicode/wide cells, nested/sticky content, resize, active selection/copy, viewport switching, and alternate-screen exit. Compare candidate output bytes and interactions literally to T1; do not regenerate canonical snapshots. The outer T2 Markdown collision oracle is the uncached renderer only for its two colliding sources and does not relax these Ink checks.

- [ ] **Step 6: Run manifest-verified latency gates in isolated repeats**

```bash
for run in 1 2 3 4 5; do
  NODE_ENV=production corepack pnpm benchmark:vl-scroll -- --samples 30 --rows 500 --real-rows --release-check
done
for run in 1 2 3 4 5; do
  NODE_ENV=production corepack pnpm benchmark:vlbox-tool-detail -- --samples 30 --release-check
done
```

Run these repeats inside the same Gate P workload. Also run T1's memory commands with explicit `NODE_ENV=production`, separately from latency and heap-snapshot capture. Record per-run median/p95, not a pooled mean. Existing release checks remain necessary but are not sufficient: any repeatable slowdown outside baseline variability, noisy/inconclusive comparison, frame-byte mismatch, interaction mismatch, effect-order mismatch, or native free-count mismatch blocks the combined handoff.

- [ ] **Step 7: Require Gate P's exact-original restoration result**

Let canonical Gate P's finally restore the saved workspace/lock bytes and run its frozen install. Require byte equality, clean tracked/staged controls, and exact **original** canonical CLI and VL URLs. Never use a registry-latest path. A failed restore blocks handoff; report the preserved backup location and recover exact originals before any next validation. No second cleanup snippet and no standalone open/close tool sequence.

- [ ] **Step 8: Final report, scope audit, and review readiness (no commit)**

The nested report must contain:

- outer/nested revisions, Node/npm/pnpm versions, baseline and candidate package resolutions;
- exact commands and raw output locations;
- calibrated cache constants and conservative accounting definition;
- accepted/rejected/deferred/blocked status for I1, I2, I3, and I4 independently; explicitly identify I3 representation and I4 ownership addendum gates;
- exact frame-byte, selection/copy, transition, effect/teardown, and root create/free results;
- retained heap versus allocation/peak/RSS/external/arrayBuffers evidence without double-counting external and arrayBuffers;
- five isolated latency distributions and baseline variability;
- open blockers, including any inconclusive measurement;
- explicit statement that no publication, pin, changeset, commit, or tracked local override was produced.

Audit only the intended nested paths:

```bash
cd "$INK_ROOT"
git diff --check
git status --short
git diff --stat
git diff -- \
  src/measure-text.ts src/wrap-text.ts src/output.ts src/paint-selection.ts \
  src/text-selection-controller.ts src/ink.tsx \
  test/text-cache.ts test/output-rows.test.ts test/paint-selection.test.ts \
  test/text-selection-controller.test.ts test/text-selection.test.ts test/render.tsx \
  docs/superpowers/reports/2026-09-05-runtime-memory-baseline.md
```

Any `src/index.ts`, `src/diagnostics.ts`, `src/text-selection.ts`, `src/reconciler.ts`, `src/render-to-string.ts`, broad renderer, snapshot, package-version, or dependency-file diff requires removal or a separately approved rationale. Request combined correctness/quality and measurement review. Stop at review readiness for outer T3; do not stage, commit, publish, pin, push, or merge.
