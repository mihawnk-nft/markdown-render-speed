[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/mihawnk-nft/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/mihawnk-nft/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

Built for [make.fun's "Markdown render speed" bounty](https://make.fun/bounty/markdown-render-speed-02) ($250 in USDC).

A fast, dependency-free drop-in replacement for marked 18.1.3 (GFM on,
default options): `parse.js` exports `parse(markdown)` returning exactly the
HTML `marked.parse(markdown)` returns, and `main.ts` renders every case in
`/input/cases.json` to `/output/html.json`.

Single-pass block + inline parser, direct HTML emission, no token tree, no
regular-expression hot paths. Pure Node.js standard library, no dependencies.
