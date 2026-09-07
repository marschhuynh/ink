# OSC 66 explicit-width verification

Related plan: [implementation plan](../plans/2026-09-06-explicit-width.md). Approved scope: [handoff](../handoffs/2026-09-06-explicit-width.md).

## Baseline and preservation

Before OSC 66 production edits on 2026-09-06, Node v22.23.2 / npm 10.9.8:

- `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/log-update.tsx test/log-update-scroll-region.ts test/kitty-keyboard.tsx test/input-parser.ts`: **232 passed**.
- Prior geometry/selection command from the handoff: **322 passed**.
- `npm run typecheck`: **passed**.
- Nested/outer `git diff --check`: **passed**.
- Existing `src/output.ts` and `test/output-rows.test.ts` SHA-256 snapshots saved and verified unchanged at plan completion.
- Exact outer workspace YAML and lockfile saved, including existing table patches. They already selected `link:packages/ink` at session start (verified byte-equal to saved snapshots), contrary to the handoff. The user explicitly chose to preserve the existing local link after verification.

Raw test logs and preservation artifacts live in ignored `.superpowers/sdd/` directories; they are not release artifacts.

## Implementation verification status

Task 1 is independently approved after fixing cache-test false positives, exact-output assertions and test typing: 147 Task1/log tests passed. The built encoder returns 106 bytes from 40 raw bytes.

**Task 2 automatic negotiation is implemented.** Independent re-review of the cancellation-fix wave is still in progress. Covering tests after that wave: **249 capability/input/manual + 301 lifecycle/render = 550 passed**. Nested full AVA: **1466 passed / 4 known failures / 1 todo / exit 0**. Source typecheck, nested build, owned-test TypeScript, and scoped formatting passed. Local consumers against the rebuilt fork: **534 ink-input tests, 349 CLI tests, CLI build exit 0**. YAML/lockfile remain the pre-existing `link:packages/ink` selection.


## Foreground terminal acceptance

The ignored outer diagnostic `.superpowers/sdd/probe-osc66-width.mjs` uses the locally built Ink encoder. Its syntax and non-TTY refusal were verified. **User-run Kitty encoded-advance acceptance passed on 2026-09-06:** `TERM=xterm-kitty`, program/version unavailable, OSC 66 supported, all eight checks passed. This verifies the encoder on that physical terminal; it does not yet verify automatic Ink startup negotiation.

| User-measured Kitty sample | Allocated | Encoded advance | Result |
| -------------------------- | --------: | --------------: | ------ |
| ASCII control              |         1 |               1 | PASS   |
| `⚡`                       |         2 |               2 | PASS   |
| `⚡︎` (VS15)                |         2 |               2 | PASS   |
| `⚡️` (VS16)                |         2 |               2 | PASS   |
| `⚠️`                       |         2 |               2 | PASS   |
| `✅`                       |         2 |               2 | PASS   |
| `❌`                       |         2 |               2 | PASS   |
| Complete emoji line        |        25 |              25 | PASS   |

Original codepoints were preserved in every reported sample. Complete-line bytes were 40 raw / 106 encoded. Earlier raw Kitty measurements were 1 cell for `⚡︎` and 24 cells for the complete line; explicit-width output corrects those measured disagreements. Terminal.app and Warp encoded measurements, automatic Ink negotiation, near-edge redraw, and copy checks remain pending.

After `npm run build` in `packages/ink`, run from the outer repository in a normal foreground shell outside Nuvin:

```sh
node .superpowers/sdd/probe-osc66-width.mjs
```

Use a terminal at least 40 columns wide. The diagnostic prints only on new lines, queries private cursor reports, and restores input mode. Run separately in Kitty, Terminal.app, and Warp. Do not redirect the diagnostic into a running TUI.

Acceptance on a supporting terminal is `encodedAdvance === allocated` for every sample, with original codepoints preserved. Raw text may still advance differently. A terminal that does not answer private CPR or support OSC 66 is not claimed fixed by this phase.

For actual local Ink Static/dynamic text and a right-edge sentinel, run `env -u INK_EXPLICIT_WIDTH node .superpowers/sdd/osc66-interactive-check.mjs` in your verified Kitty. Press `n` to redraw, resize the terminal, copy original emoji/selectors, and press `q` to exit. Compare with `INK_EXPLICIT_WIDTH=1` if needed. Its syntax and non-TTY refusal were checked; **physical automatic negotiation remains pending**. Also check Ink selection/copy in the actual CLI. Synthetic stdout tests cannot establish terminal copy fidelity or glyph behavior.

## Delivery and known limitations

- No commit, push, publication, version bump, or registry upgrade is authorized.
- The current checkout already links local Ink, so rebuilding it is consumed locally. Published installations do not receive this change; publication and any registry version upgrade require separate authorization.
- Automatic detection is now the default for eligible interactive TTY output. `INK_EXPLICIT_WIDTH=1` still forces encoding without a probe; `INK_EXPLICIT_WIDTH=0` or `explicitWidth: 'disabled'` skip detection. Leave force-on unset on unsupported/unverified terminals; forcing it there may hide wrapped non-ASCII text. No terminal-specific width fallback is included.
- The encoder intentionally leaves unsafe, oversized, and non-positive-width payloads unchanged.
- Installed Ink XO was previously blocked by missing `xo/dist/cli.js`; no lint success is inferred from typecheck or formatting.
- Physical terminal acceptance remains distinct from source and consumer test success.
