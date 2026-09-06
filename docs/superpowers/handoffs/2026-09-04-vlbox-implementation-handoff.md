# VLBox retained-layout viewport culling implementation handoff

**Date:** 2026-09-04  
**Repository:** nested standalone `packages/ink` repository  
**Branch:** `perf/incremental-scroll-region`  
**Current HEAD:** `4c805a2928bce7c4b89109f43ed1f631ad2ff915`  
**Status:** implementation paused after Task 1 implementation; Task 1 independent review is still pending

## 1. Objective

Implement a public, Box-compatible `<VLBox>` in the custom Ink fork. It retains the complete React/Yoga tree for exact arbitrary flex layout, caches layout metadata per real Yoga generation, culls off-screen paint subtrees, indexes sticky candidates, and scrolls through host-offset mutation plus repaint rather than React-driven layout.

The first product integration is the outer CLI `ScrollBox`, which will move the VLBox host before synchronizing its React controller state and will keep scrollbar Yoga geometry fixed while the thumb moves.

`VLBox` is retained-layout viewport culling, not strict bounded mounting. Initial mount and content-changing layout remain O(total retained tree size).

## 2. Authoritative documents

- Approved design: `docs/superpowers/specs/2026-09-04-vlbox-retained-layout-viewport-culling-design.md`
- Audited implementation plan: `docs/superpowers/plans/2026-09-04-vlbox-retained-layout-viewport-culling.md`
- SDD progress ledger: `.superpowers/sdd/progress.md`

Planning commit:

```text
35098fe docs(ink): finalize retained-layout VLBox plan
```

The plan was independently audited twice. The first audit found culling-visitation, recursive viewport propagation, sticky fixture/command, benchmark-metric, and fail-open issues. Those findings were verified against current source and repaired. A final concise preflight found no blocker or high-severity plan defects.

## 3. Locked implementation decisions

- `VLBox` shares the private Box implementation and public Box props/ref API.
- All React and Yoga nodes remain mounted.
- Yoga runs only when terminal width changes or the Yoga root is dirty.
- Root `layoutEpoch` advances only after an actual Yoga calculation.
- Metadata also supports targeted dirty rebuilds for Yoga-clean changes to z-index, sticky/relative position semantics, overflow ownership, and public Transform geometry classification.
- Cached subtree bounds are node-local; live absolute coordinates are formed only during renderer culling.
- Culling activates only on resolved axes whose overflow is `scroll`.
- Zero-sized, stale, missing, or uncertain metadata fails open.
- Public `Transform` geometry fails open; ordinary Text styling remains cullable.
- Straddling backgrounds and borders generate only visible rows and columns.
- Sticky candidates belong to the nearest scrolling VLBox. A visible nested normal scroll Box suspends ancestor culling for its descendants so traversal-time sticky discovery remains correct.
- Imperative VLBox scrolling keeps the component scroll ref and host offset synchronized and suppresses unchanged repaint requests.
- Screen-reader rendering walks the complete semantic tree.
- Performance verification runs at **424 columns × 95 rows**.

Required performance gates:

- zero Yoga layouts per warm imperative scroll;
- large Ink renderer median `<= 16 ms`;
- at least `5x` renderer speedup over unculled Box for the large fixture;
- no more than `10%` small-fixture renderer regression;
- actual CLI tool-detail wheel median `<= 16 ms`;
- bounded expanded renderer visitation;
- byte-identical checkpoint frames.

## 4. Repository and safety boundaries

### Nested Ink repository

The user explicitly chose to implement on the current checkout rather than create another worktree.

Current committed sequence:

```text
4c805a2 feat: track root layout generations
d763053 chore(ink): fix baseline lint errors
35098fe docs(ink): finalize retained-layout VLBox plan
f9a29d7 docs: correct VLBox release target
1bcf310 docs: design retained-layout VLBox viewport culling
```

Before this handoff file was created, the nested worktree was clean at `4c805a2`.

### Outer repository

No outer source was modified during this implementation segment. Prior session state recorded unrelated outer edits and a development-only `link:packages/ink` override. Re-check outer status before Task 9 and do not discard unrelated work.

Before any outer commit, restore npm mode with `make ink-npm`. The eventual committed dependency target is `npm:@nuvin/ink@7.6.0-alpha`, never `link:packages/ink`.

### Explicit approval boundaries

Do not perform any of the following without explicit user approval:

- publish `@nuvin/ink@7.6.0-alpha`;
- update outer package pins from `7.5.0-alpha` to `7.6.0-alpha` before publication;
- push either repository;
- merge branches;
- discard unrelated outer changes.

## 5. Baseline cleanup and environment finding

The first previously unexecuted nested baseline reached XO and reported 16 pre-existing lint errors. The user approved fixing them in a separate mechanical commit:

```text
d763053 chore(ink): fix baseline lint errors
```

The cleanup preserved behavior, including the TextSelectionController provider's intentional `null` contract. Three independent lint reviews checked reuse, code quality, and efficiency. XO now reports zero errors and the existing nine max-depth/max-lines warnings.

The shell exports:

```text
NODE_ENV=production
```

Under production mode, installed React `19.2.5` exposes `act` as `undefined`, causing 56 AVA failures. This is an environment issue, not an Ink regression. Run AVA/full tests with `NODE_ENV=test` in this environment.

Verified baseline command and result:

```bash
NODE_ENV=test npm test
```

```text
1133 tests passed
1 test todo
9 existing XO warnings
```

## 6. Task 1 implementation state

### Task

Dirty-aware root layout epochs.

### Commit

```text
4c805a2928bce7c4b89109f43ed1f631ad2ff915
feat: track root layout generations
```

Changed files:

- `src/dom.ts`
- `src/ink.tsx`
- `src/render-to-string.ts`
- `test/vlbox.tsx`

Implemented behavior:

- added `DOMElement.internal_layoutEpoch?: number`;
- added `incrementLayoutEpoch(root)`;
- tracked the last terminal layout width;
- avoided setting Yoga root width when unchanged;
- skipped Yoga calculation when width is unchanged and `yoga.isDirty()` is false;
- incremented the epoch only after Yoga actually calculated layout;
- stamped synchronous render-to-string layouts with an epoch.

No Task 2 or later VLBox code was introduced.

### TDD evidence

Red command:

```bash
NODE_ENV=test npm exec -- ava test/vlbox.tsx --match='layout epoch advances only*'
```

Expected red result:

```text
actual typeof first: 'undefined'
expected: 'number'
```

Green verification:

```bash
NODE_ENV=test npm exec -- ava test/vlbox.tsx --match='layout epoch advances only*'
npm run typecheck
```

Result:

```text
1 focused AVA test passed
tsc --noEmit passed
```

Detailed implementer report:

- `.superpowers/sdd/task-1-report.md`

Task brief:

- `.superpowers/sdd/task-1-brief.md`

Review package already generated:

- `.superpowers/sdd/review-d763053..4c805a2.diff`

## 7. Exact resume point

**Do not re-implement Task 1.** Resume with its independent task review.

1. Confirm nested state:

   ```bash
   cd packages/ink
   git status --short
   git log -3 --oneline
   cat .superpowers/sdd/progress.md
   ```

2. Dispatch a fresh `code-reviewer` for Task 1. Give it exactly these artifacts:

   - brief: `.superpowers/sdd/task-1-brief.md`;
   - implementer report: `.superpowers/sdd/task-1-report.md`;
   - diff package: `.superpowers/sdd/review-d763053..4c805a2.diff`.

3. Require both verdicts:

   - specification compliance;
   - code quality.

4. Verify every reviewer finding against current source. Dispatch a fix subagent for any Critical or Important finding, rerun its covering tests, regenerate the review package, and re-review.

5. When Task 1 review is clean, append to `.superpowers/sdd/progress.md`:

   ```text
   Task 1: complete (commits d763053..4c805a2, review clean)
   ```

6. Mark Task 1 complete and Task 2 in progress. Task 2's brief is already prepared:

   - `.superpowers/sdd/task-2-brief.md`

7. Continue the plan through fresh implementer + independent reviewer cycles. Do not run multiple implementation agents in parallel because tasks share the same nested working tree.

## 8. Verification conventions

Nested Ink uses npm, TypeScript, XO, and AVA. Use `NODE_ENV=test` for AVA/full tests in this shell:

```bash
NODE_ENV=test npm exec -- ava <test files and --match filters>
npm run typecheck
npm run lint
NODE_ENV=test npm test
npm run build
```

AVA accepts repeated `--match` flags. Existing XO warning baseline is nine warnings; new lint errors are not acceptable.

Outer CLI tests use the filtered package working directory, so paths are relative to `packages/cli`:

```bash
corepack pnpm --filter @nuvin/nuvin-code exec vitest run src/components/ComboBox/ScrollBox.test.tsx
```

Do not use `packages/cli/src/...` after `--filter @nuvin/nuvin-code exec`.

For TUI render tests, poll observable frame effects rather than using fixed sleeps.

## 9. Remaining plan sequence

- Task 1 review: pending.
- Task 2: shared Box factory and public VLBox shell.
- Task 3: layout metadata prepass and cached content extents.
- Task 4: early viewport subtree culling and visible surface clipping.
- Task 5: indexed sticky candidates.
- Task 6: paint-only imperative scrolling and invalidation.
- Task 7: selection, accessibility, and correctness gates.
- Task 8: 424×95 Ink benchmark, documentation, and `7.6.0-alpha` release artifact; stop for publication approval.
- Task 9: update outer Ink pins after approved publication.
- Task 10: integrate VLBox into CLI ScrollBox.
- Task 11: 424×95 tool-detail regression and benchmark.
- Task 12: final cross-repository verification and broad review.

Implementation must stop at Task 8's publication gate until the user explicitly approves publishing.
