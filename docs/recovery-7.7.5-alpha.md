# 7.7.5-alpha reconstruction provenance

This is a TypeScript reconstruction from published artifacts, **not the original
7.7.5-alpha source, tests, or Git history**. It preserves published behavior rather
than introducing fixes or improvements.

## Sources of evidence

- Surviving source baseline: `e196cfb328496c02d0f54cd516b8c91725ca0218`
  (`master`, package version `7.7.1-alpha`). The standalone repository was clean
  before recovery edits.
- Behavioral/API reference: npm `@nuvin/ink@7.7.5-alpha`.
- Registry publishing `gitHead`: `7dd2a32b5dceea9fcf55a448d63d264e7243a4fc`.
  That commit was unavailable from GitHub during recovery; this document does not
  claim to restore it or its intervening commits.
- Tarball: <https://registry.npmjs.org/@nuvin/ink/-/ink-7.7.5-alpha.tgz>.
- Registry SHA-1: `a443e17cc55d47583498337c17f73dc8b98ab4d9`.
- Registry integrity, independently checked against the downloaded bytes:
  `sha512-e8SafYfRAMHgF5Bklrbz/k4us47B74v5VAOw8a9L2foUWajM8KGXVxiSZLi+AspnjxyW6WmdR9wMrioYce94Og==`.
- All 228 published files matched an independent copy of the outer project's
  installed `node_modules/ink` package. The installed package was not modified.

Local recovery evidence is stored outside this standalone repository at
`../../.sandbox/ink-recovery-coordination/`: the tarball, registry metadata,
`reference-installed/`, `reference-npm/package/`, comparison helper,
`artifact-manifest.json`, and verification logs. References were preserved
before builds, including the test that deletes and recreates local `build/`.

The target manifest SHA-256 is
`f7ad2a8bef2fca141b565238139b166cb507532597e2fce69dcea2123802449e`.
Its input is the sorted list of all 228 published paths, each represented by
`<file SHA-256><two spaces><relative path><LF>`. The local JSON manifest includes
both candidate and target hashes for every published file.

## Reconstructed and exact material

Nine existing TypeScript modules were reconstructed: `allocated-seek`, `ink`,
`log-update`, `output`, `render-node-to-output`, `renderer`, `sanitize-ansi`,
`text-selection`, and `text-selection-controller`. Surviving types were retained;
new erased types describe caches, callbacks, selection bounds, and anchor state.
No `ts-nocheck` or JavaScript-as-TypeScript replacement files were used.

With TypeScript **5.9.3** and the repository's strict configuration:

| Artifact | Result |
| --- | --- |
| JavaScript | **75/75 byte-identical**, including emitted comments and map trailers |
| Declarations | **75/75 byte-identical**, including unchanged `index.d.ts` |
| Source maps | 68/75 identical; seven reconstructed modules have different positions |
| Module inventory | No added or removed runtime modules |
| `package.json`, `readme.md`, `license` | Byte-identical to the npm package |

The differing source maps are for `allocated-seek`, `log-update`, `output`,
`renderer`, `sanitize-ansi`, `text-selection-controller`, and `text-selection`.
Map identity is not a reconstruction requirement. All 75 published maps lack
`sourcesContent`, so neither matching maps nor matching output proves original
TypeScript text or original erased type annotations.

The only metadata changes from the baseline are version `7.7.5-alpha` and the
published `@types/react-reconciler` pin from `^0.33.0` to `0.33.0`. Runtime
requirements, exports, scripts, and engines are unchanged.

## Verification and test provenance

New tests marked `reconstruction:` were authored during this recovery; they are
not recovered upstream tests. They cover text normalization, seek recovery and
prepared-row reuse, bounded output caches, selection bounds/gap filling, and
absolute cursor anchoring (including stale replies, retry limits, reset/sync,
and an xterm model check preserving prompt rows above the frame).

Existing tests were adapted only where the published artifacts establish a
changed contract:

- Fullscreen scroll fixtures now provide terminal height; an unknown absolute
  anchor no longer permits scroll-region optimization. Original byte and
  transform-work assertions remain.
- Invalid seek **frame** rows recover as plain text rather than aborting the
  frame; direct `prepareSeekRow` validation remains strict. Recovery is also
  replayed through the terminal model.
- Incremental rendering installs the private CPR response channel even with
  explicit-width negotiation disabled/forced; the non-incremental application
  input behavior is checked separately.

Validation commands from this repository:

```sh
npm run typecheck
npm run build
NODE_ENV=test FORCE_COLOR=true npx ava
node ../../.sandbox/ink-recovery-coordination/compare-artifacts.mjs
```

The full suite passed: **1616 tests**, with AVA also reporting **4 existing
expected failures** and **1 existing todo**. `NODE_ENV=test` is important: the
host inherited `NODE_ENV=production`, which removes React's `act` API used by
existing tests. Relevant focused suites and terminal-model checks also passed.
The known baseline-wide XO lint debt was not repaired or used as a recovery
gate; `npm test` includes that unrelated lint step, so AVA was invoked directly.

## Unrecoverable material

Original source formatting, erased types, unpublished tests, intermediate
commits, and non-published development files cannot be recovered from this
package. The restored README references `benchmark/seek-preparation.ts`, but
that file exists in neither the surviving baseline nor the npm tarball. It was
**not fabricated**; that benchmark command remains unavailable in this recovery.
