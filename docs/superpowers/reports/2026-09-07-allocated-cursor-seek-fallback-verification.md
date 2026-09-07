# Allocated cursor-seek fallback verification

Related spec: [design](../specs/2026-09-06-allocated-cursor-seek-fallback-design.md).
Related plan: [implementation plan](../plans/2026-09-07-allocated-cursor-seek-fallback.md).

This report tracks the fullscreen incremental seek-paint fallback for nested `@nuvin/ink` when OSC 66 is unavailable. Task 0 records the live-checkout baseline. Task 9 (2026-09-07) documents the bounded fallback and records source/consumer verification. Task 10 (2026-09-07) adds the foreground fixture and non-TTY refusal check; physical Warp/Terminal.app/Kitty acceptance remains pending. No seek painter existed at the Task 0 HEAD. No commit, stage, push, publish, or `make ink-npm` was run in Tasks 0–10.

Recorded 2026-09-06 (UTC) for Task 0; Task 9 and Task 10 commands recorded 2026-09-07 (UTC). Execution is the live checkout at `/Users/marsch/Projects/nuvin/nuvin-agent` (outer `main`) with nested Ink at `packages/ink` (`master`). The user authorized working directly on main. No git worktree was created. No files were copied to another checkout.

## Baseline identities

### Outer repository (`nuvin-agent`)

- Branch: `main`
- HEAD: `51ac38c69bc68fdbf5ebf0669cdd36533412d079`
- Subject: `chore: minor update` (`2026-09-07 00:57:46 +0700`)
- `git status --short`:

```
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
?? docs/superpowers/reports/runtime-memory/
?? scripts/show-emoji.mjs
```

### Nested Ink (`packages/ink`)

- Branch: `master`
- HEAD: `ee60c0e24b5e538a6f935ee10006b93cfc6a7dd0`
- Subject: `feat: negotiate OSC 66 explicit grapheme widths` (`2026-09-06 22:36:16 +0700`)
- Package: `@nuvin/ink@7.6.0-alpha`
- `git status --short` before this report:

```
?? docs/superpowers/handoffs/2026-09-06-explicit-width.md
?? docs/superpowers/plans/2026-09-06-explicit-width.md
?? docs/superpowers/plans/2026-09-07-allocated-cursor-seek-fallback.md
?? docs/superpowers/reports/2026-09-06-explicit-width-verification.md
?? docs/superpowers/specs/2026-09-06-allocated-cursor-seek-fallback-design.md
```

The seek implementation does not exist at this HEAD. Recheck HEAD before later tasks; do not replay already completed work.

## Versions and Ink resolution

Run at the outer root on 2026-09-06T18:02Z:

| Command | Result |
| --- | --- |
| `node --version` | `v22.23.2` |
| `node -p process.execPath` | `/Users/marsch/.local/share/nvm/v22.23.2/bin/node` |
| `pnpm --version` | `10.19.0` |
| `pnpm --filter @nuvin/nuvin-code exec node --input-type=module -e 'console.log(import.meta.resolve("ink"))'` | `file:///Users/marsch/Projects/nuvin/nuvin-agent/packages/ink/build/index.js` |

`which node` is an HTTP Toolkit PATH overlay (`.../httptoolkit-server/client/1.27.1/overrides/path/node`); `process.execPath` is the nvm Node 22.23.2 binary used for the commands above. npm 10.9.8 is present in nested Ink (`npm run typecheck`).

The current checkout resolves the local nested Ink build. Preexisting `ink: link:packages/ink` configuration is preserved. Dependency mode was not changed.

## Preserved files

Do not lose or restage the preexisting outer/nested dirty state. Later tasks may add owned files; they must not rewrite these snapshots except as an authorized task explicitly requires.

### Outer SHA-256

- `pnpm-workspace.yaml`: `bb0ff284be532ed190cc0efbae9f866f02385c7c9a1ff96df5eb0e08dcdcaf20`
- `pnpm-lock.yaml`: `ad63079544f61150f77d24adaee591b87bef92a59abaada58becd2b2f561c19c`
- `scripts/show-emoji.mjs`: `ad1ad600eea28bde558eaf224de7f072339a5bc83a079ef3c8303de2946e406a`
- Untracked `docs/superpowers/reports/runtime-memory/` left intact (baseline/candidate/latency artifacts).

### Nested untracked docs SHA-256 (preexisting)

- `docs/superpowers/handoffs/2026-09-06-explicit-width.md`: `0e8bf3a3199bdb547efbbf672943bddca125c2f284681abe64159027ce0d87f6`
- `docs/superpowers/plans/2026-09-06-explicit-width.md`: `aa74140f3720d83e5bc201c986b3d5531d969e970af3f7dee9b72f60b450e0bc`
- `docs/superpowers/plans/2026-09-07-allocated-cursor-seek-fallback.md`: `a9d6f5cfff63486d1288793431556c64c00f2bbd6ba2656400e4f76b5dc65973`
- `docs/superpowers/reports/2026-09-06-explicit-width-verification.md`: `4cbca70326b445bc376f1fd22b5aa622852ce80f9790ff3f6b9529f4c8879b07`
- `docs/superpowers/specs/2026-09-06-allocated-cursor-seek-fallback-design.md`: `2a14fefbec13f15a972166bf833bd7e98673edad1ca46b76e774c4f035de1280`

### Outer workspace/lock diff (`git diff -- pnpm-workspace.yaml pnpm-lock.yaml`)

`git diff --stat`: `pnpm-lock.yaml` 70 lines (`12 insertions, 60 deletions`); `pnpm-workspace.yaml` 2 lines (`1 insertion, 1 deletion`). Exit code 0.

The preexisting local-link selection (do not revert or regenerate):

```diff
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 8c7cb13f..5b3d2bb0 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -5,7 +5,7 @@ settings:
   excludeLinksFromLockfile: false
 
 overrides:
-  ink: npm:@nuvin/ink@7.6.0-alpha
+  ink: link:packages/ink
   zod: 4.4.1
 
 patchedDependencies:
@@ -24,8 +24,8 @@ importers:
         specifier: ^9.1.7
         version: 9.1.7
       ink:
-        specifier: npm:@nuvin/ink@7.6.0-alpha
-        version: '@nuvin/ink@7.6.0-alpha(@types/react@19.2.14)(react-devtools-core@7.0.1)(react@19.2.5)'
+        specifier: link:packages/ink
+        version: link:packages/ink
       json-zodify:
         specifier: ^1.0.2
         version: 1.0.2(zod@4.4.1)
@@ -159,8 +159,8 @@ importers:
         specifier: ^0.6.5
         version: 0.6.5(patch_hash=f6c0c7ee9e3cc6c64b366ff5e72d11fee8ca0054dc5cd7e473eadcc6b627808b)
       ink:
-        specifier: npm:@nuvin/ink@7.6.0-alpha
-        version: '@nuvin/ink@7.6.0-alpha(@types/react@19.2.14)(react-devtools-core@7.0.1)(react@19.2.5)'
+        specifier: link:../ink
+        version: link:../ink
       marked:
         specifier: ^15.0.12
         version: 15.0.12
@@ -476,8 +476,8 @@ importers:
   packages/ink-input:
     dependencies:
       ink:
-        specifier: npm:@nuvin/ink@7.6.0-alpha
-        version: '@nuvin/ink@7.6.0-alpha(@types/react@19.2.14)(react-devtools-core@7.0.1)(react@19.2.5)'
+        specifier: link:../ink
+        version: link:../ink
       react:
         specifier: ^19.1.0
         version: 19.2.5
@@ -507,8 +507,8 @@ importers:
         specifier: workspace:*
         version: link:../ink-input
       ink:
-        specifier: npm:@nuvin/ink@7.6.0-alpha
-        version: '@nuvin/ink@7.6.0-alpha(@types/react@19.2.14)(react-devtools-core@7.0.1)(react@19.2.5)'
+        specifier: link:../ink
+        version: link:../ink
       react:
         specifier: ^19.1.0
         version: 19.2.5
@@ -535,8 +535,8 @@ importers:
         specifier: workspace:*
         version: link:../ink-input
       ink:
-        specifier: npm:@nuvin/ink@7.6.0-alpha
-        version: '@nuvin/ink@7.6.0-alpha(@types/react@19.2.14)(react-devtools-core@7.0.1)(react@19.2.5)'
+        specifier: link:../ink
+        version: link:../ink
     devDependencies:
       '@sindresorhus/tsconfig':
         specifier: ^7.0.0
@@ -1196,19 +1196,6 @@ packages:
     resolution: {integrity: sha512-oGB+UxlgWcgQkgwo8GcEGwemoTFt3FIO9ababBmaGwXIoBKZ+GTy0pP185beGg7Llih/NSHSV2XAs1lnznocSg==}
     engines: {node: '>= 8'}
 
-  '@nuvin/ink@7.6.0-alpha':
-    resolution: {integrity: sha512-VZjC/EsC2bNIvLnzsKH7bhwxlCwMbVb0wkDikXB/e+//vlEsPkanQLkpEdgRYroRIw2VMMgteTay2P5yeJIejQ==}
-    engines: {node: '>=22'}
-    peerDependencies:
-      '@types/react': '>=19.2.0'
-      react: '>=19.2.0'
-      react-devtools-core: '>=6.1.2'
-    peerDependenciesMeta:
-      '@types/react':
-        optional: true
-      react-devtools-core:
-        optional: true
-
   '@oxc-project/types@0.130.0':
     resolution: {integrity: sha512-ibD2usx9JRu7f5pu2tMKMI4cpA4NgXJQoYRP4pQ7Pxmn1l6k/53qWtQWZayhYy3X4QZkt90Ot+mJEaeXouio6Q==}
 
@@ -6232,41 +6219,6 @@ snapshots:
       '@nodelib/fs.scandir': 2.1.5
       fastq: 1.19.1
 
-  '@nuvin/ink@7.6.0-alpha(@types/react@19.2.14)(react-devtools-core@7.0.1)(react@19.2.5)':
-    dependencies:
-      '@alcalzone/ansi-tokenize': 0.3.0
-      ansi-escapes: 7.3.0
-      ansi-styles: 6.2.3
-      auto-bind: 5.0.1
-      chalk: 5.6.2
-      cli-boxes: 4.0.1
-      cli-cursor: 4.0.0
-      cli-truncate: 6.0.0
-      code-excerpt: 4.0.0
-      es-toolkit: 1.46.1
-      indent-string: 5.0.0
-      is-in-ci: 2.0.0
-      patch-console: 2.0.0
-      react: 19.2.5
-      react-reconciler: 0.33.0(react@19.2.5)
-      scheduler: 0.27.0
-      signal-exit: 3.0.7
-      slice-ansi: 9.0.0
-      stack-utils: 2.0.6
-      string-width: 8.2.2
-      terminal-size: 4.0.1
-      type-fest: 5.6.0
-      widest-line: 6.0.0
-      wrap-ansi: 10.0.0
-      ws: 8.20.0
-      yoga-layout: 3.2.1
-    optionalDependencies:
-      '@types/react': 19.2.14
-      react-devtools-core: 7.0.1
-    transitivePeerDependencies:
-      - bufferutil
-      - utf-8-validate
-
   '@oxc-project/types@0.130.0': {}
 
   '@pkgr/core@0.3.6': {}
diff --git a/pnpm-workspace.yaml b/pnpm-workspace.yaml
index febf1c5a..41807dc3 100644
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@ -13,7 +13,7 @@ onlyBuiltDependencies:
 # - link:packages/ink         → local fork checkout (dev only — never commit)
 # Toggle with `make ink-local` / `make ink-npm`.
 overrides:
-  ink: "npm:@nuvin/ink@7.6.0-alpha"
+  ink: "link:packages/ink"
   zod: "4.4.1"
 
 # Preserve selectors in legacy table measurements and graphemes in truncation.
```

Compare later lock deltas against this saved diff. Task 3 may add only the `packages/ink` development dependency `@xterm/headless@6.0.0` and its required package entry. Do not lose the unrelated local-link changes above.

## Baseline commands (nested Ink)

Working directory: `packages/ink`. `node_modules` and `build/` were already present; no install or rebuild was performed.

### AVA

```sh
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/explicit-width.ts test/log-update-explicit-width.ts test/log-update.tsx test/log-update-scroll-region.ts test/explicit-width-auto.tsx
```

- Started: 2026-09-06T18:02:11Z
- Ended: 2026-09-06T18:02:16Z
- Summary: **216 tests passed**
- Exit code: **0**

These are today's recorded results. Historical pass counts and known-failure notes from other suites are not this baseline.

### Typecheck

```sh
npm run typecheck
```

(`tsc --noEmit` via `@nuvin/ink@7.6.0-alpha`)

- Started: 2026-09-06T18:02:33Z
- Ended: 2026-09-06T18:02:35Z
- Output: none besides the npm script header
- Exit code: **0**

## Task gates

| Gate | Status |
| --- | --- |
| Task 0: Prepare the execution checkout and record a baseline | recorded (this document; no implementation commit) |
| Task 1: Share escape-token boundaries without changing OSC 66 | implemented uncommitted; passed per-task review |
| Task 2: Prepare bounded, validated seek rows | implemented uncommitted; passed per-task review |
| Task 3: Implement the row writer and reproduce cell-level failures | implemented uncommitted; passed per-task review |
| Task 4: Integrate a seek branch into the incremental logger | implemented uncommitted; passed per-task review |
| Task 5: Route physical viewport changes at actual write time | implemented uncommitted; passed per-task review |
| Task 6: Connect capability settlement and scope selection | implemented uncommitted; passed per-task review |
| Task 7: Preserve ordinary output and Static ordering | implemented uncommitted; passed per-task review |
| Task 8: Finish teardown and failure ownership | implemented uncommitted; passed per-task review |
| Task 9: Validate the integrated change and document its scope | recorded below; no commit |
| Task 10: Run the physical terminal gate | fixture and non-TTY refusal recorded; physical acceptance **pending**; no commit |

## Live / delivery gates

Completing source tests does not complete the physical terminal gates.

| Gate | Status |
| --- | --- |
| Nested source suites owned by Tasks 1–8 | **381 passed**, exit **0** (focused integrated AVA, 2026-09-07T03:07:34Z–03:07:48Z) |
| Nested `npm run typecheck` / `npm run build` after implementation | typecheck exit **0** (03:08:05Z–03:08:07Z); build exit **0** (03:08:07Z–03:08:09Z) |
| Focused test TypeScript check (`test/tsconfig.allocated-seek-check.json`) | **exit 2**; exclusive config created with `wx` and deleted; see Task 9 notes |
| Scoped Prettier / XO over owned files | Prettier exit **0**; XO started and **exit 1** (56 errors, 7 warnings) |
| Full nested AVA suite | **1599 passed / 4 known failures / 1 todo / exit 0** (03:09:25Z–03:12:15Z). Known failures are existing `test.failing` annotations, not new passing regressions. |
| Consumer Ink resolution still local `packages/ink/build` | `file:///Users/marsch/Projects/nuvin/nuvin-agent/packages/ink/build/index.js` |
| `pnpm --filter @nuvin/ink-input test` | **534 passed**, 31 files, exit **0** |
| CLI focused vitest + `pnpm --filter @nuvin/nuvin-code build` | vitest **166 passed**, 5 files, exit **0**; CLI build exit **0** |
| Work counters (identical/cursor-only/changed-row/resize) | recorded below |
| Outer/nested `git diff --check` vs this baseline | both exit **0** |
| Allocated-seek fixture syntax/build + piped refusal | recorded (Task 10); AVA **1 passed**, brief command exit **1** with no terminal controls |
| Warp physical acceptance (fullscreen incremental TUI + Shell) | **pending** (Task 10; apps installed, session is not an interactive TTY) |
| Terminal.app physical acceptance | **pending** (Task 10; apps installed, session is not an interactive TTY) |
| Kitty: OSC 66 still selected; no seek-writer CHA/DECAWM on that path | **pending** (Task 10; apps installed, session is not an interactive TTY) |
| Confirm live Shell frame fills the viewport | **pending** (Task 10) |
| Ink-managed copy vs native copy observations | **pending** (Task 10) |
| Default shipping of the fallback | **blocked until Task 10 target terminals pass** |
| Commit / push / publish / registry upgrade | not authorized |

A failed OSC 66 probe does not qualify a terminal. Glyph fragmentation is an accepted limit; neighbor damage or unintended row movement is failure. Do not describe Warp or Terminal.app as verified.

## Task 9 documentation

Nested `readme.md` now documents fullscreen/incremental eligibility, inline/Static/raw exclusions, unchanged force-on/off precedence, incomplete-glyph/native-copy limits, the scroll-optimization tradeoff, and extra blank primary-screen history around external output. `src/render.ts` `incrementalRendering` and `explicitWidth` comments describe the same bounded fallback. Physical Warp/Terminal.app acceptance is explicitly pending.

## Task 9 source verification (nested Ink)

Working directory: `packages/ink`. Node `v22.23.2` (`/Users/marsch/.local/share/nvm/v22.23.2/bin/node`). pnpm `10.19.0`. Nested HEAD still `ee60c0e`. Local `ink: link:packages/ink` preserved.

### Focused integrated AVA

```sh
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/terminal-control.ts test/allocated-seek.ts test/allocated-seek-terminal.ts test/log-update-allocated-seek.ts test/allocated-seek-resize.tsx test/allocated-seek-auto.tsx test/allocated-seek-output.tsx test/allocated-seek-lifecycle.tsx test/explicit-width.ts test/explicit-width-detection.ts test/explicit-width-auto.tsx test/explicit-width-manual.tsx test/log-update-explicit-width.ts test/log-update.tsx test/log-update-scroll-region.ts
```

- Started: 2026-09-07T03:07:34Z
- Ended: 2026-09-07T03:07:48Z
- Summary: **381 tests passed**
- Exit code: **0**

### Typecheck and build

```sh
npm run typecheck
npm run build
```

- `tsc --noEmit`: exit **0** (03:08:05Z–03:08:07Z). This checks `src` only.
- `tsc` build: exit **0** (03:08:07Z–03:08:09Z). Consumers resolved the rebuilt `packages/ink/build`.

### Focused test TypeScript check

The exclusive temporary `test/tsconfig.allocated-seek-check.json` was created with `flag: 'wx'` and unlinked in `finally`. It is not left behind.

- Started: 2026-09-07T03:08:15Z
- Ended: 2026-09-07T03:08:17Z
- Exit code: **2**

Recorded errors (do not treat source `tsc --noEmit` as covering these):

- JSX `ink-box` / `ink-text` missing on `src/components/*` because the focused include list does not pull `src/global.d.ts`.
- `test/allocated-seek-lifecycle.tsx`: Node `write` callback `Error | null` vs `Error | undefined`, and one `writeImpl` returning `void` instead of `boolean | undefined`.
- `test/allocated-seek-output.tsx`: `readonly string[]` assigned to `Static` `items` (`string[]`).

### Scoped Prettier and XO

```sh
npm exec -- prettier --check src/terminal-control.ts src/allocated-seek.ts src/terminal-paint.ts src/explicit-width.ts src/log-update.ts src/ink.tsx test/terminal-control.ts test/allocated-seek.ts test/allocated-seek-terminal.ts test/helpers/terminal-model.ts test/log-update-allocated-seek.ts test/allocated-seek-resize.tsx test/allocated-seek-auto.tsx test/allocated-seek-output.tsx test/allocated-seek-lifecycle.tsx
npm exec -- xo src/terminal-control.ts src/allocated-seek.ts src/terminal-paint.ts src/explicit-width.ts src/log-update.ts src/ink.tsx test/terminal-control.ts test/allocated-seek.ts test/allocated-seek-terminal.ts test/helpers/terminal-model.ts test/log-update-allocated-seek.ts test/allocated-seek-resize.tsx test/allocated-seek-auto.tsx test/allocated-seek-output.tsx test/allocated-seek-lifecycle.tsx
```

- Prettier: exit **0** (03:09:07Z–03:09:08Z), all matched files use Prettier code style.
- XO: started; exit **1** (03:09:12Z–03:09:19Z); **7 warnings, 56 errors**. Lint is not claimed passed. Many hits are pre-existing `src/ink.tsx` style plus `charCodeAt` / comment rules in the new seek files.

### Full nested AVA

```sh
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava
```

- Started: 2026-09-07T03:09:25Z
- Ended: 2026-09-07T03:12:15Z
- Summary: **1599 tests passed**, **4 known failures**, **1 test todo**
- Exit code: **0**

The four known failures are existing `test.failing` annotations (including `width-height` percent min/max cases). The todo is `hooks.tsx` `useStderr`. These are not new passing regressions.

## Task 9 consumer verification (outer root)

```sh
pnpm --filter @nuvin/nuvin-code exec node --input-type=module -e 'console.log(import.meta.resolve("ink"))'
pnpm --filter @nuvin/ink-input test
pnpm --filter @nuvin/nuvin-code exec vitest run src/root.test.ts src/root-boot.test.ts src/components/MessageList.test.tsx src/components/MessageList.sticky-bottom-flash.test.tsx src/components/RemoteSession.test.tsx
pnpm --filter @nuvin/nuvin-code build
```

| Command | Result |
| --- | --- |
| Ink resolve | `file:///Users/marsch/Projects/nuvin/nuvin-agent/packages/ink/build/index.js` (exit 0, 03:12:23Z) |
| `@nuvin/ink-input` vitest | **534 passed**, 31 files, exit **0** (03:12:27Z–03:12:30Z) |
| CLI focused vitest | **166 passed**, 5 files, exit **0** (03:12:35Z–03:12:47Z) |
| `@nuvin/nuvin-code` build | exit **0** (03:12:50Z–03:13:19Z) |

Tests ran against the rebuilt execution checkout, not published `@nuvin/ink`. Dependency mode was not switched. Unrelated lock entries were not regenerated.

## Work counters

Measured 2026-09-07T03:14:03Z from nested Ink `createIncremental` seek writes. Row encoding is counted as `encodeSeekRow` signatures (`CUP(row,1)` + hyperlink close + SGR reset + `EL 2`). Extra CHA/prefill bytes and disabled scroll-region optimization are intentional costs, not a performance claim. Unchanged-row skipping is preserved.

### 3×8 fixture (`TOP` / `👩‍👩⚡X` / `123456界`)

| Case | Row encodings | Notes |
| --- | ---: | --- |
| Identical frame | **0** | `log()` returned false; **0** bytes |
| Cursor-only | **0** | 1 absolute CUP, 12 UTF-8 bytes, no DECAWM, no CHA |
| One changed middle row | **1** | neighbor rows not rewritten |
| Inherited-style dependent | **2** | changed row plus the same-logical `world!!!` dependent |
| Resize (8→10 columns, 3 rows) | **3** | full viewport |

### Realistic 24×80 fullscreen first paint

Logical frame UTF-8: **2323** bytes (ASCII chrome, `🏳️‍♀️`, `⚡︎`, `👩‍👩⚡X`, CJK, bottom-right sentinel).

| Path | UTF-8 bytes | Row encodings |
| --- | ---: | ---: |
| Raw incremental first paint | 2323 | n/a (bulk string) |
| Seek first paint | **5085** | **24** (full viewport) |
| Seek overhead | 2762 | 367 CHA seeks + 25 CUP (24 rows + final cursor) |
| Identical re-log | 0 | **0** |
| Cursor-only | 13 | **0** (1 CUP) |
| One changed history row | 141 | **1** |
| Resize to 100×24 | 5291 | **24** (full viewport) |

## Diff, lock, and workspace vs Task 0

Outer HEAD still `51ac38c69bc68fdbf5ebf0669cdd36533412d079`. Nested HEAD still `ee60c0e24b5e538a6f935ee10006b93cfc6a7dd0`. Both `git diff --check` exit **0**.

Outer `git status --short` is unchanged from Task 0 besides the lock SHA:

```
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
?? docs/superpowers/reports/runtime-memory/
?? scripts/show-emoji.mjs
```

- `pnpm-workspace.yaml` SHA-256 still `bb0ff284be532ed190cc0efbae9f866f02385c7c9a1ff96df5eb0e08dcdcaf20` (local `ink: "link:packages/ink"` preserved).
- `pnpm-lock.yaml` SHA-256 is now `fbd1fcd73c497e152e0b7fae4ad870c61edb2f50757d2388fa34b2bf604c31f0` (was `ad63079544f61150f77d24adaee591b87bef92a59abaada58becd2b2f561c19c`).
- `git diff --stat -- pnpm-workspace.yaml pnpm-lock.yaml`: lock 78 lines (`20 insertions, 60 deletions`); workspace 2 lines (`1 insertion, 1 deletion`). Task 0 was lock 70 lines (`12 insertions, 60 deletions`) plus the same workspace hunk.
- Beyond the saved local-link selection, the lock adds only the Task 3 development dependency `@xterm/headless@6.0.0` (importer, package, and snapshot entries). No unrelated lock regeneration. Nested `package.json` records `"@xterm/headless": "6.0.0"`.

Nested preexisting untracked spec/plan/handoff/OSC 66 report files remain. Task 1–10 source/tests/docs are uncommitted. Suggested authorized commit (not created): `docs: document and verify fullscreen incremental seek fallback`.

## Scope review vs spec matrix

Source tests cover the bounded fallback: single layout and original grid text; narrow-glyph prefill and same-row spill; right-margin/bottom-right cell model; shared first-paint/changed-row writer; zero encoding on identical/cursor-only/cache priming; style/link continuity and unsafe-control rejection; width/height resize without `ED 3`; physical metadata at actual write time; fullscreen entry/exit and raw/OSC 66 exclusions; probe settlement; ordinary/Static ordering with extra blank history; autowrap restore; OSC 66 and consumer suites still green.

Not claimed here:

- Warp / Terminal.app physical compatibility (Task 10; **pending**).
- Live Shell viewport-fill confirmation (Task 10; **pending**).
- Kitty OSC 66 physical path vs seek-writer CHA/DECAWM (Task 10; **pending**).
- Ink-managed vs native copy on a real terminal (Task 10; **pending**).
- Default shipping of the fallback.

## Task 10 physical gate (2026-09-07)

Working directory: `packages/ink`. Node `v22.23.2` (`/Users/marsch/.local/share/nvm/v22.23.2/bin/node`). Nested HEAD still `ee60c0e`. No commit, stage, push, or publish.

This agent session is a CLI (`TERM_PROGRAM=WarpTerminal`, `tty` reports `not a tty`, stdin/stdout `isatty() === false`). It is not an interactive Warp, Terminal.app, or Kitty window. Installed apps were observed on disk only:

| App | Path | `CFBundleShortVersionString` |
| --- | --- | --- |
| Warp | `/Applications/Warp.app` | `0.2026.08.12.21.54.00` |
| kitty | `/Applications/kitty.app` | `0.47.1` |
| Terminal.app | `/System/Applications/Utilities/Terminal.app` | `2.15` |

Those apps were not opened interactively. Nuvin Shell was not run in them. No screenshots were captured. No input was injected into an already-running TUI. Physical Warp/Terminal.app/Kitty acceptance remains **pending**. A failed OSC 66 probe does not establish support. Default shipping stays **blocked**.

### Fixture

Created `examples/allocated-seek/index.tsx`:

- `useWindowSize`, `Box height={rows}` while fullscreen (`rows - 3` when `i` switches inline), `Text`, `useInput`, `useStdout`, `useStderr`
- `incrementalRendering: true`, `patchConsole: true`, `exitOnCtrlC: false`, Ink-managed `alternateScreen: true`
- Glyphs: `🏳️‍♀️`, `👩‍👩⚡X`, VS15 `⚡︎`, VS16 `⚡️`, colored allocation blanks, ASCII neighbors, right-edge `|`, bottom-right `+`
- Keys: `n` one middle row; `f` full frame; `o` long stdout; `e` long stderr; `i` inline/fullscreen; `q` exit
- Geometry from real terminal resize via `useWindowSize`
- Stdout/stderr writes go through `useStdout`/`useStderr` `write()`, not rendered text
- Does not force OSC 66
- Guards stdin/stdout TTY before `render()`; a piped invocation writes a plain refusal to stderr and sets `exitCode = 1` with no terminal controls

### Non-TTY refusal and syntax

```sh
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/allocated-seek-example.ts
```

- Summary: **1 passed**
- Exit code: **0**

Foreground command from nested Ink (this non-TTY session):

```sh
env -u INK_EXPLICIT_WIDTH NODE_NO_WARNINGS=1 node --import=tsx examples/allocated-seek/index.tsx
```

- Recorded: 2026-09-07T03:37:54Z
- Exit code: **1**
- stderr: `allocated-seek example requires a foreground TTY on stdin and stdout; piped invocations are refused.`
- stdout empty; no CSI/OSC/C1 controls. `tsx` compiled the fixture (syntax).

Control:

```sh
INK_EXPLICIT_WIDTH=0 NODE_NO_WARNINGS=1 node --import=tsx examples/allocated-seek/index.tsx
```

Same refusal, exit **1**. Prettier and XO over `examples/allocated-seek/index.tsx` and `test/allocated-seek-example.ts` exit **0**.

A local non-target PTY smoke started the fixture and exited 0 on `q`. That is not Warp, Terminal.app, or Kitty, and does not qualify physical acceptance.

### Physical terminals

Inaccessible from this CLI session. Finish-authorized source work is recorded above. Physical gates stay **pending**, not passed. No publish/release action.

## Notes for later tasks

- Path convention: `src/`, `test/`, `docs/` are relative to `packages/ink`. Outer commands run at the workspace root. AVA/npm run in nested Ink.
- Do not modify `pnpm-workspace.yaml` except to preserve the existing local link. Do not switch dependency mode as a testing shortcut.
- Creating this report was the only nested-tree addition from Task 0. Task 9 updates the same untracked file and nested `readme.md` / `src/render.ts` comments. Task 10 adds `examples/allocated-seek/index.tsx` and `test/allocated-seek-example.ts` and updates this report.
- Task 10 physical Warp/Terminal.app/Kitty acceptance remains pending. Completing source tests and the fixture does not complete it.

