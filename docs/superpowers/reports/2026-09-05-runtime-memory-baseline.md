# Nested Ink runtime-memory baseline (T1b direct-fixture charges)

Date: 2026-09-05
Nested revision: `b0c28f915eda420fc650b26bf88f8812a209642a` (`perf/incremental-scroll-region`)
Nested working tree: clean (`git diff` SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
No Ink source was modified. No heap or renderer-wide cache traffic is claimed.

## Canonical module URLs

Published Ink (CLI and VL resolution, identical):

- `/Users/marsch/Projects/nuvin/nuvin-agent/node_modules/.pnpm/@nuvin+ink@7.6.0-alpha_@types+react@19.2.14_react-devtools-core@7.0.1_react@19.2.5/node_modules/@nuvin/ink/build/index.js`
- version `7.6.0-alpha`

Direct nested source used for fixture charges (production `NODE_ENV=production`):

- `file:///Users/marsch/Projects/nuvin/nuvin-agent/packages/ink/src/measure-text.ts`
- `file:///Users/marsch/Projects/nuvin/nuvin-agent/packages/ink/src/wrap-text.ts`

## Charge definitions (fixture accounting, not measured heap)

- Measurement charge: `2 * text.length`
- Wrapping charge: `2 * (JSON.stringify([text, width, mode]).length + actualWrappedResult.length)`

## Inputs

8 texts: 5 known (plain ASCII, repeated wrap line, Unicode/emoji/wide, multiline with blanks, tabs) plus recorded nested source (`measure-text.ts`, `wrap-text.ts`, first 4000 chars of `ink.tsx`).

Widths: 40, 80, 120.
Modes: `wrap`, `hard`, `truncate`, `truncate-middle`, `truncate-start`.

## Distributions

measureText charges (n=8):

- count 8
- min 22
- median 68
- p95 8000
- max 8000

wrapText charges (n=120 = 8 texts × 3 widths × 5 modes):

- count 120
- min 72
- median 190
- p95 8802
- max 18168

These are fixture entry charges for I1 calibration, not a renderer-wide histogram and not a retained-heap measurement.
