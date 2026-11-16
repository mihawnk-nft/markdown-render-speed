[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/mihawnk-nft/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/mihawnk-nft/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

Built for [make.fun's "Markdown render speed" bounty](https://make.fun/bounty/markdown-render-speed-02) ($250 in USDC, top 20 paid).

A fast, dependency-free drop-in replacement for marked 18.1.3 (GFM on,
default options). `parse.js` exports `parse(markdown)`, returning exactly
the HTML `marked.parse(markdown)` returns; `main.ts` renders every case in
`/input/cases.json` to `/output/html.json`.

How it works: a single-pass line-based block parser (fences, ATX/setext
headings, hr, blockquotes, lists, HTML blocks, link definitions, GFM
tables, paragraphs) plus a single-pass inline scanner (code spans, links
and images, autolinks, emphasis via a greedy delimiter scan that mirrors
marked's emStrong). HTML is emitted directly — no token tree, no
regular-expression hot paths. Pure Node.js standard library, no
dependencies.

Locally verified against the practice set: 720/720 cases identical to
marked, ~1.5x faster than marked.
