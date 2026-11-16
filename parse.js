// Fast drop-in replacement for marked 18.1.3 (GFM on, default options).
// Single-pass block parser + inline parser, direct HTML emission.
// Pure JavaScript, no dependencies.

export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  // Lexer state shared across the whole document (marked's Lexer.state):
  // an unclosed <a> (or <pre>/<code>/<kbd>/<script>) in one block keeps
  // inLink/inRawBlock set for later blocks, suppressing GFM autolinks etc.
  const ctx = { links: Object.create(null), endsWithNL: src.endsWith('\n'), st: { inLink: false, inRawBlock: false } };
  const lines = src.split('\n');
  // A trailing '' is only the artifact of a final newline, not a blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const blocks = [];
  blockParse(lines, 0, lines.length, true, blocks, ctx, false, true);
  let out = '';
  for (let i = 0; i < blocks.length; i++) out += renderBlock(blocks[i], ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------
const ASCII_PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[ch.charCodeAt(0)] = 1;
const ASCII_ALNUM = new Uint8Array(128);
for (let c = 48; c <= 57; c++) ASCII_ALNUM[c] = 1;
for (let c = 65; c <= 90; c++) ASCII_ALNUM[c] = 1;
for (let c = 97; c <= 122; c++) ASCII_ALNUM[c] = 1;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? ASCII_PUNCT[c] === 1 : PUNCT_RE.test(ch);
}
function isSpaceCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
  return SPACE_RE.test(ch);
}
function isAlnumCh(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? ASCII_ALNUM[c] === 1 : ALNUM_RE.test(ch);
}
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}
// whitespace for the GFM "space" class used in several places (space/tab)
function isSpaceOrTab(c) { return c === 32 || c === 9; }

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------
// escapeHtmlEntities(text) with encode=false, plus numeric character reference
// decoding (what marked's inlineText + renderer text do together).
// - numeric refs &#123; / &#x1F; decode to the char (0, >0x10FFFF, surrogates -> U+FFFD)
// - '&' followed by a valid ref pattern (#digits; #xhex; word;) stays literal
// - bare '&' -> &amp; ; '<' '>' '"' "'" -> &lt; &gt; &quot; &#39;
// The decoded char itself is escaped if it is one of < > " ' & (38 -> &amp;).
function escText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let start = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      // try numeric reference
      if (i + 1 < n && s.charCodeAt(i + 1) === 35) { // &#
        let j = i + 2;
        let hex = false;
        if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
        const d0 = j;
        let code = 0;
        let valid = false;
        let digits = 0;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (hex) {
            if (d >= 48 && d <= 57) { code = code * 16 + (d - 48); digits++; j++; }
            else if (d >= 65 && d <= 70) { code = code * 16 + (d - 55); digits++; j++; }
            else if (d >= 97 && d <= 102) { code = code * 16 + (d - 87); digits++; j++; }
            else break;
          } else {
            if (d >= 48 && d <= 57) { code = code * 10 + (d - 48); digits++; j++; }
            else break;
          }
          if (digits > 7) break;
        }
        if (digits >= 1 && digits <= (hex ? 6 : 7) && j < n && s.charCodeAt(j) === 59) { // ;
          valid = true;
          out += s.slice(start, i);
          let ch;
          if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) ch = '\uFFFD';
          else if (code === 38) ch = '&amp;';
          else ch = String.fromCodePoint(code);
          // escape the decoded char if needed
          if (ch === '<') out += '&lt;';
          else if (ch === '>') out += '&gt;';
          else if (ch === '"') out += '&quot;';
          else if (ch === "'") out += '&#39;';
          else out += ch;
          i = j + 1;
          start = i;
          continue;
        }
        // not a valid numeric ref: fall through to the '&' handling below
        void d0; void valid;
      }
      // '&' followed by a valid ref pattern stays literal
      if (isEntityRef(s, i)) { i++; continue; }
      out += s.slice(start, i);
      out += '&amp;';
      i++;
      start = i;
      continue;
    }
    if (c === 60) { out += s.slice(start, i); out += '&lt;'; i++; start = i; continue; }
    if (c === 62) { out += s.slice(start, i); out += '&gt;'; i++; start = i; continue; }
    if (c === 34) { out += s.slice(start, i); out += '&quot;'; i++; start = i; continue; }
    if (c === 39) { out += s.slice(start, i); out += '&#39;'; i++; start = i; continue; }
    i++;
  }
  if (start === 0) return s;
  return out + s.slice(start);
}
// Is the '&' at position i the start of a valid entity reference pattern
// (#digits; | #xhex; | word;) ? (marked does NOT check the name against a table)
function isEntityRef(s, i) {
  let j = i + 1;
  const n = s.length;
  if (j < n && s.charCodeAt(j) === 35) { // #
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x
      j++;
      let d = 0;
      while (j < n && d < 6) {
        const c = s.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) { d++; j++; }
        else break;
      }
      return d >= 1 && j < n && s.charCodeAt(j) === 59;
    }
    let d = 0;
    while (j < n && d < 7) {
      const c = s.charCodeAt(j);
      if (c >= 48 && c <= 57) { d++; j++; } else break;
    }
    return d >= 1 && j < n && s.charCodeAt(j) === 59;
  }
  let d = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) { d++; j++; }
    else break;
  }
  return d >= 1 && j < n && s.charCodeAt(j) === 59;
}
// escapeHtmlEntities(text, encode=true): escape every & < > " '
function escEncode(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let start = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i); out += '&amp;'; i++; start = i; continue; }
    if (c === 60) { out += s.slice(start, i); out += '&lt;'; i++; start = i; continue; }
    if (c === 62) { out += s.slice(start, i); out += '&gt;'; i++; start = i; continue; }
    if (c === 34) { out += s.slice(start, i); out += '&quot;'; i++; start = i; continue; }
    if (c === 39) { out += s.slice(start, i); out += '&#39;'; i++; start = i; continue; }
    i++;
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// ---------------------------------------------------------------------------
// URL handling (marked cleanUrl + encodeURI semantics)
// ---------------------------------------------------------------------------
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

// ---------------------------------------------------------------------------
// Link label normalization (marked normalizeLabel)
// ---------------------------------------------------------------------------
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}
// indentation of a line in columns (tabs expand to next multiple of 4);
// returns [columns, index of first non-space/tab char]
function lineIndent(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return [col, i];
}
// remove `cols` columns of indentation from the start of a line.
// A tab that straddles the boundary is replaced by spaces.
function stripIndent(line, cols) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else {
        // tab straddles: keep the remainder as spaces
        return ' '.repeat(col + w - cols) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}
function rtrimStr(s, ch) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === ch) e--;
  return s.slice(0, e);
}

// ---------------------------------------------------------------------------
// Inline parsing
// Node types: {t:'h', h} pre-rendered HTML; {t:'d', c, n, o, cl} delimiter;
// {t:'e', tag, ch} em/strong/del.
// ---------------------------------------------------------------------------

function inlineToHtml(s, links, st) {
  const nodes = scanInline(s, links, st, 0, s.length);
  resolveEmphasis(nodes);
  return renderNodes(nodes);
}

// flanking for a delimiter run [start, end) in s
function delimFlanking(s, start, end) {
  const prev = start > 0 ? s[start - 1] : '\n';
  const next = end < s.length ? s[end] : '\n';
  const prevSpace = isSpaceCh(prev);
  const nextSpace = isSpaceCh(next);
  const prevPunct = isPunctCh(prev);
  const nextPunct = isPunctCh(next);
  const leftFlanking = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const rightFlanking = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  return [leftFlanking, rightFlanking];
}

function scanInline(s, links, st, start, end) {
  const nodes = [];
  let i = start;
  let textStart = -1; // start of pending plain-text run
  const flushText = (upto) => {
    if (textStart >= 0 && upto > textStart) {
      nodes.push({ t: 'h', h: st.inRawBlock ? s.slice(textStart, upto) : escText(s.slice(textStart, upto)) });
      textStart = -1;
    }
  };
  const pushHtml = (h, extra) => {
    flushText(i);
    const nd = { t: 'h', h };
    if (extra) {
      if (extra.a !== undefined) nd.a = extra.a;
      if (extra.alt !== undefined) nd.alt = extra.alt;
      if (extra.link) nd.link = true;
    }
    nodes.push(nd);
  };

  while (i < end) {
    const c = s.charCodeAt(i);
    // backslash: escape or hard break
    if (c === 92) { // \
      if (i + 1 < end && s.charCodeAt(i + 1) === 10) { // \<newline> = br (not at end of run)
        // br rule: \n not followed by only whitespace to end of the inline source
        let j = i + 2;
        while (j < end && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
        // marked: (?!\s*$) — the \n must not be followed by only whitespace then end
        let k = j;
        let onlyWs = true;
        while (k < end) { if (!isSpaceCode(s.charCodeAt(k))) { onlyWs = false; break; } k++; }
        if (!onlyWs) {
          flushText(i);
          nodes.push({ t: 'h', h: '<br>', a: '' });
          i = j;
          continue;
        }
        // else fall through to text
      } else if (i + 1 < end && s.charCodeAt(i + 1) < 128 && ASCII_PUNCT[s.charCodeAt(i + 1)] === 1) {
        const ch = s[i + 1];
        flushText(i);
        nodes.push({ t: 'h', h: ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch === '&' ? '&amp;' : ch });
        i += 2;
        continue;
      }
      // literal backslash: part of text
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    // backtick: code span
    if (c === 96) { // `
      const cs = parseCodeSpan(s, i, end);
      if (cs) { pushHtml(cs.html, { a: cs.alt }); i = cs.end; continue; }
      // no matching closer: the whole backtick run is literal text
      // (marked's codespan regex fails the entire run, it does not retry
      //  from the second backtick)
      let j = i;
      while (j < end && s.charCodeAt(j) === 96) j++;
      if (textStart < 0) textStart = i;
      i = j;
      continue;
    }
    // [ or ![ : link
    if (c === 91 || (c === 33 && i + 1 < end && s.charCodeAt(i + 1) === 91)) {
      const lk = parseLink(s, i, end, links, st);
      if (lk) { pushHtml(lk.html, lk); i = lk.end; continue; }
      // not a link: the '[' (or '!') is literal text; '!' alone is text too
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    // * _ : emphasis delimiter
    if (c === 42 || c === 95) { // * _
      let j = i + 1;
      while (j < end && s.charCodeAt(j) === c) j++;
      const ch = c === 42 ? '*' : '_';
      const [lf, rf] = delimFlanking(s, i, j);
      let canOpen, canClose;
      if (ch === '*') { canOpen = lf; canClose = rf; }
      else {
        // _ rule: can open iff left-flanking and (not right-flanking or preceded by punct)
        canOpen = lf && (!rf || (i > 0 && isPunctCh(s[i - 1])));
        // can close iff right-flanking and (not left-flanking or followed by punct)
        // NB: the char after the run lives in the full source string, even
        // when the run ends exactly at the scan boundary (e.g. a closing
        // `__` right before the `]` of a link label) — guard on s.length.
        canClose = rf && (!lf || (j < s.length && isPunctCh(s[j])));
      }
      if (canOpen || canClose) {
        flushText(i);
        nodes.push({ t: 'd', c: ch, n: j - i, o: canOpen, cl: canClose });
        i = j;
        continue;
      }
      if (textStart < 0) textStart = i;
      i = j;
      continue;
    }
    // ~ : strikethrough delimiter (GFM). A run of 3+ tildes is literal
    // (marked's del regex needs 1-2 tildes followed by a non-tilde char)
    if (c === 126) { // ~
      let j = i + 1;
      while (j < end && s.charCodeAt(j) === 126) j++;
      if (j - i >= 3) {
        if (textStart < 0) textStart = i;
        i = j;
        continue;
      }
      const [lf, rf] = delimFlanking(s, i, j);
      const canOpen = lf, canClose = rf;
      if (canOpen || canClose) {
        flushText(i);
        nodes.push({ t: 'd', c: '~', n: j - i, o: canOpen, cl: canClose });
        i = j;
        continue;
      }
      if (textStart < 0) textStart = i;
      i = j;
      continue;
    }
    // < : HTML tag or autolink
    if (c === 60) { // <
      const tg = parseHtmlTag(s, i, end, st);
      if (tg) { pushHtml(tg.html, { a: tg.html }); applyTagState(st, tg.html); i = tg.end; continue; }
      const al = parseAutolink(s, i, end);
      if (al) { pushHtml(al.html, { a: al.alt }); i = al.end; continue; }
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    // hard break: two or more spaces then newline (not at end)
    if (c === 32) {
      let j = i;
      while (j < end && s.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < end && s.charCodeAt(j) === 10) {
        let k = j + 1;
        while (k < end && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
        let m = k;
        let onlyWs = true;
        while (m < end) { if (!isSpaceCode(s.charCodeAt(m))) { onlyWs = false; break; } m++; }
        if (!onlyWs) {
          flushText(i);
          nodes.push({ t: 'h', h: '<br>', a: '' });
          i = k;
          continue;
        }
      }
      if (textStart < 0) textStart = i;
      i = j;
      continue;
    }
    // newline: soft break (literal \n in output)
    if (c === 10) {
      if (textStart < 0) textStart = i;
      i++;
      continue;
    }
    // GFM autolink (www. / scheme / email), only when not inside a link
    if (!st.inLink && (c === 119 || c === 104 || c === 102 || c === 109 || c === 120 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      const gu = parseGfmUrl(s, i, end, st);
      if (gu) { pushHtml(gu.html, { a: gu.alt }); i = gu.end; continue; }
    }
    if (textStart < 0) textStart = i;
    i++;
  }
  flushText(end);
  return nodes;
}

function renderNodes(nodes) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.t === 'h') out += nd.h;
    else if (nd.t === 'd') out += nd.c.repeat(nd.n);
    else out += '<' + nd.tag + '>' + renderNodes(nd.ch) + '</' + nd.tag + '>';
  }
  return out;
}

// CommonMark rules 9-10: if either delimiter can both open and close, the
// sum of the two runs must not be a multiple of 3 unless both are.
function oddMatch(opener, closer) {
  if (!((opener.o && opener.cl) || (closer.o && closer.cl))) return false;
  const sum = opener.n + closer.n;
  if (sum % 3 === 0 && !(opener.n % 3 === 0 && closer.n % 3 === 0)) return true;
  return false;
}

function resolveEmphasis(nodes) {
  // collect delimiter nodes in order
  const delims = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i].t === 'd') delims.push(nodes[i]);
  if (delims.length === 0) return;
  const stack = []; // openers
  outer:
  for (let di = 0; di < delims.length; di++) {
    const d = delims[di];
    if (d.n === 0) continue;
    if (d.cl) {
      // look back for a matching opener
      let oi = stack.length - 1;
      while (oi >= 0) {
        const o = stack[oi];
        if (o.c !== d.c || o.n === 0) { oi--; continue; }
        if (oddMatch(o, d)) { oi--; continue; }
        // marked's regex emStrong treats `**` as an atomic unit: a lone
        // closer must not eat one `*` of a `**` opener when a `**` closer
        // follows later that can close the opener fully. Skip this opener
        // so the later `**` closer pairs with it instead.
        if (o.n > d.n) {
          let later = false;
          for (let li = di + 1; li < delims.length; li++) {
            const ld = delims[li];
            if (ld.c === d.c && ld.cl && ld.n >= o.n) { later = true; break; }
          }
          if (later) { oi--; continue; }
        }
        // match found
        const use = (o.n >= 2 && d.n >= 2) ? 2 : 1;
        // `~` is strikethrough (del) for one or two tildes (marked's behaviour)
        const tag = d.c === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        // locate opener and closer in the nodes array
        const oIdx = nodes.indexOf(o);
        const dIdx = nodes.indexOf(d);
        if (oIdx < 0 || dIdx < 0 || oIdx >= dIdx) break;
        const children = nodes.slice(oIdx + 1, dIdx);
        const emNode = { t: 'e', tag, ch: children };
        o.n -= use;
        d.n -= use;
        // remove inner delimiters from the stack (they are now inside em)
        for (let k = stack.length - 1; k > oi; k--) stack.splice(k, 1);
        // rebuild the nodes array around the match
        const before = nodes.slice(0, oIdx);
        const after = nodes.slice(dIdx + 1);
        const mid = [];
        if (o.n > 0) mid.push(o);
        mid.push(emNode);
        if (d.n > 0) mid.push(d);
        nodes.length = 0;
        for (const x of before) nodes.push(x);
        for (const x of mid) nodes.push(x);
        for (const x of after) nodes.push(x);
        // the opener stays on the stack if it still has length
        if (o.n === 0) stack.splice(oi, 1);
        // the closer, if it still has length, may close an earlier opener:
        // keep scanning it against the stack
        if (d.n > 0) {
          // re-run the closer search for the remaining length
          let oi2 = stack.length - 1;
          let matched = false;
          while (oi2 >= 0) {
            const o2 = stack[oi2];
            if (o2.c !== d.c || o2.n === 0) { oi2--; continue; }
            if (oddMatch(o2, d)) { oi2--; continue; }
            // found another opener; loop back by reprocessing this delimiter
            // (simulate by setting di back and breaking out)
            matched = true;
            break;
          }
          if (matched) {
            // reprocess the same delimiter node: do not advance di
            di--;
            continue outer;
          }
        }
        break; // done with this closer
      }
    }
    if (d.o && d.n > 0) {
      // if already on the stack (reprocessed), don't push twice
      if (!stack.includes(d)) stack.push(d);
    }
  }
}

// ---------------------------------------------------------------------------
// Code spans
// ---------------------------------------------------------------------------
function parseCodeSpan(s, i, end) {
  // count opening backticks
  let j = i;
  while (j < end && s.charCodeAt(j) === 96) j++;
  const n = j - i;
  // find a matching run of exactly n backticks
  let k = j;
  while (k < end) {
    if (s.charCodeAt(k) === 96) {
      let m = k;
      while (m < end && s.charCodeAt(m) === 96) m++;
      if (m - k === n) {
        let text = s.slice(j, k).replace(/\n/g, ' ');
        const hasNonSpace = /[^ ]/.test(text);
        if (hasNonSpace && text.charCodeAt(0) === 32 && text.charCodeAt(text.length - 1) === 32) {
          text = text.slice(1, -1);
        }
        return { html: '<code>' + escEncode(text) + '</code>', alt: text, end: m };
      }
      k = m;
    } else k++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML tags (inline) and autolinks
// ---------------------------------------------------------------------------
const INLINE_TAG_RE = /^(?:<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>)/;
function parseHtmlTag(s, i, end, st) {
  const sub = s.slice(i, end);
  const m = INLINE_TAG_RE.exec(sub);
  if (!m) return null;
  const raw = m[0];
  return { html: raw, end: i + raw.length };
}
// Apply an inline HTML tag's effect on the shared lexer state. This must
// run AFTER the pending text before the tag is flushed: the text before
// <code> is escaped, the text inside <code>...</code> is raw, and the
// text after </code> is escaped again. (Flushing first with the old state
// is what makes &#x1F600; before <code> decode while text inside stays raw.)
function applyTagState(st, raw) {
  if (!st.inLink && /^<a /i.test(raw)) st.inLink = true;
  else if (st.inLink && /^<\/a>/i.test(raw)) st.inLink = false;
  if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(raw)) st.inRawBlock = true;
  else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(raw)) st.inRawBlock = false;
}
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
function parseAutolink(s, i, end) {
  const m = AUTOLINK_RE.exec(s.slice(i, end));
  if (!m) return null;
  const full = m[0];
  const inner = m[1];
  const isEmail = inner.indexOf('@') >= 0 && inner.indexOf(':') < 0;
  // distinguish: email form has @ and no scheme colon before it
  const href = isEmail ? 'mailto:' + inner : inner;
  const text = inner;
  const clean = cleanUrl(href);
  if (clean === null) return null;
  const hrefEsc = escEncode(clean);
  const textEsc = escEncode(text);
  return { html: '<a href="' + hrefEsc + '">' + textEsc + '</a>', alt: text, end: i + full.length };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
// Find the closing ']' of a label starting at s[start] === '['.
// Handles nested brackets (depth), escapes, code spans. A label may span
// lines but not blank lines. Returns the index of ']' or -1.
// Find the closing `]` of a reference/definition label (marked's _blockLabel):
// no unescaped `[` or `]` inside, backslash escapes allowed, a newline is
// allowed unless it starts a blank line. Returns the index of `]` or -1.
function findRefLabelEnd(s, start, end) {
  let i = start + 1;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escape
    if (c === 91) return -1; // unescaped [ inside a ref label: invalid
    if (c === 93) return i; // ]
    if (c === 10) { // newline: allowed unless it starts a blank line
      let j = i + 1;
      while (j < end && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
      if (j >= end || s.charCodeAt(j) === 10) return -1;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// marked's isLabelEndInsideToken: the label's closing `]` lies inside an
// HTML tag or autolink that starts inside the label, so the link is not a
// link at all (e.g. `[foo<https://x/?a=](uri)>`).
function labelEndInsideToken(s, labelStart, labelEnd, end, st) {
  const label = s.slice(labelStart + 1, labelEnd);
  if (label.indexOf('<') < 0) return false;
  for (let k = 0; k < label.length; k++) {
    const c = label.charCodeAt(k);
    if (c === 92) { k++; continue; }
    if (c === 96) { // code span: skip it
      let j = k;
      while (j < label.length && label.charCodeAt(j) === 96) j++;
      const n = j - k;
      let m = j, closed = -1;
      while (m < label.length) {
        if (label.charCodeAt(m) === 96) {
          let p = m;
          while (p < label.length && label.charCodeAt(p) === 96) p++;
          if (p - m === n) { closed = p; break; }
          m = p;
        } else m++;
      }
      if (closed >= 0) { k = closed - 1; continue; }
      k = j - 1;
      continue;
    }
    if (c !== 60) continue; // <
    const pos = labelStart + 1 + k;
    const tg = parseHtmlTag(s, pos, end, st);
    const tok = tg || parseAutolink(s, pos, end);
    if (!tok) continue;
    if (tok.end > labelEnd) return true;
    k += (tok.end - pos) - 1;
  }
  return false;
}

function findLabelEnd(s, start, end) {
  let depth = 0;
  let i = start + 1;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // backslash escape
    if (c === 96) { // backtick run: marked's _inlineLabel regex rules
      let j = i;
      while (j < end && s.charCodeAt(j) === 96) j++;
      const n = j - i;
      // alternative 4: a run of 2+ backticks immediately before `]` is
      // allowed as-is (the `]` right after it ends the label)
      if (n >= 2 && j < end && s.charCodeAt(j) === 93) { i = j; continue; }
      // code-span alternative: opening run + shortest content + the FIRST
      // next backtick run of ANY length as closer. If there is no next
      // backtick run, the label regex fails (a bare backtick is not a
      // plain label char) -> no link.
      let k = j;
      let closed = -1;
      while (k < end) {
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < end && s.charCodeAt(m) === 96) m++;
          closed = m;
          break;
        }
        k++;
      }
      if (closed < 0) return -1;
      i = closed;
      continue;
    }
    if (c === 91) { depth++; i++; continue; } // [
    if (c === 93) { // ]
      if (depth === 0) return i;
      depth--; i++; continue;
    }
    if (c === 10) { // newline: allowed unless it starts a blank line
      let j = i + 1;
      while (j < end && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
      if (j >= end || s.charCodeAt(j) === 10) return -1; // blank line
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Parse the "(dest title)" part of an inline link, starting at s[i] === '('.
// Returns {href, title, end} (end = index after ')') or null.
function parseInlineLinkParen(s, i, end) {
  let p = i + 1;
  // skip [ \t\n]*
  while (p < end && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9 || s.charCodeAt(p) === 10)) p++;
  if (p >= end) return null;
  let href = '';
  if (s.charCodeAt(p) === 60) { // <...>
    let q = p + 1;
    let closed = -1;
    while (q < end) {
      const c = s.charCodeAt(q);
      if (c === 92) { q += 2; continue; }
      if (c === 10 || c === 60) break;
      if (c === 62) { closed = q; break; }
      q++;
    }
    if (closed < 0) return null; // no closing > : not a <...> destination
    href = s.slice(p + 1, closed);
    p = closed + 1;
  } else {
    // unquoted destination: balanced parens, ends at whitespace or ')'
    let q = p;
    let depth = 0;
    let destEnd = -1;
    while (q < end) {
      const c = s.charCodeAt(q);
      if (c === 92) { q += 2; continue; }
      if (c === 32 || c === 9 || c === 10) { destEnd = q; break; }
      if (c === 40) { depth++; q++; continue; } // (
      if (c === 41) { // )
        if (depth === 0) { destEnd = q; break; }
        depth--; q++; continue;
      }
      q++;
    }
    if (destEnd < 0) {
      // ran to end without whitespace or ')' — unbalanced or unterminated
      return null;
    }
    href = s.slice(p, destEnd);
    p = destEnd;
  }
  // after destination: optional title, then [ \t\n]* ')'
  // try to parse a title: skip separator, then quoted title
  let title = '';
  let saveP = p;
  // separator: [ \t]+(\n[ \t]*)? or \n[ \t]*
  let q = p;
  if (q < end && (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 9)) {
    while (q < end && (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 9)) q++;
    if (q < end && s.charCodeAt(q) === 10) {
      q++;
      while (q < end && (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 9)) q++;
    }
  } else if (q < end && s.charCodeAt(q) === 10) {
    q++;
    while (q < end && (s.charCodeAt(q) === 32 || s.charCodeAt(q) === 9)) q++;
  }
  if (q < end) {
    const qc = s.charCodeAt(q);
    if (qc === 34 || qc === 39 || qc === 40) { // " ' (
      const closer = qc === 40 ? 41 : qc;
      let r = q + 1;
      let closed = -1;
      while (r < end) {
        const c = s.charCodeAt(r);
        if (c === 92) { r += 2; continue; }
        if (c === closer) { closed = r; break; }
        r++;
      }
      if (closed >= 0) {
        title = s.slice(q + 1, closed);
        p = closed + 1;
      } else {
        // no closing quote: no title (backtrack to after destination)
        p = saveP;
      }
    } else {
      p = saveP;
    }
  } else {
    p = saveP;
  }
  // skip [ \t\n]* then expect ')'
  while (p < end && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9 || s.charCodeAt(p) === 10)) p++;
  if (p >= end || s.charCodeAt(p) !== 41) return null; // )
  // the ')' must not be escaped: count backslashes before it
  let bs = 0;
  let b = p - 1;
  while (b >= 0 && s.charCodeAt(b) === 92) { bs++; b--; }
  if (bs % 2 === 1) return null; // escaped ')'
  // unescape href and title (backslash before punctuation)
  href = unescapePunct(href);
  title = unescapePunct(title);
  return { href, title, end: p + 1 };
}
// "\X" -> X for ASCII punctuation X
function unescapePunct(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && s.charCodeAt(i + 1) < 128 && ASCII_PUNCT[s.charCodeAt(i + 1)] === 1) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

// does the node list (recursively) contain a link?
function nodesHaveLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'h' && nd.link) return true;
    if (nd.t === 'e' && nodesHaveLink(nd.ch)) return true;
  }
  return false;
}
// TextRenderer rendering of a node list (for image alt text): flatten to text
function renderTextNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'h') out += nd.a !== undefined ? nd.a : (nd.alt !== undefined ? nd.alt : nd.h);
    else if (nd.t === 'd') out += nd.c.repeat(nd.n);
    else out += renderTextNodes(nd.ch);
  }
  return out;
}

// Parse a link/image starting at s[i] ('[' or '!['). Returns {html, end} or null.
function parseLink(s, i, end, links, st) {
  const isImage = s.charCodeAt(i) === 33; // !
  const labelStart = isImage ? i + 1 : i;
  if (s.charCodeAt(labelStart) !== 91) return null; // [
  const labelEnd = findLabelEnd(s, labelStart, end);
  if (labelEnd < 0) return null;
  const label = s.slice(labelStart + 1, labelEnd);
  // the label's closing `]` must not lie inside an HTML tag / autolink
  if (labelEndInsideToken(s, labelStart, labelEnd, end, st)) return null;
  let href = null;
  let title = null;
  let after = labelEnd + 1;
  if (after < end && s.charCodeAt(after) === 40) { // (
    const par = parseInlineLinkParen(s, after, end);
    if (par) {
      href = par.href;
      title = par.title;
      after = par.end;
    } else {
      // invalid inline destination: fall back to a shortcut reference
      // (e.g. `[foo](not a link)` with `[foo]: /url1` defined)
      const key = normalizeLabel(label);
      const def = links[key];
      if (!def || /^\s*$/.test(label)) return null;
      href = def.href;
      title = def.title;
      after = labelEnd + 1;
    }
  } else if (after < end && s.charCodeAt(after) === 91) { // [ ref ]
    const refEnd = findRefLabelEnd(s, after, end);
    if (refEnd < 0) return null;
    const refLabel = s.slice(after + 1, refEnd);
    const key = normalizeLabel(refLabel === '' ? label : refLabel);
    const def = links[key];
    if (!def) return null;
    href = def.href;
    title = def.title;
    after = refEnd + 1;
  } else {
    // shortcut reference (label must not be empty/whitespace-only)
    if (/^\s*$/.test(label)) return null;
    const key = normalizeLabel(label);
    const def = links[key];
    if (!def) return null;
    href = def.href;
    title = def.title;
  }
  // parse the label text as inline (with inLink set, to suppress autolinks)
  const prevInLink = st.inLink;
  st.inLink = true;
  const labelNodes = scanInline(s, links, st, labelStart + 1, labelEnd);
  st.inLink = prevInLink;
  resolveEmphasis(labelNodes);
  if (!isImage && nodesHaveLink(labelNodes)) return null; // link in link: bail
  if (isImage) {
    const alt = renderTextNodes(labelNodes);
    const clean = cleanUrl(href);
    if (clean === null) return { html: escText(alt), end: after, a: alt };
    let out = '<img src="' + escText(clean) + '" alt="' + escText(alt) + '"';
    if (title) out += ' title="' + escText(title) + '"';
    out += '>';
    return { html: out, end: after, a: alt };
  }
  const textHtml = renderNodes(labelNodes);
  const clean = cleanUrl(href);
  if (clean === null) return { html: textHtml, end: after, a: renderTextNodes(labelNodes) };
  let out = '<a href="' + escText(clean) + '"';
  if (title) out += ' title="' + escText(title) + '"';
  out += '>' + textHtml + '</a>';
  return { html: out, end: after, a: renderTextNodes(labelNodes), link: true };
}

// ---------------------------------------------------------------------------
// GFM extended autolinks (www. / scheme / email)
// ---------------------------------------------------------------------------
const GFM_URL_RE = /^(?:(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
function parseGfmUrl(s, i, end, st) {
  const m = GFM_URL_RE.exec(s.slice(i, end));
  if (!m) return null;
  let text = m[0];
  // backpedal trailing punctuation
  let prev = '';
  do {
    prev = text;
    const b = BACKPEDAL_RE.exec(text);
    text = b ? b[0] : '';
  } while (prev !== text);
  if (text === '') return null;
  // An email inside __...__ (or _..._): the regex's (?![\w-]) lookahead
  // makes it stop before the final domain part(s) because the closing
  // `_`/`__` is a word char. Marked tokenises emphasis separately, so it
  // sees the full domain. Extend a truncated email domain while the next
  // chars form another `.part` (the lookahead only ever truncates here).
  if (text.indexOf('@') >= 0 && !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text) && !text.startsWith('www.')) {
    let pos = i + text.length;
    for (;;) {
      const rest = s.slice(pos, end);
      const dm = /^\.[a-zA-Z0-9-_]*[a-zA-Z0-9]/.exec(rest);
      if (!dm) break;
      // only extend when the part ends at a plausible boundary (not
      // mid-word: a following letter/digit would have been consumed by
      // the domain regex itself, so this is just a safety check)
      const after = pos + dm[0].length;
      const ac = after < s.length ? s.charCodeAt(after) : 0;
      if ((ac >= 48 && ac <= 57) || (ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122)) break;
      text += dm[0];
      pos = after;
    }
  }
  let href;
  if (text.indexOf('@') >= 0 && !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text) && !/^(?:https?|ftp):\/\//i.test(text) && !text.startsWith('www.')) {
    href = 'mailto:' + text;
  } else if (text.startsWith('www.')) {
    href = 'http://' + text;
  } else {
    href = text;
  }
  // the url must start at a valid position: beginning, whitespace, or after *, _, ~, (
  // (marked's GFM text regex stops at www. only after those; the url regex itself is
  // anchored, so we enforce the predecessor rule here)
  if (i > 0) {
    const prevCh = s[i - 1];
    if (text.startsWith('www.') && !(prevCh === ' ' || prevCh === '\t' || prevCh === '\n' || prevCh === '*' || prevCh === '_' || prevCh === '~' || prevCh === '(')) {
      // www. mid-word is not an autolink; but scheme/email may still match at this spot
      if (!/^(?:https?|ftp):\/\//i.test(text) && text.indexOf('@') < 0) return null;
    }
  }
  const clean = cleanUrl(href);
  if (clean === null) return null;
  return { html: '<a href="' + escEncode(clean) + '">' + escEncode(text) + '</a>', alt: text, end: i + text.length, link: true };
}

// ---------------------------------------------------------------------------
// Block parsing (line-based). Block records:
// {t:'p', s} paragraph | {t:'x', s} bare text (list item, top=false)
// {t:'h', d, s} heading | {t:'c', lang, s} code | {t:'hr'} | {t:'html', s}
// {t:'q', c} blockquote | {t:'l', o, st, items:[{task, checked, c}]}
// {t:'tb', h, a, r} table
// ---------------------------------------------------------------------------
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// does the line start a fenced code block? returns [markerChar, markerLen, info] or null
function fenceStart(line) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return null;
  const c = line.charCodeAt(idx);
  if (c !== 96 && c !== 126) return null; // ` ~
  let j = idx;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  const len = j - idx;
  if (len < 3) return null;
  const info = line.slice(j);
  // a backtick fence's info string may not contain backticks
  if (c === 96 && info.indexOf('`') >= 0) return null;
  return [c === 96 ? '`' : '~', len, info];
}
function atxHeading(line) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return null;
  let j = idx;
  while (j < line.length && line.charCodeAt(j) === 35) j++; // #
  const depth = j - idx;
  if (depth === 0 || depth > 6) return null;
  if (j < line.length && line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return null;
  let text = line.slice(j).trim();
  // remove trailing #s (only if preceded by space/tab or the text is all #s)
  if (text.charCodeAt(text.length - 1) === 35) {
    let k = text.length;
    while (k > 0 && text.charCodeAt(k - 1) === 35) k--;
    const trimmed = text.slice(0, k);
    if (trimmed === '' || trimmed.charCodeAt(trimmed.length - 1) === 32 || trimmed.charCodeAt(trimmed.length - 1) === 9) {
      text = trimmed.trim();
    }
  }
  return [depth, text];
}
function isHrLine(line) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return false;
  let i = idx;
  const c = line.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false; // - _ *
  let count = 0;
  while (i < line.length) {
    const d = line.charCodeAt(i);
    if (d === c) { count++; i++; }
    else if (d === 32 || d === 9) i++;
    else return false;
  }
  return count >= 3;
}
function isSetextLine(line) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return 0;
  let i = idx;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0; // = -
  while (i < line.length && line.charCodeAt(i) === c) i++;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i !== line.length) return 0;
  return c === 61 ? 1 : 2;
}
// blockquote marker: returns the index after the marker (and one space/tab), or -1
function blockquoteMarker(line) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return -1;
  if (line.charCodeAt(idx) !== 62) return -1; // >
  let j = idx + 1;
  if (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j;
}
// list marker: returns [bullet, bulletLen, isOrdered, startNum, contentIdx] or null
function listMarker(line) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return null;
  const c = line.charCodeAt(idx);
  if (c === 45 || c === 42 || c === 43) { // - * +
    if (idx + 1 < line.length && line.charCodeAt(idx + 1) !== 32 && line.charCodeAt(idx + 1) !== 9) return null;
    return [line[idx], 1, false, 0, idx + 1];
  }
  if (c >= 48 && c <= 57) {
    let j = idx;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    const numStr = line.slice(idx, j);
    if (numStr.length > 9) return null;
    if (j < line.length && (line.charCodeAt(j) === 46 || line.charCodeAt(j) === 41)) { // . )
      if (j + 1 < line.length && line.charCodeAt(j + 1) !== 32 && line.charCodeAt(j + 1) !== 9) return null;
      return [line.slice(idx, j + 1), j + 1 - idx, true, parseInt(numStr, 10), j + 1];
    }
  }
  return null;
}
// HTML block start conditions (CommonMark types 1-7). Returns the type or 0.
// A tag name at the end of a line is followed by a newline, which counts as
// whitespace for types 1 and 6.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
function htmlBlockStart(line) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return 0;
  const s = line.slice(idx);
  // type 1: script/pre/style/textarea followed by whitespace or >
  const m1 = /^<(script|pre|style|textarea)/i.exec(s);
  if (m1) {
    const afterName = s[m1[0].length] || '\n';
    if (afterName === ' ' || afterName === '\t' || afterName === '\n' || afterName === '>') return 1;
  }
  // type 2: comment
  if (s.startsWith('<!--')) return 2;
  // type 3: processing instruction
  if (s.startsWith('<?')) return 3;
  // type 4: declaration
  if (/^<![A-Za-z]/.test(s)) return 4;
  // type 5: CDATA
  if (s.startsWith('<![CDATA[')) return 5;
  // type 6: block-level tag followed by space/tab/newline//>
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(s);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    const afterName = s[m6[0].length] || '\n';
    if (afterName === ' ' || afterName === '\t' || afterName === '\n' || afterName === '/' || afterName === '>') return 6;
  }
  // type 7: complete open tag on its own line (not script/pre/style/textarea)
  const m7 = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/.exec(s);
  if (m7) {
    const tagName = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(s)[1].toLowerCase();
    if (!/^(script|pre|style|textarea)$/.test(tagName) && /^[ \t]*$/.test(s.slice(m7[0].length))) return 7;
  }
  // type 7: complete closing tag on its own line
  const m7c = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(s);
  if (m7c && /^[ \t]*$/.test(s.slice(m7c[0].length))) return 7;
  return 0;
}

function blockParse(lines, start, end, top, out, ctx, inBlockquote, isDoc, info) {
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      // a blank line after at least one block separates two blocks at this
      // level (used for list looseness)
      if (info && out.length > 0) info.blankBetween = true;
      i++;
      continue;
    }
    // indented code (cannot interrupt a paragraph: merge into it)
    const [ind0] = lineIndent(line);
    if (ind0 >= 4) {
      const codeLines = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) {
          // blank lines are included only if followed by more indented code;
          // the line keeps its spaces minus the 4-space indent
          let k = j + 1;
          while (k < end && isBlankLine(lines[k])) k++;
          if (k < end && lineIndent(lines[k])[0] >= 4) {
            while (j < k) { codeLines.push(stripIndent(lines[j], 4)); j++; }
            continue;
          }
          break;
        }
        if (lineIndent(l)[0] >= 4) { codeLines.push(stripIndent(l, 4)); j++; }
        else break;
      }
      // trim trailing blank lines
      while (codeLines.length > 0 && isBlankLine(codeLines[codeLines.length - 1])) codeLines.pop();
      const codeText = codeLines.join('\n');
      const lastBlock = out[out.length - 1];
      // indented code merges into a preceding paragraph only when it directly
      // follows it (no blank line in between); a blank line separates them
      if ((lastBlock?.t === 'p' || lastBlock?.t === 'x') && codeLines.length > 0 && i > 0 && !isBlankLine(lines[i - 1])) {
        // indented code merges into the preceding paragraph/text
        lastBlock.s += '\n' + codeText;
        i = j;
        continue;
      }
      out.push({ t: 'c', lang: null, s: codeText + (codeLines.length ? '\n' : '') });
      i = j;
      continue;
    }
    // fenced code
    const fs = fenceStart(line);
    if (fs) {
      const [fch, flen, info] = fs;
      const lang = info.trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
      const body = [];
      let j = i + 1;
      let closed = false;
      while (j < end) {
        const l = lines[j];
        const [ind2, idx2] = lineIndent(l);
        if (ind2 <= 3) {
          let k = idx2;
          while (k < l.length && l.charCodeAt(k) === (fch === '`' ? 96 : 126)) k++;
          if (k - idx2 >= flen) {
            // closing fence: rest of line must be spaces/tabs only
            let m = k;
            while (m < l.length && (l.charCodeAt(m) === 32 || l.charCodeAt(m) === 9)) m++;
            if (m === l.length) { closed = true; j++; break; }
          }
        }
        body.push(l);
        j++;
      }
      void closed;
      // indent compensation (marked's indentCodeCompensation): slice
      // CHARACTERS, not columns — the fence's leading-whitespace string
      // length (in chars) is removed from each content line's leading
      // whitespace (also in chars). NOTE: marked's regex is /^(\s+)(?:```)/
      // so it ONLY applies to backtick fences; a tilde fence gets NO
      // compensation at all (content keeps its indent after container
      // stripping).
      let stripped;
      if (fch === '`') {
        const [, fenceWsLen] = lineIndent(line);
        stripped = body.map((l) => {
          const [, idxL] = lineIndent(l);
          return l.slice(Math.min(idxL, fenceWsLen));
        });
      } else {
        stripped = body;
      }
      let text = stripped.join('\n');
      // a trailing newline is added only when the last content line is not
      // blank (marked's fences regex consumes the newline before the
      // closing fence, so trailing blank lines already end with \n)
      if (stripped.length > 0 && stripped[stripped.length - 1] !== '') text += '\n';
      out.push({ t: 'c', lang, s: text });
      i = j;
      continue;
    }
    // ATX heading
    const ah = atxHeading(line);
    if (ah) {
      out.push({ t: 'h', d: ah[0], s: ah[1] });
      i++;
      continue;
    }
    // hr
    if (isHrLine(line)) { out.push({ t: 'hr' }); i++; continue; }
    // blockquote
    if (blockquoteMarker(line) >= 0) {
      const res = parseBlockquote(lines, i, end, ctx);
      out.push({ t: 'q', c: res.blocks });
      i = res.next;
      continue;
    }
    // list
    const lm = listMarker(line);
    if (lm && !isHrLine(line)) {
      const res = parseList(lines, i, end, ctx);
      if (res) { out.push(res.list); i = res.next; continue; }
    }
    // html block
    const hb = htmlBlockStart(line);
    if (hb) {
      const res = parseHtmlBlock(lines, i, end, hb, isDoc, ctx.endsWithNL);
      out.push({ t: 'html', s: res.text });
      i = res.next;
      continue;
    }
    // link reference definition
    const def = tryDef(lines, i, end);
    if (def) {
      if (!ctx.links[def.tag]) ctx.links[def.tag] = { href: def.href, title: def.title };
      i = def.next;
      continue;
    }
    // table (GFM)
    const tb = tryTable(lines, i, end);
    if (tb) { out.push(tb.table); i = tb.next; continue; }
    // paragraph (with setext heading check)
    const para = parseParagraph(lines, i, end, top, ctx, inBlockquote, isDoc, isDoc && ctx.endsWithNL);
    out.push(para.block);
    i = para.next;
  }
}

// does a line start a list that can interrupt a paragraph?
function listInterrupts(line, inBlockquote, top) {
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return false;
  const c = line.charCodeAt(idx);
  if (c === 45 || c === 42 || c === 43) { // - * +
    let j = idx + 1;
    if (inBlockquote) return j >= line.length || line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9;
    if (j >= line.length || (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9)) return false;
    while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
    return j < line.length;
  }
  if (c >= 48 && c <= 57) {
    let j = idx;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - idx > 9) return false;
    if (j < line.length && (line.charCodeAt(j) === 46 || line.charCodeAt(j) === 41)) {
      if (inBlockquote) {
        const k = j + 1;
        return k >= line.length || line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9;
      }
      // inside a list item (top=false) the text block is a single line, so
      // any ordered list interrupts it; at the top level only "1." / "1)"
      if (top === false) {
        let k = j + 1;
        if (k >= line.length || (line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9)) return false;
        while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
        return k < line.length;
      }
      // top level: only "1." / "1)" interrupts
      if (j - idx !== 1 || line.charCodeAt(idx) !== 49) return false;
      let k = j + 1;
      if (k >= line.length || (line.charCodeAt(k) !== 32 && line.charCodeAt(k) !== 9)) return false;
      while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
      return k < line.length;
    }
  }
  return false;
}
// does a line start an HTML block (types 1-6) that interrupts a paragraph?
function htmlInterrupts(line) {
  const t = htmlBlockStart(line);
  return t >= 1 && t <= 6;
}

// Parse a paragraph starting at line i. Returns {block, next}.
// A paragraph is lines until a blank line or an interrupting block.
// If the next line after the paragraph is a setext underline, it is a heading.
function parseParagraph(lines, i, end, top, ctx, inBlockquote, isDoc, endsNL) {
  const paraLines = [];
  let j = i;
  while (j < end) {
    const line = lines[j];
    if (isBlankLine(line)) {
      // a whitespace-only line is a paragraph continuation only when it is
      // the last line and the source has no trailing newline (marked's
      // paragraph regex lookahead `[ \t]+\n`); otherwise it is a blank line
      if (j === end - 1 && !endsNL && line.length > 0) {
        paraLines.push(line);
        j++;
      }
      break;
    }
    // a setext underline line ends the paragraph (it becomes a heading)
    if (paraLines.length > 0 && isSetextLine(line)) break;
    if (paraLines.length > 0) {
      if (isHrLine(line)) break;
      if (atxHeading(line)) break;
      if (fenceStart(line)) break;
      if (blockquoteMarker(line) >= 0) break;
      if (listInterrupts(line, inBlockquote, top)) break;
      if (htmlInterrupts(line)) break;
      if (tryTable(lines, j, end)) break;
    }
    // inside a container (blockquote/list item) a continuation line with
    // indent >= 4 is an indented-code merge: strip 4 spaces (marked's
    // code tokenizer merges it into the text token); at the true top level
    // the spaces are kept. EXCEPTION: a neutralized lazy setext underline
    // (e.g. `    ===` added by the blockquote lazy path) keeps its 4
    // spaces, otherwise it would become a heading again.
    if (paraLines.length > 0 && !isDoc) {
      const [ind] = lineIndent(line);
      if (ind >= 4) {
        const stripped = stripIndent(line, 4);
        if (isSetextLine(stripped)) { paraLines.push(line); j++; continue; }
        paraLines.push(stripped); j++; continue;
      }
    }
    paraLines.push(line);
    j++;
  }
  // setext heading?
  if (j < end) {
    const st = isSetextLine(lines[j]);
    if (st) {
      const text = paraLines.join('\n').trim();
      return { block: { t: 'h', d: st, s: text }, next: j + 1 };
    }
  }
  const text = paraLines.join('\n');
  return { block: { t: top ? 'p' : 'x', s: text }, next: j };
}

// Link reference definition. Returns {tag, href, title, next} or null.
function tryDef(lines, i, end) {
  const line = lines[i];
  const [indent, idx] = lineIndent(line);
  if (indent > 3) return null;
  if (line.charCodeAt(idx) !== 91) return null; // [
  // label (may span to the next line if the label contains a newline);
  // a def label follows _blockLabel: no unescaped [ or ] inside
  // (window is generous: a title may span several lines)
  const src = lines.slice(i, Math.min(i + 8, end)).join('\n');
  const labelEnd = findRefLabelEnd(src, idx, src.length);
  if (labelEnd < 0) return null;
  const label = src.slice(idx + 1, labelEnd);
  if (/^\s*$/.test(label)) return null;
  let p = labelEnd + 1;
  if (p >= src.length || src.charCodeAt(p) !== 58) return null; // :
  p++;
  // skip spaces, and an optional newline + spaces
  while (p < src.length && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  if (p < src.length && src.charCodeAt(p) === 10) {
    p++;
    while (p < src.length && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  }
  if (p >= src.length) return null;
  // destination
  let href = '';
  if (src.charCodeAt(p) === 60) { // <...>
    let q = p + 1;
    let closed = -1;
    while (q < src.length) {
      const c = src.charCodeAt(q);
      if (c === 92) { q += 2; continue; }
      if (c === 10 || c === 60) break;
      if (c === 62) { closed = q; break; }
      q++;
    }
    if (closed < 0) return null;
    href = src.slice(p + 1, closed);
    p = closed + 1;
  } else {
    let q = p;
    while (q < src.length) {
      const c = src.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10) break;
      q++;
    }
    if (q === p) return null;
    href = src.slice(p, q);
    // unbalanced parens -> not a def
    if (findClosingBracket(href, '()') !== -1) return null;
    p = q;
  }
  // optional title: it must be separated from the destination by whitespace
  let title = null;
  let saveP = p;
  let q = p;
  let skippedWs = false;
  while (q < src.length && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) { q++; skippedWs = true; }
  if (q < src.length && src.charCodeAt(q) === 10) {
    q++;
    skippedWs = true;
    while (q < src.length && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
  }
  if (q < src.length) {
    const qc = src.charCodeAt(q);
    if (qc === 34 || qc === 39 || qc === 40) {
      if (!skippedWs) return null; // no whitespace before the title: junk after destination
      const closer = qc === 40 ? 41 : qc;
      let r = q + 1;
      let closed = -1;
      while (r < src.length) {
        const c = src.charCodeAt(r);
        if (c === 92) { r += 2; continue; }
        if (c === closer) { closed = r; break; }
        // single-quoted title: a newline must not be followed by a blank line
        if (qc === 39 && c === 10) {
          let s2 = r + 1;
          while (s2 < src.length && (src.charCodeAt(s2) === 32 || src.charCodeAt(s2) === 9)) s2++;
          if (s2 >= src.length || src.charCodeAt(s2) === 10) break;
        }
        r++;
      }
      if (closed >= 0) {
        // the title must be followed by only whitespace then end of line
        let t = closed + 1;
        while (t < src.length && (src.charCodeAt(t) === 32 || src.charCodeAt(t) === 9)) t++;
        if (t >= src.length || src.charCodeAt(t) === 10) {
          title = src.slice(q + 1, closed);
          p = closed + 1;
        } else {
          // title followed by junk on the same line: discard the title
          p = saveP;
        }
      } else {
        p = saveP;
      }
    }
  }
  // trailing spaces then end of line(s)
  while (p < src.length && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  if (p < src.length && src.charCodeAt(p) !== 10) return null;
  // count how many lines were consumed
  const consumed = src.slice(0, p).split('\n').length;
  // unescape href and title
  const tag = normalizeLabel(label);
  let hrefOut = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
  let titleOut = null;
  if (title !== null) {
    titleOut = title.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
  }
  // angle-bracketed href: strip the brackets (already done); also strip <> if present
  return { tag, href: hrefOut, title: titleOut, next: i + consumed };
}
// findClosingBracket from marked helpers: -1 no paren, -2 unbalanced open, else index
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

// GFM table. Returns {table, next} or null.
function tryTable(lines, i, end) {
  if (i + 1 >= end) return null;
  const headerLine = lines[i];
  const delimLine = lines[i + 1];
  const [indH] = lineIndent(headerLine);
  if (indH > 3) return null;
  // delimiter row: optional leading pipe, cells of :-+: etc.
  const [indD, idxD] = lineIndent(delimLine);
  if (indD > 3) return null;
  const delim = delimLine.slice(idxD);
  const delimMatch = /^((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/.test(delim.trim());
  if (!delimMatch) return null;
  // the delimiter must contain a | or : (otherwise it is a setext heading)
  if (delim.indexOf('|') < 0 && delim.indexOf(':') < 0) return null;
  const headers = splitCells(headerLine);
  const alignsRaw = delim.replace(/^\||\| *$/g, '').split('|');
  if (headers.length !== alignsRaw.length) return null;
  const aligns = alignsRaw.map((a) => {
    const t = a.trim();
    if (/^ *-+: *$/.test(a) || /^ *-+: *$/.test(t)) return 'right';
    if (/^ *:-+: *$/.test(a) || /^ *:-+: *$/.test(t)) return 'center';
    if (/^ *:-+ *$/.test(a) || /^ *:-+ *$/.test(t)) return 'left';
    return null;
  });
  // rows: lines until a blank line or an interrupting block. NB: marked's
  // table body regex excludes only lines matching ` *\n` (empty or spaces
  // only) — a line holding a tab is a (blank) table row, not the end.
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const line = lines[j];
    if (/^ *$/.test(line)) break;
    if (isHrLine(line)) break;
    if (atxHeading(line)) break;
    if (blockquoteMarker(line) >= 0) break;
    // indented code: 4+ columns of indent AND a non-newline char after it
    // (marked's code lookahead is `(?: {4}| {0,3}\t)[^\n]` — a bare tab or
    // spaces-only line is not code, so it stays a table row)
    { const [indC, idxC] = lineIndent(line); if (indC >= 4 && idxC < line.length) break; }
    if (fenceStart(line)) break;
    if (listMarker(line) && / {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) break;
    if (htmlInterrupts(line)) break;
    rows.push(line);
    j++;
  }
  const rowCells = rows.map((r) => splitCells(r, headers.length));
  return { table: { t: 'tb', h: headers, a: aligns, r: rowCells }, next: j };
}
// split a table row into cells (marked splitCells)
function splitCells(tableRow, count) {
  // ensure every cell-delimiting pipe has a space before it
  let row = '';
  for (let i = 0; i < tableRow.length; i++) {
    if (tableRow[i] === '|') {
      let escaped = false;
      let curr = i;
      while (--curr >= 0 && tableRow[curr] === '\\') escaped = !escaped;
      row += escaped ? '|' : ' |';
    } else row += tableRow[i];
  }
  const cells = row.split(' |');
  let k = 0;
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (k = 0; k < cells.length; k++) cells[k] = cells[k].trim().replace(/\\\|/g, '|');
  return cells;
}

// HTML block. Returns {text, next}. The text ends with '\n' iff the block is
// followed by a non-blank line, or it is a top-level block at the end of a
// source that ends with a newline (marked's trimTrailingBlankLines rule).
function parseHtmlBlock(lines, i, end, type, isDoc, endsWithNL) {
  const out = [];
  let j = i;
  const pushCheck = (endRe) => {
    out.push(lines[j]);
    const done = endRe ? endRe.test(lines[j]) : false;
    j++;
    return done;
  };
  if (type === 1) {
    const tagName = lines[i].match(/<(script|pre|style|textarea)/i)[1].toLowerCase();
    const closeRe = new RegExp('</' + tagName + '>', 'i');
    // the closing tag may be on the first line itself
    let done = pushCheck(closeRe);
    while (!done && j < end) done = pushCheck(closeRe);
  } else if (type === 2) {
    let done = pushCheck(/-->/);
    while (!done && j < end) done = pushCheck(/-->/);
  } else if (type === 3) {
    let done = pushCheck(/\?>/);
    while (!done && j < end) done = pushCheck(/\?>/);
  } else if (type === 4) {
    let done = pushCheck(/>/);
    while (!done && j < end) done = pushCheck(/>/);
  } else if (type === 5) {
    let done = pushCheck(/\]\]>/);
    while (!done && j < end) done = pushCheck(/\]\]>/);
  } else {
    // types 6 and 7: until a blank line
    while (j < end && !isBlankLine(lines[j])) { out.push(lines[j]); j++; }
  }
  // trim trailing blank lines
  while (out.length > 0 && isBlankLine(out[out.length - 1])) out.pop();
  let text = out.join('\n');
  if (out.length > 0) {
    // keep the trailing newline unless the next line is a truly empty
    // line (a whitespace-only line still keeps it — marked's
    // trimTrailingBlankLines only drops it after an empty line)
    if (j < end && lines[j] !== '') text += '\n';
    else if (j >= end && isDoc && endsWithNL) text += '\n';
  }
  return { text, next: j };
}

// Strip a blockquote marker from a line, expanding a tab after the marker.
function stripBlockquoteMarker(line) {
  const [indent, idx] = lineIndent(line);
  let j = idx + 1; // after '>'
  if (j < line.length && line.charCodeAt(j) === 32) {
    // space after '>': marker is '> '; a tab that follows is content and
    // expands to the next tab stop (col indent+2)
    j++;
    if (j < line.length && line.charCodeAt(j) === 9) {
      const w = 4 - ((indent + 2) % 4);
      return ' '.repeat(w) + line.slice(j + 1);
    }
    return line.slice(j);
  }
  if (j < line.length && line.charCodeAt(j) === 9) {
    // tab after '>': it expands to the next tab stop (col indent+1 -> stop);
    // the marker consumes 1 space of that expansion. Any further leading
    // tabs expand from the ORIGINAL column (the tab stop), not from the
    // stripped column — e.g. `>\t\tfoo` leaves 2 + 4 = 6 spaces, so an
    // indented code block keeps 2.
    const col = indent + 1;
    const w = 4 - (col % 4);
    let out = ' '.repeat(Math.max(0, w - 1));
    let c = col + w; // column after the first tab (a tab stop)
    let k = j + 1;
    while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) {
      if (line.charCodeAt(k) === 32) { out += ' '; c++; k++; }
      else { const tw = 4 - (c % 4); out += ' '.repeat(tw); c += tw; k++; }
    }
    return out + line.slice(k);
  }
  return line.slice(j);
}

function parseBlockquote(lines, i, end, ctx) {
  const content = [];
  let j = i;
  let lastWasBlank = false;
  while (j < end) {
    const line = lines[j];
    const marker = blockquoteMarker(line);
    if (marker >= 0) {
      content.push(stripBlockquoteMarker(line));
      lastWasBlank = false;
      j++;
      continue;
    }
    if (isBlankLine(line)) {
      // a blank line without a `>` marker ends the blockquote
      break;
    }
    // lazy continuation line: only when the content so far ends with a
    // paragraph (not a fence, code block, or blank line)
    if (lastWasBlank || content.length === 0) break;
    if (!contentEndsWithParagraph(content)) break;
    if (atxHeading(line) || fenceStart(line) || isHrLine(line) || listMarker(line) || htmlInterrupts(line)) break;
    if (tryTable(lines, j, end)) break;
    // a lazy setext underline must not become a heading: prepend 4 spaces
    if (isSetextLine(line)) content.push('    ' + line);
    else content.push(line);
    j++;
  }
  const blocks = [];
  blockParse(content, 0, content.length, true, blocks, ctx, true, false);
  return { blocks, next: j };
}

// Is the blockquote content inside an unclosed fenced code block?
function contentInFence(content) {
  let fenceChar = null, fenceLen = 0;
  for (const line of content) {
    const f = fenceStart(line);
    if (f) {
      if (!fenceChar) { fenceChar = f[0]; fenceLen = f[1]; }
      else if (f[0] === fenceChar && f[1] >= fenceLen && f[2].trim() === '') {
        fenceChar = null; fenceLen = 0;
      }
    }
  }
  return fenceChar !== null;
}

// Does the blockquote content (so far) end with a paragraph that a lazy
// continuation line can continue? False after a fence, an indented code
// block, a blank line, or another block start.
function contentEndsWithParagraph(content) {
  if (content.length === 0) return false;
  // a trailing blank line ends the paragraph
  const line = content[content.length - 1];
  if (isBlankLine(line)) return false;
  // inside an unclosed fenced code block: no lazy continuation
  if (contentInFence(content)) return false;
  const idx = content.length - 1;
  // strip nested blockquote / list markers to reach the innermost content
  // (a list item can end with a paragraph via a nested blockquote, e.g.
  // `1. > Blockquote` — a lazy line may continue that paragraph)
  let inner = content[idx];
  for (;;) {
    const m = blockquoteMarker(inner);
    if (m >= 0) { inner = inner.slice(m); continue; }
    const lm = listMarker(inner);
    if (lm) {
      let k = lm[4];
      while (k < inner.length && (inner.charCodeAt(k) === 32 || inner.charCodeAt(k) === 9)) k++;
      inner = inner.slice(k);
      continue;
    }
    break;
  }
  if (fenceStart(inner)) return false;
  if (atxHeading(inner)) return false;
  if (isHrLine(inner)) return false;
  if (listMarker(inner)) return false;
  if (htmlInterrupts(inner)) return false;
  const [ind] = lineIndent(inner);
  if (ind >= 4) {
    // indented code: a paragraph continuation only if the previous line is
    // a paragraph line (code-merge); standalone code otherwise
    if (idx === 0) return false;
    const prev = content[idx - 1];
    if (isBlankLine(prev)) return false;
    const [pind] = lineIndent(prev);
    if (pind >= 4) return false;
    if (fenceStart(prev) || atxHeading(prev) || isHrLine(prev) || listMarker(prev) || htmlInterrupts(prev)) return false;
    return true;
  }
  return true;
}

// Expand leading tabs of a line (for indentation measurement inside lists)
function expandLeadingTabs(line) {
  let col = 0;
  let i = 0;
  let out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out + line.slice(i);
}

function parseList(lines, i, end, ctx) {
  const first = listMarker(lines[i]);
  if (!first) return null;
  const isOrdered = first[2];
  const startNum = first[3];
  const bullet = first[0];
  const items = [];
  let j = i;
  let loose = false;
  let endsWithBlankLine = false;
  while (j < end) {
    const line = lines[j];
    const m = listMarker(line);
    if (!m) break;
    if (m[2] !== isOrdered) break;
    if (isOrdered) {
      if (m[0].slice(-1) !== bullet.slice(-1)) break;
    } else if (m[0] !== bullet) break;
    if (isHrLine(line)) break;
    // --- parse one item ---
    const bulletIndent = m[1] + (m[4] - m[1] - 0); // marker length incl. leading spaces
    // recompute: cap[1] is the marker group " {0,3}bullet" — its length
    const markerGroupLen = (lineIndent(line)[1]) + m[1];
    const bulletLen = markerGroupLen;
    let firstLine = line.slice(m[4]);
    // expand leading tabs of firstLine relative to bulletLen
    firstLine = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, bulletLen));
    let blankLine = !firstLine.trim();
    let indent;
    let itemContent;
    if (blankLine) {
      indent = bulletLen + 1;
      itemContent = '';
    } else {
      let ind = firstLine.search(/[^ ]/);
      if (ind < 0) ind = firstLine.length;
      if (ind > 4) ind = 1;
      itemContent = firstLine.slice(ind);
      indent = ind + bulletLen;
    }
    let endEarly = false;
    let k = j + 1;
    if (blankLine && k < end && isBlankLine(lines[k])) {
      k++;
      endEarly = true;
    }
    const contentLines = blankLine ? [] : [itemContent];
    let lineForCheck = itemContent;
    if (!endEarly) {
      while (k < end) {
        const rawLine = lines[k];
        const nextLine = expandLeadingTabs(rawLine);
        // block starts that end the item: the construct must start within
        // `indent - 1` leading spaces (marked's cachedIndentRegex, capped at 3)
        const allowed = Math.max(0, Math.min(3, indent - 1));
        const [rawInd] = lineIndent(nextLine);
        const startsBlock = (fn) => rawInd <= allowed && fn(rawLine);
        if (startsBlock((l) => !!fenceStart(l))) break;
        if (startsBlock((l) => !!atxHeading(l))) break;
        if (startsBlock((l) => htmlInterrupts(l))) break;
        if (startsBlock((l) => blockquoteMarker(l) >= 0)) break;
        if (startsBlock((l) => !!listMarker(l))) break;
        if (startsBlock((l) => isHrLine(l))) break;
        const [nc] = lineIndent(nextLine);
        if (!rawLine.trim()) {
          // blank line: peek at the next non-blank line. If it does not
          // continue the item, the item ends BEFORE the blank line(s), so
          // the outer level sees them as a separator (this is what makes
          // a following block a separate top-level block, e.g. cm-325).
          let m = k + 1;
          while (m < end && isBlankLine(lines[m])) m++;
          if (m >= end) {
            contentLines.push('');
            blankLine = true;
            lineForCheck = '';
            k++;
            continue;
          }
          const nextNonBlank = expandLeadingTabs(lines[m]);
          const [nInd] = lineIndent(nextNonBlank);
          // the next line continues the item only if it is indented to the
          // item's content level; a lazy continuation is impossible after a
          // blank line, and a block start ends the item
          const continues = nInd >= indent;
          if (!continues) break;
          contentLines.push('');
          blankLine = true;
          lineForCheck = '';
          k++;
          continue;
        }
        if (nc >= indent) {
          contentLines.push(stripIndent(nextLine, indent));
        } else {
          // not enough indentation: lazy continuation or end
          if (blankLine) break;
          const prevExpanded = lineForCheck.replace(/\t/g, '    ');
          if (prevExpanded.search(/[^ ]/) >= 4) break; // indented code
          if (fenceStart(lineForCheck)) break;
          if (atxHeading(lineForCheck)) break;
          if (htmlInterrupts(lineForCheck)) break;
          if (isHrLine(lineForCheck)) break;
          // lazy continuation; a setext underline is neutralized with 4 spaces
          const st = isSetextLine(rawLine);
          if (st) contentLines.push('    ' + nextLine.replace(/^ {0,3}/, ''));
          else contentLines.push(nextLine);
        }
        blankLine = !rawLine.trim();
        lineForCheck = contentLines.length > 0 ? contentLines[contentLines.length - 1] : '';
        k++;
      }
    }
    // did the item end with a blank line (before trimming)? marked's
    // endsWithBlankLine: the next item then makes the list loose.
    // An empty item followed by a blank line also ends with a blank line.
    const endedWithBlank = endEarly || (contentLines.length > 0 && isBlankLine(contentLines[contentLines.length - 1]));
    // trim trailing blank lines from the item content
    while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') contentLines.pop();
    items.push({ contentLines, endedWithBlank });
    j = k;
    // after the item, a blank line before the next item makes the list loose
    // — but ONLY when the next item continues THIS list (same type and
    // marker); a blank line followed by a different list does not loosen
    // this one (its last item's trailing blank is trimmed, marked rule).
    if (j < end && isBlankLine(lines[j])) {
      let m2 = j + 1;
      while (m2 < end && isBlankLine(lines[m2])) m2++;
      const nm = m2 < end ? listMarker(lines[m2]) : null;
      if (nm && nm[2] === isOrdered && (isOrdered ? nm[0].slice(-1) === bullet.slice(-1) : nm[0] === bullet) && !isHrLine(lines[m2])) {
        loose = true;
        j = m2;
        continue;
      }
      break;
    }
  }
  if (items.length === 0) return null;
  // a blank line at the end of any item except the last makes the list loose
  for (let ii = 0; ii < items.length - 1; ii++) {
    if (items[ii].endedWithBlank) { loose = true; break; }
  }
  // build the list block
  const listItems = [];
  for (const it of items) {
    const subBlocks = [];
    const info = {};
    blockParse(it.contentLines, 0, it.contentLines.length, false, subBlocks, ctx, false, false, info);
    // a blank line between two top-level blocks inside the item (a `space`
    // token with a blank line) makes the list loose
    if (info.blankBetween) loose = true;
    // task checkbox: only when the first block is text/paragraph
    let task = false;
    let checked = false;
    const firstText = it.contentLines.length > 0 ? it.contentLines[0] : '';
    if (/^\[[ xX]\][ \t]+\S/.test(firstText) && subBlocks.length > 0 && (subBlocks[0].t === 'x' || subBlocks[0].t === 'p')) {
      task = true;
      checked = firstText[1] !== ' ';
      // remove the checkbox from the first line and re-parse
      it.contentLines[0] = firstText.replace(/^\[[ xX]\][ \t]+/, '');
      subBlocks.length = 0;
      blockParse(it.contentLines, 0, it.contentLines.length, false, subBlocks, ctx, false, false, info);
    }
    listItems.push({ task, checked, c: subBlocks });
  }
  if (loose) {
    for (const it of listItems) {
      for (const b of it.c) if (b.t === 'x') b.t = 'p';
    }
  }
  return { list: { t: 'l', o: isOrdered, st: startNum, items: listItems, loose }, next: j };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderBlock(b, ctx) {
  switch (b.t) {
    case 'p': return '<p>' + inlineToHtml(b.s, ctx.links, ctx.st) + '</p>\n';
    case 'x': return inlineToHtml(b.s, ctx.links, ctx.st);
    case 'h': return '<h' + b.d + '>' + inlineToHtml(b.s, ctx.links, ctx.st) + '</h' + b.d + '>\n';
    case 'c': {
      const lang = b.lang;
      const langString = lang ? (lang.match(/^\S*/) || [''])[0] : '';
      let code = b.s ? b.s.replace(/\n$/, '') + '\n' : '';
      if (!langString) return '<pre><code>' + escEncode(code) + '</code></pre>\n';
      return '<pre><code class="language-' + escText(langString) + '">' + escEncode(code) + '</code></pre>\n';
    }
    case 'hr': return '<hr>\n';
    case 'html': return b.s;
    case 'q': {
      let body = '';
      for (const cb of b.c) body += renderBlock(cb, ctx);
      return '<blockquote>\n' + body + '</blockquote>\n';
    }
    case 'l': {
      let body = '';
      for (const item of b.items) {
        let inner = '';
        if (item.task) {
          const cb = '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
          if (item.c.length > 0 && item.c[0].t === 'p') {
            // loose: checkbox goes inside the first <p>
            let first = renderBlock(item.c[0], ctx);
            first = first.replace('<p>', '<p>' + cb);
            inner = first;
            for (let k = 1; k < item.c.length; k++) inner += renderBlock(item.c[k], ctx);
          } else if (item.c.length > 0 && item.c[0].t === 'x') {
            inner = cb + renderBlock(item.c[0], ctx);
            for (let k = 1; k < item.c.length; k++) inner += renderBlock(item.c[k], ctx);
          } else {
            // first block is not text/paragraph: checkbox becomes its own paragraph
            inner = '<p>' + cb + '</p>\n';
            for (const cb2 of item.c) inner += renderBlock(cb2, ctx);
          }
        } else {
          for (const cb of item.c) inner += renderBlock(cb, ctx);
        }
        body += '<li>' + inner + '</li>\n';
      }
      const type = b.o ? 'ol' : 'ul';
      const startAttr = (b.o && b.st !== 1) ? ' start="' + b.st + '"' : '';
      return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
    }
    case 'tb': {
      let header = '';
      for (let i = 0; i < b.h.length; i++) {
        const align = b.a[i];
        const tag = align ? '<th align="' + align + '">' : '<th>';
        header += tag + inlineToHtml(b.h[i], ctx.links, ctx.st) + '</th>\n';
      }
      header = '<tr>\n' + header + '</tr>\n';
      let body = '';
      for (const row of b.r) {
        let cell = '';
        for (let i = 0; i < row.length; i++) {
          const align = b.a[i];
          const tag = align ? '<td align="' + align + '">' : '<td>';
          cell += tag + inlineToHtml(row[i], ctx.links, ctx.st) + '</td>\n';
        }
        body += '<tr>\n' + cell + '</tr>\n';
      }
      if (body) body = '<tbody>' + body + '</tbody>';
      return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
    }
  }
  return '';
}
