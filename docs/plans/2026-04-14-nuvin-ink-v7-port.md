# Nuvin Ink V7 Port Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port `@nuvin/ink` from the current forked 6.6.7 codebase onto upstream `ink@7.0.0` while preserving the fork-only APIs and behavior that upstream v7 does not provide.

**Architecture:** Replace the current source tree with the upstream `v7.0.0` baseline, keep package identity as `@nuvin/ink`, then forward-port the fork-only behavior in small slices with tests first. The fork-only surface is concentrated in layout/rendering and the imperative `BoxRef` API, so the port should touch `src/components/Box.tsx`, `src/styles.ts`, `src/render-node-to-output.ts`, and related tests after the baseline lands.

**Tech Stack:** TypeScript, React 19, Ink renderer internals, AVA, XO, Node.js 22+.

---

### Task 1: Land Upstream V7 Baseline

**Files:**
- Modify: `package.json`
- Modify: `src/**/*`
- Modify: `test/**/*`
- Modify: `readme.md`

**Step 1: Write the failing test**

Use baseline verification instead of a new unit test for this task, because the objective is replacing the current implementation with a known upstream state before reintroducing fork-only behavior.

**Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: Existing fork code remains on the pre-v7 baseline and does not provide the upstream v7 API surface.

**Step 3: Write minimal implementation**

Replace the current tracked files with the upstream `v7.0.0` versions, then restore `package.json` identity fields to:

```json
{
  "name": "@nuvin/ink",
  "repository": "marschhuynh/ink"
}
```

Keep the upstream v7 runtime and toolchain requirements intact.

**Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: Upstream v7 baseline passes locally before any fork-only behavior is reintroduced.

**Step 5: Commit**

```bash
git add package.json src test readme.md
git commit -m "chore: port fork to upstream ink v7 baseline"
```

### Task 2: Restore Scroll Overflow And Imperative Box API

**Files:**
- Modify: `src/components/Box.tsx`
- Modify: `src/styles.ts`
- Modify: `src/render-node-to-output.ts`
- Modify: `src/index.ts`
- Test: `test/scroll.tsx`
- Test: `test/scroll-offset.tsx`
- Test: `test/overflow.tsx`

**Step 1: Write the failing test**

Reintroduce the former fork expectations around:
- `overflow="scroll"` and `overflowX/Y="scroll"`
- `BoxRef.scrollTo()`
- `BoxRef.scrollToTop()`
- `BoxRef.scrollToBottom()`
- `BoxRef.getScrollPosition()`
- `BoxRef.getBounds()`

**Step 2: Run test to verify it fails**

Run: `pnpm test test/scroll.tsx test/scroll-offset.tsx test/overflow.tsx`
Expected: FAIL because upstream v7 removed the imperative scroll API and only supports `visible`/`hidden` overflow.

**Step 3: Write minimal implementation**

Restore the fork implementation on top of v7, adjusting any conflicts with the upstream v7 `Box` and renderer internals instead of reverting v7 behavior wholesale.

**Step 4: Run test to verify it passes**

Run: `pnpm test test/scroll.tsx test/scroll-offset.tsx test/overflow.tsx`
Expected: PASS with the fork scroll API working on the v7 base.

**Step 5: Commit**

```bash
git add src/components/Box.tsx src/styles.ts src/render-node-to-output.ts src/index.ts test/scroll.tsx test/scroll-offset.tsx test/overflow.tsx
git commit -m "feat: restore scroll overflow api on v7"
```

### Task 3: Restore Sticky And Z-Index Behavior

**Files:**
- Modify: `src/styles.ts`
- Modify: `src/render-node-to-output.ts`
- Test: `test/sticky.tsx`
- Test: `test/components.tsx`
- Test: `test/position.tsx`

**Step 1: Write the failing test**

Add or restore coverage for:
- `position="sticky"`
- sticky top offset behavior while scrolling
- child ordering by `zIndex`

**Step 2: Run test to verify it fails**

Run: `pnpm test test/sticky.tsx test/position.tsx test/components.tsx`
Expected: FAIL because upstream v7 does not implement sticky positioning or `zIndex`.

**Step 3: Write minimal implementation**

Reapply the fork behavior with the smallest compatible changes to the v7 renderer and layout pipeline.

**Step 4: Run test to verify it passes**

Run: `pnpm test test/sticky.tsx test/position.tsx test/components.tsx`
Expected: PASS with sticky and z-index behavior restored.

**Step 5: Commit**

```bash
git add src/styles.ts src/render-node-to-output.ts test/sticky.tsx test/position.tsx test/components.tsx
git commit -m "feat: restore sticky and z-index behavior on v7"
```

### Task 4: Final Regression And Package Verification

**Files:**
- Modify: `package.json`
- Modify: `readme.md`
- Test: `test/**/*`

**Step 1: Write the failing test**

Add any targeted regression tests discovered during porting for behavior that differs between the fork and upstream v7.

**Step 2: Run test to verify it fails**

Run: `pnpm test <targeted-tests>`
Expected: FAIL until the last regression is resolved.

**Step 3: Write minimal implementation**

Fix the smallest remaining incompatibilities, keeping the upstream v7 APIs intact and documenting any intentional divergence in `readme.md`.

**Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS for the full suite on the final `@nuvin/ink` v7 port.

**Step 5: Commit**

```bash
git add package.json readme.md src test
git commit -m "test: finalize @nuvin/ink v7 port"
```
