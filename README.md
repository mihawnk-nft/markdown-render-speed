# markdown-render-speed-02

A fast, dependency-free drop-in replacement for marked 18.1.3 (GFM on,
default options): `parse.js` exports `parse(markdown)` returning exactly the
HTML `marked.parse(markdown)` returns, and `main.ts` renders every case in
`/input/cases.json` to `/output/html.json`.

Single-pass block + inline parser, direct HTML emission, no token tree, no
regular-expression hot paths. Pure Node.js standard library, no dependencies.
