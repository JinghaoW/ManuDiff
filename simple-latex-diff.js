#!/usr/bin/env node
/** Compare visible text in two complete LaTeX documents, in Node or a browser. */

const BEGIN = '\\begin{document}';
const END = '\\end{document}';
const WORD = /^(?:\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{N}]+)/u;
const COMMAND = /^\\(?:[A-Za-z@]+\*?|[\s\S])/;
const ENVIRONMENT_BOUNDARY = /^\\(?:begin|end)\{[^{}]+\}/;
const MATH_ENVIRONMENTS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
  'multline', 'multline*', 'flalign', 'flalign*', 'alignat', 'alignat*',
  'displaymath', 'math', 'eqnarray', 'eqnarray*',
]);
const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'BVerbatim',
]);
const COMMENT_ENVIRONMENTS = new Set(['comment']);
const TEXT_ENVIRONMENTS = new Set([
  'document', 'abstract', 'quote', 'quotation', 'itemize', 'enumerate',
  'description', 'center', 'flushleft', 'flushright',
]);
const ATOMIC_ENVIRONMENTS = new Set([
  ...MATH_ENVIRONMENTS, ...VERBATIM_ENVIRONMENTS, 'figure', 'figure*',
  'table', 'table*', 'tabular', 'tabular*', 'tabularx', 'longtable',
  'algorithm', 'algorithm*', 'algorithmic', 'algorithm2e', 'tikzpicture',
  'thebibliography', 'filecontents', 'filecontents*', ...COMMENT_ENVIRONMENTS,
]);
const OPAQUE_COMMANDS = /^(?:[A-Za-z]*cite[A-Za-z]*|ref|eqref|autoref|cref|Cref|pageref|label|input|include|includegraphics|bibliography|bibliographystyle|url|path|href|footnote|thanks)$/;
const STRUCTURAL_COMMANDS = /^(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|caption|multicolumn|multirow)$/;
const TEXT_ARGUMENT_COMMANDS = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph',
  'subparagraph', 'caption', 'textbf', 'textit', 'textsl', 'textsc', 'emph',
  'underline', 'textrm', 'textsf', 'texttt',
]);
const SAFE_PUNCTUATION = new Set([...`.,!?;:'"-()/[]`]);
const MAX_EXACT_EDITS = 1000;
const LARGE_CHANGE_CHARS = 1500;
const LARGE_CHANGE_LINES = 20;
const LARGE_CHANGE_WORDS = 200;
const WORD_DIFF_MAX_WORDS = 150;
const PREAMBLE = `% Added by simple-latex-diff.js
\\makeatletter
\\@ifpackageloaded{xcolor}{}{\\RequirePackage{xcolor}}
\\@ifpackageloaded{ulem}{}{\\RequirePackage[normalem]{ulem}}
\\@ifpackageloaded{cancel}{}{\\RequirePackage{cancel}}
\\makeatother
\\providecommand{\\texorpdfstring}[2]{#1}
\\providecommand{\\SimpleDiffAddText}[1]{{\\protect\\color{blue}\\uwave{#1}}}
\\providecommand{\\SimpleDiffReplaceText}[1]{{\\protect\\color{blue}#1}}
\\providecommand{\\SimpleDiffDelText}[1]{{\\protect\\color{red}\\sout{#1}}}
\\providecommand{\\SimpleDiffAdd}[1]{\\texorpdfstring{\\SimpleDiffAddText{#1}}{#1}}
\\providecommand{\\SimpleDiffReplace}[1]{\\texorpdfstring{\\SimpleDiffReplaceText{#1}}{#1}}
\\providecommand{\\SimpleDiffDel}[1]{\\texorpdfstring{\\SimpleDiffDelText{#1}}{}}
\\providecommand{\\SimpleDiffAddFL}[1]{\\SimpleDiffAdd{#1}}
\\providecommand{\\SimpleDiffReplaceFL}[1]{\\SimpleDiffReplace{#1}}
\\providecommand{\\SimpleDiffDelFL}[1]{\\SimpleDiffDel{#1}}
\\providecommand{\\SimpleDiffStructuralChange}{\\textcolor{blue}{\\rule{0.8em}{0.8pt}}}
\\providecommand{\\SimpleDiffStructuralDel}{\\textcolor{red}{\\rule{0.8em}{0.8pt}}}
\\providecommand{\\SimpleDiffGraphicNew}[1]{{\\color{blue}\\footnotesize [Revised figure]\\par}#1}
\\providecommand{\\SimpleDiffGraphicAdd}[1]{{\\color{blue}\\footnotesize [Add figure]\\par}#1}
\\providecommand{\\SimpleDiffGraphicDel}{{\\color{red}\\footnotesize\\sout{[Deleted figure]}\\par}}
\\providecommand{\\SimpleDiffTableNew}{{\\color{blue}\\footnotesize [Revised table]\\par}}
\\providecommand{\\SimpleDiffTableAdd}{{\\color{blue}\\footnotesize [Add table]\\par}}
\\providecommand{\\SimpleDiffTableDel}{{\\color{red}\\footnotesize\\sout{[Deleted table]}\\par}}
\\makeatletter
\\@ifundefined{SimpleDiffAddBlock}{\\newenvironment{SimpleDiffAddBlock}{\\begingroup\\color{blue}}{\\endgroup}}{}
\\@ifundefined{SimpleDiffDelBlock}{\\newenvironment{SimpleDiffDelBlock}{\\begingroup\\color{red}}{\\endgroup}}{}
\\makeatother
`;

function isEscaped(source, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function isInComment(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  for (let i = lineStart; i < index; i++) {
    if (source[i] === '%' && !isEscaped(source, i)) return true;
  }
  return false;
}

function skipSpace(source, start) {
  let i = start;
  while (i < source.length && /\s/u.test(source[i])) i++;
  return i;
}

function readBalancedGroup(source, start, open = '{', close = '}') {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '%' && !isEscaped(source, i)) {
      const newline = source.indexOf('\n', i + 1);
      if (newline < 0) return null;
      i = newline;
      continue;
    }
    if (source[i] === open && !isEscaped(source, i)) depth++;
    else if (source[i] === close && !isEscaped(source, i)) {
      depth--;
      if (depth === 0) return { text: source.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function readCommand(source, start) {
  if (source[start] !== '\\') return null;
  const match = source.slice(start).match(COMMAND);
  if (!match) return null;
  let end = start + match[0].length;
  const nameMatch = match[0].match(/^\\([A-Za-z@]+)\*?$/);
  const name = nameMatch?.[1] || match[0].slice(1);
  const groups = [];
  let cursor = end;
  for (let count = 0; count < 4; count++) {
    cursor = skipSpace(source, cursor);
    const opener = source[cursor];
    if (opener !== '[' && opener !== '{') break;
    const group = readBalancedGroup(source, cursor, opener, opener === '[' ? ']' : '}');
    if (!group) break;
    groups.push(group);
    cursor = group.end;
  }
  if (groups.length) end = groups[groups.length - 1].end;
  return { name, text: source.slice(start, end), end };
}

function commandParts(raw) {
  const head = raw.match(/^\\([A-Za-z@]+)(\*)?/);
  if (!head) return null;
  const groups = [];
  let cursor = head[0].length;
  for (let count = 0; count < 4; count++) {
    cursor = skipSpace(raw, cursor);
    const opener = raw[cursor];
    if (opener !== '[' && opener !== '{') break;
    const group = readBalancedGroup(raw, cursor, opener, opener === '[' ? ']' : '}');
    if (!group) break;
    groups.push({ ...group, start: cursor, opener, inner: group.text.slice(1, -1) });
    cursor = group.end;
  }
  return { name: head[1], starred: Boolean(head[2]), groups, end: cursor };
}

function renderTextCommandChange(oldRaw, newRaw, minWords, report, floatContext = false) {
  const before = commandParts(oldRaw);
  const after = commandParts(newRaw);
  if (!before || !after || before.name !== after.name || before.starred !== after.starred ||
      !TEXT_ARGUMENT_COMMANDS.has(before.name)) return null;
  const oldGroup = [...before.groups].reverse().find(group => group.opener === '{');
  const newGroup = [...after.groups].reverse().find(group => group.opener === '{');
  if (!oldGroup || !newGroup || oldRaw.slice(0, oldGroup.start) !== newRaw.slice(0, newGroup.start) ||
      oldRaw.slice(oldGroup.end) !== newRaw.slice(newGroup.end)) return null;
  let inner = diffBody(oldGroup.inner, newGroup.inner, minWords, report, false);
  if (floatContext || before.name === 'caption') {
    inner = inner.replace(/\\SimpleDiff(Add|Replace|Del)\{/g, '\\SimpleDiff$1FL{');
  }
  return newRaw.slice(0, newGroup.start + 1) + inner + newRaw.slice(newGroup.end - 1);
}

function readInlineVerbatim(source, start) {
  const head = source.slice(start).match(/^\\(?:verb\*?|lstinline\*?)/);
  if (!head) return null;
  let cursor = start + head[0].length;
  if (/^\\lstinline/.test(head[0]) && source[cursor] === '[') {
    const options = readBalancedGroup(source, cursor, '[', ']');
    if (!options) return null;
    cursor = options.end;
  }
  const delimiter = source[cursor];
  if (!delimiter || /\s/u.test(delimiter)) return null;
  const end = source.indexOf(delimiter, cursor + 1);
  return { text: source.slice(start, end < 0 ? source.length : end + 1), end: end < 0 ? source.length : end + 1 };
}

function readEnvironment(source, start) {
  const opening = source.slice(start).match(/^\\begin\{([^{}]+)\}/);
  if (!opening) return null;
  const environment = opening[1];
  if (VERBATIM_ENVIRONMENTS.has(environment)) {
    const closing = `\\end{${environment}}`;
    const end = source.indexOf(closing, start + opening[0].length);
    return { environment, text: source.slice(start, end < 0 ? source.length : end + closing.length), end: end < 0 ? source.length : end + closing.length };
  }
  const stack = [environment];
  let cursor = start + opening[0].length;
  while (cursor < source.length) {
    if (source[cursor] === '%' && !isEscaped(source, cursor)) {
      const newline = source.indexOf('\n', cursor + 1);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    const inlineVerbatim = source[cursor] === '\\' ? readInlineVerbatim(source, cursor) : null;
    if (inlineVerbatim) {
      cursor = inlineVerbatim.end;
      continue;
    }
    const boundary = source.slice(cursor).match(/^\\(begin|end)\{([^{}]+)\}/);
    if (!boundary) {
      cursor++;
      continue;
    }
    const [, type, nested] = boundary;
    if (type === 'begin' && VERBATIM_ENVIRONMENTS.has(nested)) {
      const closing = `\\end{${nested}}`;
      const end = source.indexOf(closing, cursor + boundary[0].length);
      cursor = end < 0 ? source.length : end + closing.length;
      continue;
    }
    if (type === 'begin') stack.push(nested);
    else if (stack[stack.length - 1] === nested) stack.pop();
    else {
      const found = stack.lastIndexOf(nested);
      if (found >= 0) stack.length = found;
    }
    cursor += boundary[0].length;
    if (!stack.length) {
      return { environment, text: source.slice(start, cursor), end: cursor };
    }
  }
  return { environment, text: source.slice(start), end: source.length, unclosed: true };
}

function readDelimitedMath(source, start, opening, closing) {
  let cursor = start + opening.length;
  while (cursor < source.length) {
    const end = source.indexOf(closing, cursor);
    if (end < 0) return { text: source.slice(start), end: source.length };
    if (!isEscaped(source, end)) return { text: source.slice(start, end + closing.length), end: end + closing.length };
    cursor = end + closing.length;
  }
  return { text: source.slice(start), end: source.length };
}

function splitDocument(source) {
  const occurrences = (literal, from = 0) => {
    const found = [];
    for (let index = source.indexOf(literal, from); index >= 0;
      index = source.indexOf(literal, index + literal.length)) {
      if (!isInComment(source, index)) found.push(index);
    }
    return found;
  };
  const starts = occurrences(BEGIN);
  const start = starts[0] ?? -1;
  const ends = occurrences(END, start < 0 ? 0 : start + BEGIN.length);
  const end = ends.length ? ends[ends.length - 1] : -1;
  if (start < 0 || end < start) {
    throw new Error('Expected both \\begin{document} and \\end{document}.');
  }
  const bodyStart = start + BEGIN.length;
  return [source.slice(0, start), source.slice(bodyStart, end), source.slice(end)];
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    let text;
    let kind;
    if (rest[0] === '%') {
      const end = source.indexOf('\n', i);
      text = source.slice(i, end < 0 ? source.length : end);
      kind = 'comment';
    } else if (rest.startsWith('\\verb') || rest.startsWith('\\lstinline')) {
      const parsed = readInlineVerbatim(source, i);
      text = parsed?.text || rest[0];
      kind = 'protected';
    } else if (rest.startsWith('\\begin{')) {
      const parsed = readEnvironment(source, i);
      if (parsed && (ATOMIC_ENVIRONMENTS.has(parsed.environment) ||
          !TEXT_ENVIRONMENTS.has(parsed.environment))) {
        text = parsed.text;
        kind = MATH_ENVIRONMENTS.has(parsed.environment) ? 'math' :
          COMMENT_ENVIRONMENTS.has(parsed.environment) ? 'comment' : 'protected';
      } else {
        const boundary = rest.match(ENVIRONMENT_BOUNDARY);
        text = boundary?.[0] || '\\';
        kind = 'protected';
      }
    } else if (rest.startsWith('\\(') || rest.startsWith('\\[')) {
      const opening = rest.startsWith('\\(') ? '\\(' : '\\[';
      const closing = opening === '\\(' ? '\\)' : '\\]';
      const parsed = readDelimitedMath(source, i, opening, closing);
      text = parsed.text;
      kind = 'math';
    } else if (rest[0] === '\\') {
      const parsed = readCommand(source, i);
      text = parsed?.text || rest[0];
      if (/^\\[%&#_$\{\}]$/.test(text)) kind = 'punct';
      else if (/^\\includegraphics/.test(text)) kind = 'graphic';
      else if (/^\\(?:[A-Za-z]*cite[A-Za-z]*|ref|eqref|autoref|cref|Cref|pageref)/.test(text)) kind = 'citation';
      else kind = 'protected';
    } else if (rest[0] === '$') {
      const marker = rest.startsWith('$$') ? '$$' : '$';
      const parsed = readDelimitedMath(source, i, marker, marker);
      text = parsed.text;
      kind = 'math';
    } else if (/^\s/u.test(rest)) {
      text = rest.match(/^\s+/u)[0];
      kind = 'space';
    } else if (WORD.test(rest)) {
      text = rest.match(WORD)[0];
      kind = 'word';
    } else {
      text = rest[0];
      kind = SAFE_PUNCTUATION.has(text) ? 'punct' : 'protected';
    }
    tokens.push({ text, kind, key: kind === 'space' ? (/\n\s*\n/u.test(text) ? '\n\n' : ' ') : text });
    i += Math.max(1, text.length);
  }
  return tokens;
}

function opcodes(oldTokens, newTokens) {
  const a = oldTokens.map(t => t.key);
  const b = newTokens.map(t => t.key);
  // Myers diff stores only the edit frontier, so long papers with few changes stay cheap.
  const trace = [];
  const frontier = new Map([[1, 0]]);
  let distance = 0;
  let found = false;
  const maxDistance = Math.min(a.length + b.length, MAX_EXACT_EDITS);
  for (; distance <= maxDistance && !found; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || (diagonal !== distance &&
        (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x >= a.length && y >= b.length) { found = true; break; }
    }
  }
  if (!found) {
    // A very broad rewrite would make an exact Myers trace grow quadratically.
    // Preserve the shared edges and treat the remaining region as one change so
    // documents around 10,000 characters still complete with bounded memory.
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let oldSuffix = a.length, newSuffix = b.length;
    while (oldSuffix > prefix && newSuffix > prefix &&
        a[oldSuffix - 1] === b[newSuffix - 1]) {
      oldSuffix--;
      newSuffix--;
    }
    const broadChange = [];
    if (prefix) broadChange.push([0, prefix, 0, prefix, true]);
    if (prefix < oldSuffix || prefix < newSuffix) {
      broadChange.push([prefix, oldSuffix, prefix, newSuffix, false, true]);
    }
    if (oldSuffix < a.length || newSuffix < b.length) {
      broadChange.push([oldSuffix, a.length, newSuffix, b.length, true]);
    }
    return broadChange;
  }
  const pairs = [];
  let x = a.length, y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const previous = trace[d];
    const diagonal = x - y;
    const down = diagonal === -d || (diagonal !== d &&
      (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1));
    const priorDiagonal = down ? diagonal + 1 : diagonal - 1;
    const priorX = previous.get(priorDiagonal) ?? 0;
    const priorY = priorX - priorDiagonal;
    while (x > priorX && y > priorY) { pairs.push([--x, --y]); }
    x = priorX; y = priorY;
  }
  pairs.reverse();
  const changes = [];
  let oldStart = 0, newStart = 0;
  for (const [i, j] of pairs) {
    if (oldStart < i || newStart < j) changes.push([oldStart, i, newStart, j]);
    changes.push([i, i + 1, j, j + 1, true]);
    oldStart = i + 1; newStart = j + 1;
  }
  if (oldStart < a.length || newStart < b.length) changes.push([oldStart, a.length, newStart, b.length]);
  // Spaces between replaced words belong to one edit, not separate one-word edits.
  for (let n = 1; n < changes.length - 1;) {
    const middle = changes[n];
    if (changes[n - 1][4] !== true && middle[4] === true && changes[n + 1][4] !== true &&
        oldTokens.slice(middle[0], middle[1]).every(t => t.kind === 'space')) {
      changes.splice(n - 1, 3, [changes[n - 1][0], changes[n + 1][1],
        changes[n - 1][2], changes[n + 1][3]]);
      n = Math.max(1, n - 1);
    } else n++;
  }
  return changes;
}

function canMark(tokens) {
  return tokens.every(t => ['word', 'space', 'punct'].includes(t.kind) &&
    (t.kind !== 'space' || !/\n\s*\n/u.test(t.text)));
}

function mark(tokens, command) {
  const raw = tokens.map(t => t.text).join('');
  const leading = raw.match(/^\s*/u)[0];
  const trailing = raw.match(/\s*$/u)[0];
  const core = raw.slice(leading.length, raw.length - trailing.length);
  return core ? `${leading}\\${command}{${core}}${trailing}` : raw;
}

function mathParts(raw) {
  const environment = raw.match(/^\\begin\{([^}]+)\}([\s\S]*)\\end\{\1\}$/);
  if (environment) return { display: true, environment: environment[1], inner: environment[2] };
  if (raw.startsWith('$$')) return { display: true, inner: raw.slice(2, -2) };
  if (raw.startsWith('\\[')) return { display: true, inner: raw.slice(2, -2) };
  if (raw.startsWith('\\(')) return { display: false, inner: raw.slice(2, -2) };
  return { display: false, inner: raw.slice(1, -1) };
}

function stripNumberingCommands(raw) {
  return raw
    .replace(/\\label\s*\{[^{}]*\}/g, '')
    .replace(/\\tag\*?\s*\{[^{}]*\}/g, '');
}

function isComplexMath(environment, inner) {
  return /\\\\/.test(inner) ||
    /\\begin\{(?:aligned|alignedat|split|array|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|cases|smallmatrix)\}/.test(inner) ||
    /^(?:align|align\*|alignat|alignat\*|flalign|flalign\*|gather|gather\*|multline|multline\*|eqnarray|eqnarray\*)$/.test(environment || '');
}

function renderMath(token, role) {
  const { display, environment, inner } = mathParts(token.text);
  if (!display) {
    const content = role === 'deleted' ? `\\textcolor{red}{\\cancel{${inner}}}` :
      role === 'added' ? `\\textcolor{blue}{\\underline{${inner}}}` :
        `\\textcolor{blue}{${inner}}`;
    if (token.text.startsWith('\\(')) return `\\(${content}\\)`;
    return `$${content}$`;
  }
  if (role !== 'deleted') return `\\begingroup\\color{blue}${token.text}\\endgroup`;
  // Removed displays must not define duplicate labels or consume equation numbers.
  const oldContent = stripNumberingCommands(inner);
  if (isComplexMath(environment, oldContent)) {
    return `\\[\\textcolor{red}{\\cancel{\\begin{aligned}${oldContent}\\end{aligned}}}\\]`;
  }
  return `\\[\\textcolor{red}{\\cancel{${oldContent}}}\\]`;
}

function renderSpecialChange(before, after) {
  const oldItems = before.filter(t => t.kind !== 'space');
  const newItems = after.filter(t => t.kind !== 'space');
  if (oldItems.length > 1 || newItems.length > 1) return null;
  const oldItem = oldItems[0], newItem = newItems[0];
  const type = oldItem?.kind || newItem?.kind;
  if (!['math', 'citation', 'graphic', 'comment'].includes(type) ||
      (oldItem && oldItem.kind !== type) || (newItem && newItem.kind !== type)) return null;
  let rendered = '';
  if (type === 'comment') {
    // Source comments do not affect the rendered paper and must never be put
    // inside a macro argument: '%' would comment out the closing brace.
    rendered = newItem?.text || '';
  } else if (type === 'math') {
    if (oldItem) rendered += renderMath(oldItem, 'deleted');
    if (oldItem && newItem) rendered += mathParts(oldItem.text).display ? '\n' : ' ';
    if (newItem) rendered += renderMath(newItem, oldItem ? 'replaced' : 'added');
  } else if (type === 'citation') {
    if (oldItem) rendered += `\\SimpleDiffDel{\\mbox{${oldItem.text}}}`;
    if (oldItem && newItem) rendered += ' ';
    if (newItem) rendered += `\\${oldItem ? 'SimpleDiffReplace' : 'SimpleDiffAdd'}{\\mbox{${newItem.text}}}`;
  } else {
    if (oldItem && !newItem) rendered += '\\SimpleDiffGraphicDel{}';
    if (newItem) {
      const command = oldItem ? 'SimpleDiffGraphicNew' : 'SimpleDiffGraphicAdd';
      rendered += `\\${command}{${newItem.text}}`;
    }
  }
  const spacing = after.length ? after : before;
  const first = spacing.findIndex(t => t.kind !== 'space');
  if (first < 0) return rendered + spacing.map(t => t.text).join('');
  return spacing.slice(0, first).map(t => t.text).join('') + rendered +
    spacing.slice(first + 1).map(t => t.text).join('');
}

function isTableEnvironmentSource(raw) {
  return /^\s*\\begin\{(?:table\*?|tabular\*?|tabularx|longtable)\}/u.test(raw);
}

function findCommand(raw, name) {
  let cursor = 0;
  while (cursor < raw.length) {
    const index = raw.indexOf(`\\${name}`, cursor);
    if (index < 0) return null;
    if (!isInComment(raw, index)) {
      const parsed = readCommand(raw, index);
      if (parsed?.name === name) return { start: index, end: parsed.end, text: parsed.text };
    }
    cursor = index + name.length + 1;
  }
  return null;
}

function renderAtomicEnvironmentChange(oldRaw, newRaw, minWords, report) {
  const before = oldRaw.match(/^\\begin\{([^{}]+)\}([\s\S]*)\\end\{\1\}$/);
  const after = newRaw.match(/^\\begin\{([^{}]+)\}([\s\S]*)\\end\{\1\}$/);
  if (!before || !after || before[1] !== after[1] ||
      !ATOMIC_ENVIRONMENTS.has(before[1]) || MATH_ENVIRONMENTS.has(before[1]) ||
      VERBATIM_ENVIRONMENTS.has(before[1]) || COMMENT_ENVIRONMENTS.has(before[1])) return null;
  const oldCaption = findCommand(before[2], 'caption');
  const newCaption = findCommand(after[2], 'caption');
  const oldGraphic = findCommand(before[2], 'includegraphics');
  const newGraphic = findCommand(after[2], 'includegraphics');
  if (Boolean(oldCaption) === Boolean(newCaption) && Boolean(oldGraphic) === Boolean(newGraphic)) {
    const oldRanges = [oldCaption, oldGraphic].filter(Boolean).sort((a, b) => b.start - a.start);
    const newRanges = [newCaption, newGraphic].filter(Boolean).sort((a, b) => b.start - a.start);
    const without = (raw, ranges) => ranges.reduce(
      (value, range) => value.slice(0, range.start) + value.slice(range.end), raw);
    if (without(before[2], oldRanges) === without(after[2], newRanges)) {
      const replacements = [];
      if (newCaption) {
        const caption = renderTextCommandChange(
          oldCaption.text, newCaption.text, minWords, report, true);
        replacements.push({ ...newCaption, text: caption ?? newCaption.text });
      }
      if (newGraphic) {
        replacements.push({ ...newGraphic, text: oldGraphic.text === newGraphic.text ?
          newGraphic.text : `\\SimpleDiffGraphicNew{${newGraphic.text}}` });
      }
      let inner = after[2];
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        inner = inner.slice(0, replacement.start) + replacement.text + inner.slice(replacement.end);
      }
      const notice = isTableEnvironmentSource(newRaw) ? '\\SimpleDiffTableNew{}\n' : '';
      return `${notice}\\begin{${after[1]}}${inner}\\end{${after[1]}}`;
    }
  }

  // Keep placement/column arguments outside revision macros: wrapping [t] or
  // {ll} would make otherwise valid float and table syntax uncompilable.
  const splitPrefix = raw => {
    let cursor = skipSpace(raw, 0);
    while (raw[cursor] === '[' || raw[cursor] === '{') {
      const opener = raw[cursor];
      const group = readBalancedGroup(raw, cursor, opener, opener === '[' ? ']' : '}');
      if (!group) break;
      cursor = skipSpace(raw, group.end);
    }
    return { prefix: raw.slice(0, cursor), body: raw.slice(cursor) };
  };
  const oldInner = splitPrefix(before[2]);
  const newInner = splitPrefix(after[2]);
  const isTable = isTableEnvironmentSource(newRaw);
  const structuralMarker = oldInner.prefix === newInner.prefix || isTable ? '' : '\\SimpleDiffStructuralChange{}';
  if (structuralMarker && report) report.unmarkedChanges++;
  const body = diffBody(oldInner.body, newInner.body, minWords, report);
  const notice = isTable ? '\\SimpleDiffTableNew{}\n' : '';
  if (isTable && oldInner.prefix !== newInner.prefix && report) report.unmarkedChanges++;
  return `${notice}\\begin{${after[1]}}${newInner.prefix}${structuralMarker}${body}\\end{${after[1]}}`;
}

function renderStructuredChange(before, after, minWords, report) {
  const isHard = token => !['word', 'space', 'punct'].includes(token.kind);
  const oldHard = before.map((token, index) => ({ token, index })).filter(item => isHard(item.token));
  const newHard = after.map((token, index) => ({ token, index })).filter(item => isHard(item.token));
  if (!oldHard.length || oldHard.length !== newHard.length ||
      oldHard.some((item, index) => item.token.kind !== newHard[index].token.kind)) return null;
  let oldStart = 0, newStart = 0, result = '';
  for (let i = 0; i < oldHard.length; i++) {
    const oldItem = oldHard[i], newItem = newHard[i];
    result += diffBody(before.slice(oldStart, oldItem.index).map(t => t.text).join(''),
      after.slice(newStart, newItem.index).map(t => t.text).join(''), minWords, report);
    const special = oldItem.token.text === newItem.token.text ? null :
      renderSpecialChange([oldItem.token], [newItem.token]);
    const commandChange = oldItem.token.kind === 'protected' && oldItem.token.text !== newItem.token.text ?
      renderTextCommandChange(oldItem.token.text, newItem.token.text, minWords, report) : null;
    const environmentChange = commandChange === null && oldItem.token.kind === 'protected' &&
      oldItem.token.text !== newItem.token.text ? renderAtomicEnvironmentChange(
        oldItem.token.text, newItem.token.text, minWords, report) : null;
    const annotated = special ?? commandChange ?? environmentChange;
    if (oldItem.token.kind === 'protected' && oldItem.token.text !== newItem.token.text && annotated === null) {
      if (report) report.unmarkedChanges++;
      result += '\\SimpleDiffStructuralChange{}';
    }
    result += oldItem.token.text === newItem.token.text ? newItem.token.text :
      (annotated ?? newItem.token.text);
    oldStart = oldItem.index + 1;
    newStart = newItem.index + 1;
  }
  return result + diffBody(before.slice(oldStart).map(t => t.text).join(''),
    after.slice(newStart).map(t => t.text).join(''), minWords, report);
}

function anchoredLineOperations(oldLines, newLines) {
  const positions = lines => {
    const map = new Map();
    lines.forEach((line, index) => {
      if (line.anchorable === false) return;
      const entry = map.get(line.key);
      if (entry) entry.count++;
      else map.set(line.key, { count: 1, index });
    });
    return map;
  };
  const oldPositions = positions(oldLines);
  const newPositions = positions(newLines);
  const pairs = [];
  oldPositions.forEach((oldEntry, key) => {
    const newEntry = newPositions.get(key);
    if (oldEntry.count === 1 && newEntry?.count === 1) {
      pairs.push([oldEntry.index, newEntry.index]);
    }
  });
  pairs.sort((left, right) => left[0] - right[0]);
  if (!pairs.length) return null;

  const tails = [];
  const previous = new Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pairs[tails[middle]][1] < pairs[i][1]) low = middle + 1;
      else high = middle;
    }
    if (low) previous[i] = tails[low - 1];
    tails[low] = i;
  }
  const anchors = [];
  for (let index = tails[tails.length - 1]; index >= 0; index = previous[index]) {
    anchors.push(pairs[index]);
  }
  anchors.reverse();

  const operations = [];
  let oldStart = 0, newStart = 0;
  for (const [oldIndex, newIndex] of anchors) {
    if (oldStart < oldIndex || newStart < newIndex) {
      operations.push([oldStart, oldIndex, newStart, newIndex]);
    }
    operations.push([oldIndex, oldIndex + 1, newIndex, newIndex + 1, true]);
    oldStart = oldIndex + 1;
    newStart = newIndex + 1;
  }
  if (oldStart < oldLines.length || newStart < newLines.length) {
    operations.push([oldStart, oldLines.length, newStart, newLines.length]);
  }
  return operations;
}

function changeSize(raw) {
  return {
    chars: raw.length,
    lines: (raw.match(/\n/g) || []).length + 1,
    words: (raw.match(/[\p{L}\p{N}]+/gu) || []).length,
  };
}

function isLargeChange(before, after) {
  const size = changeSize(before.length >= after.length ? before : after);
  return size.chars >= LARGE_CHANGE_CHARS || size.lines >= LARGE_CHANGE_LINES ||
    size.words >= LARGE_CHANGE_WORDS;
}

function renderLargeAddition(raw) {
  if (!raw) return '';
  if (/^\s*$/u.test(raw)) return raw;
  const tokens = tokenize(raw);
  let result = '';
  let markable = [];
  const flush = () => {
    if (!markable.length) return;
    result += mark(markable, 'SimpleDiffAdd');
    markable = [];
  };
  for (const token of tokens) {
    if (['word', 'punct'].includes(token.kind) ||
        (token.kind === 'space' && !/\n\s*\n/u.test(token.text))) {
      markable.push(token);
      continue;
    }
    flush();
    if (token.kind === 'math') result += renderMath(token, 'added');
    else if (token.kind === 'citation') result += `\\SimpleDiffAdd{\\mbox{${token.text}}}`;
    else if (token.kind === 'graphic') result += `\\SimpleDiffGraphicAdd{${token.text}}`;
    else if (token.kind === 'protected' && isTableEnvironmentSource(token.text)) {
      result += `\\SimpleDiffTableAdd{}\n${token.text}`;
    }
    else result += token.text;
  }
  flush();
  return `\\begin{SimpleDiffAddBlock}\n${result}\n\\end{SimpleDiffAddBlock}`;
}

function neutralizeDeletedCaptions(raw) {
  let result = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const index = raw.indexOf('\\caption', cursor);
    if (index < 0) return result + raw.slice(cursor);
    result += raw.slice(cursor, index);
    const head = raw.slice(index).match(/^\\caption\*?/);
    if (!head || /[A-Za-z@]/.test(raw[index + head[0].length] || '')) {
      result += raw[index];
      cursor = index + 1;
      continue;
    }
    let argumentStart = skipSpace(raw, index + head[0].length);
    if (raw[argumentStart] === '[') {
      const optional = readBalancedGroup(raw, argumentStart, '[', ']');
      if (!optional) {
        result += raw[index];
        cursor = index + 1;
        continue;
      }
      argumentStart = skipSpace(raw, optional.end);
    }
    const caption = readBalancedGroup(raw, argumentStart);
    if (!caption) {
      result += raw[index];
      cursor = index + 1;
      continue;
    }
    result += `\\par\\noindent{\\footnotesize ${caption.text.slice(1, -1)}}\\par`;
    cursor = caption.end;
  }
  return result;
}

function makeDeletedStructureSafe(raw) {
  const withoutNumberedHeadings = stripNumberingCommands(raw).replace(
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(?![A-Za-z@*])/g,
    '\\$1*');
  return neutralizeDeletedCaptions(withoutNumberedHeadings).replace(
    /\\(begin|end)\{(equation|align|alignat|flalign|gather|multline|eqnarray)\}/g,
    '\\$1{$2*}');
}

function renderLargeDeletion(raw) {
  if (!raw) return '';
  if (/^\s*$/u.test(raw)) return '';
  const paragraphs = raw.split(/(\n\s*\n)/);
  const proseOnly = paragraphs.every(part => /^\s*$/.test(part) ||
    (!/[\\$]/.test(part) && !/\n\s*\\(?:begin|end)\b/.test(part)));
  if (proseOnly) {
    return paragraphs.map(part => /^\s*$/.test(part) ? part :
      mark([{ text: part, kind: 'word' }], 'SimpleDiffDel')).join('');
  }
  const safe = makeDeletedStructureSafe(raw);
  const tableNotice = isTableEnvironmentSource(safe) ? '\\SimpleDiffTableDel{}\n' : '';
  const tokens = tokenize(safe);
  let rendered = '';
  let markable = [];
  const flush = () => {
    if (!markable.length) return;
    rendered += mark(markable, 'SimpleDiffDel');
    markable = [];
  };
  for (const token of tokens) {
    if (['word', 'punct'].includes(token.kind) ||
        (token.kind === 'space' && !/\n\s*\n/u.test(token.text))) {
      markable.push(token);
      continue;
    }
    flush();
    if (token.kind === 'math') rendered += renderMath(token, 'deleted');
    else if (token.kind === 'citation') rendered += `\\SimpleDiffDel{\\mbox{${token.text}}}`;
    else if (token.kind === 'graphic') rendered += '\\SimpleDiffGraphicDel{}';
    else rendered += token.text;
  }
  flush();
  return `\\begin{SimpleDiffDelBlock}\n${tableNotice}${rendered}\n\\end{SimpleDiffDelBlock}`;
}

function segmentDocument(source) {
  const blocks = [];
  const push = (text, kind = 'text') => {
    if (text) blocks.push({ text, kind, key: `${kind}\0${text}` });
  };
  let start = 0;
  let i = 0;
  while (i < source.length) {
    if (source[i] === '%' && !isEscaped(source, i)) {
      push(source.slice(start, i));
      const end = source.indexOf('\n', i + 1);
      i = end < 0 ? source.length : end + 1;
      // A TeX comment consumes its terminating newline, so skipping the whole
      // suffix preserves rendered spacing as well as avoiding false edits.
      start = i;
      continue;
    }
    const inlineVerbatim = source[i] === '\\' ? readInlineVerbatim(source, i) : null;
    if (inlineVerbatim) {
      i = inlineVerbatim.end;
      continue;
    }
    if (source.startsWith('\\begin{', i)) {
      const parsed = readEnvironment(source, i);
      if (parsed && (ATOMIC_ENVIRONMENTS.has(parsed.environment) ||
          !TEXT_ENVIRONMENTS.has(parsed.environment))) {
        push(source.slice(start, i));
        if (COMMENT_ENVIRONMENTS.has(parsed.environment)) {
          // Source-only comments do not affect the rendered document. Omitting
          // them prevents invisible edits from creating empty red/blue blocks.
          i = parsed.end;
          start = i;
          continue;
        }
        push(parsed.text, MATH_ENVIRONMENTS.has(parsed.environment) ? 'math' :
          'structure');
        i = parsed.end;
        start = i;
        continue;
      }
      const boundary = source.slice(i).match(/^\\begin\{([^{}]+)\}/);
      if (boundary && TEXT_ENVIRONMENTS.has(boundary[1])) {
        push(source.slice(start, i));
        let boundaryEnd = i + boundary[0].length;
        const optionStart = skipSpace(source, boundaryEnd);
        if (source[optionStart] === '[') {
          const option = readBalancedGroup(source, optionStart, '[', ']');
          if (option) boundaryEnd = option.end;
        }
        push(source.slice(i, boundaryEnd), 'boundary');
        i = boundaryEnd;
        start = i;
        continue;
      }
    }
    if (source.startsWith('\\end{', i)) {
      const boundary = source.slice(i).match(/^\\end\{([^{}]+)\}/);
      if (boundary && TEXT_ENVIRONMENTS.has(boundary[1])) {
        push(source.slice(start, i));
        push(boundary[0], 'boundary');
        i += boundary[0].length;
        start = i;
        continue;
      }
    }
    if (source.startsWith('\\[', i) || source.startsWith('$$', i)) {
      const opening = source.startsWith('\\[', i) ? '\\[' : '$$';
      const closing = opening === '\\[' ? '\\]' : '$$';
      const parsed = readDelimitedMath(source, i, opening, closing);
      push(source.slice(start, i));
      push(parsed.text, 'math');
      i = parsed.end;
      start = i;
      continue;
    }
    if (source[i] === '\\') {
      const parsed = readCommand(source, i);
      if (parsed?.name === 'label') {
        push(source.slice(start, i));
        push(parsed.text, 'label');
        i = parsed.end;
        start = i;
        continue;
      }
      if (parsed && STRUCTURAL_COMMANDS.test(parsed.name) &&
          /^(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)$/.test(parsed.name)) {
        push(source.slice(start, i));
        push(parsed.text, 'heading');
        i = parsed.end;
        start = i;
        continue;
      }
    }
    if (source[i] === '\n') {
      const separator = source.slice(i).match(/^\n[ \t\r]*\n+/)?.[0];
      if (separator) {
        push(source.slice(start, i + separator.length));
        i += separator.length;
        start = i;
        continue;
      }
    }
    i++;
  }
  push(source.slice(start));
  return blocks;
}

function blockSimilarity(left, right) {
  if (left.kind !== right.kind) return 0;
  if (left.kind === 'boundary') return left.text === right.text ? 1 : 0;
  const words = raw => new Set((raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length > 1));
  const a = words(left.text);
  const b = words(right.text);
  if (!a.size && !b.size) return left.text === right.text ? 1 : 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return (2 * common) / Math.max(1, a.size + b.size);
}

function alignChangedBlocks(before, after) {
  if (!before.length || !after.length || before.length * after.length > 10000) return null;
  const rows = before.length + 1;
  const columns = after.length + 1;
  const scores = Array.from({ length: rows }, () => new Float64Array(columns));
  const moves = Array.from({ length: rows }, () => new Uint8Array(columns));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < columns; j++) {
      const similarity = blockSimilarity(before[i - 1], after[j - 1]);
      const match = similarity >= 0.2 ? scores[i - 1][j - 1] + similarity : -1;
      const dropOld = scores[i - 1][j];
      const addNew = scores[i][j - 1];
      if (match >= dropOld && match >= addNew) {
        scores[i][j] = match;
        moves[i][j] = 1;
      } else if (dropOld >= addNew) {
        scores[i][j] = dropOld;
        moves[i][j] = 2;
      } else {
        scores[i][j] = addNew;
        moves[i][j] = 3;
      }
    }
  }
  const pairs = [];
  let i = before.length;
  let j = after.length;
  while (i || j) {
    const move = moves[i]?.[j] || (i ? 2 : 3);
    if (move === 1) {
      pairs.push([i - 1, j - 1]);
      i--; j--;
    } else if (move === 2) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();
  return pairs.length ? pairs : null;
}

function renderChangedBlocks(before, after, minWords, report) {
  const pairs = alignChangedBlocks(before, after);
  if (!pairs) {
    return renderLargeDeletion(before.map(block => block.text).join('')) +
      renderLargeAddition(after.map(block => block.text).join(''));
  }
  let result = '';
  const renderDeletion = blocks => {
    const raw = blocks.map(block => block.text).join('');
    if (!raw || /^\s*$/u.test(raw)) return '';
    return isLargeChange(raw, '') ? renderLargeDeletion(raw) :
      diffBody(raw, '', minWords, report);
  };
  const renderAddition = blocks => {
    const raw = blocks.map(block => block.text).join('');
    if (!raw || /^\s*$/u.test(raw)) return raw;
    return isLargeChange('', raw) ? renderLargeAddition(raw) :
      diffBody('', raw, minWords, report);
  };
  let oldStart = 0;
  let newStart = 0;
  for (const [oldIndex, newIndex] of pairs) {
    result += renderDeletion(before.slice(oldStart, oldIndex));
    result += renderAddition(after.slice(newStart, newIndex));
    const oldBlock = before[oldIndex].text;
    const newBlock = after[newIndex].text;
    result += markInsertedHeadings(
      diffBody(oldBlock, newBlock, minWords, report), oldBlock, newBlock);
    oldStart = oldIndex + 1;
    newStart = newIndex + 1;
  }
  result += renderDeletion(before.slice(oldStart));
  result += renderAddition(after.slice(newStart));
  return result;
}

function diffDocumentBody(oldBody, newBody, minWords, report) {
  const oldBlocks = segmentDocument(oldBody);
  const newBlocks = segmentDocument(newBody);
  const operations = opcodes(oldBlocks, newBlocks);
  let result = '';
  for (const [i1, i2, j1, j2, equal] of operations) {
    const beforeBlocks = oldBlocks.slice(i1, i2);
    const afterBlocks = newBlocks.slice(j1, j2);
    const before = beforeBlocks.map(block => block.text).join('');
    const after = afterBlocks.map(block => block.text).join('');
    const invisible = blocks => blocks.every(block =>
      block.kind === 'comment' || /^\s*$/u.test(block.text));
    if (equal) result += after;
    else if (invisible(beforeBlocks) && invisible(afterBlocks)) result += after;
    else if (!before) result += isLargeChange('', after) ? renderLargeAddition(after) :
      diffBody('', after, minWords, report);
    else if (!after) result += isLargeChange(before, '') ? renderLargeDeletion(before) :
      diffBody(before, '', minWords, report);
    else if (beforeBlocks.length > 1 || afterBlocks.length > 1) {
      result += renderChangedBlocks(beforeBlocks, afterBlocks, minWords, report);
    } else if (isLargeChange(before, after)) {
      result += renderLargeDeletion(before) + renderLargeAddition(after);
    } else {
      result += markInsertedHeadings(diffBody(before, after, minWords, report), before, after);
    }
  }
  return result;
}

function diffByLines(oldBody, newBody, minWords, report) {
  const asLines = source => {
    const environments = [];
    return (source.match(/[^\n]*\n|[^\n]+$/g) || []).map(text => {
      const boundaries = [...text.matchAll(/\\(begin|end)\{([^}]+)\}/g)];
      const anchorable = !environments.length && !boundaries.length;
      for (const [, type, environment] of boundaries) {
        if (type === 'begin') environments.push(environment);
        else {
          const index = environments.lastIndexOf(environment);
          if (index >= 0) environments.splice(index, 1);
        }
      }
      return { text, key: anchorable ? text : {}, anchorable };
    });
  };
  const oldLines = asLines(oldBody);
  const newLines = asLines(newBody);
  let operations = opcodes(oldLines, newLines);
  if (operations.some(operation => operation[5])) {
    operations = anchoredLineOperations(oldLines, newLines) || operations;
  }
  let result = '';
  for (const [i1, i2, j1, j2, equal] of operations) {
    const before = oldLines.slice(i1, i2).map(line => line.text);
    const after = newLines.slice(j1, j2).map(line => line.text);
    if (equal) {
      result += after.join('');
    } else if (!before.length) {
      const raw = after.join('');
      result += isLargeChange('', raw) ? renderLargeAddition(raw) :
        `\\begingroup\\color{blue}${after.map(line => diffBody('', line, minWords, report, false)).join('')}\\endgroup`;
    } else if (!after.length) {
      const raw = before.join('');
      result += isLargeChange(raw, '') ? renderLargeDeletion(raw) :
        before.map(line => diffBody(line, '', minWords, report, false)).join('');
    } else {
      const oldChunk = before.join('');
      const newChunk = after.join('');
      result += markInsertedHeadings(
        diffBody(oldChunk, newChunk, minWords, report, false), oldChunk, newChunk);
    }
  }
  return result;
}

function renderHeadingChange(oldBody, newBody, minWords = 1, report) {
  const parse = raw => {
    const leading = raw.match(/^\s*/u)?.[0] || '';
    const command = readCommand(raw, leading.length);
    if (!command || !/^(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)$/.test(command.name)) return null;
    return { leading, command, trailing: raw.slice(command.end) };
  };
  const before = oldBody ? parse(oldBody) : null;
  const after = parse(newBody);
  if (!after || (before && before.command.name !== after.command.name)) return null;
  if (!before) {
    const parts = commandParts(after.command.text);
    const title = [...parts.groups].reverse().find(group => group.opener === '{');
    if (!title) return null;
    return after.leading + after.command.text.slice(0, title.start + 1) +
      `\\SimpleDiffAdd{${title.inner}}` + after.command.text.slice(title.end - 1) + after.trailing;
  }
  if (before.command.text === after.command.text) return null;
  const changed = renderTextCommandChange(
    before.command.text, after.command.text, minWords, report);
  return changed === null ? null : after.leading + changed + after.trailing;
}

function markInsertedHeadings(rendered, oldBody, newBody) {
  const heading = /\\(?:section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]\n]*\])?\{[^{}\n]*\}/g;
  for (const command of newBody.match(heading) || []) {
    if (oldBody.includes(command) || !rendered.includes(command)) continue;
    const opening = command.indexOf('{');
    rendered = rendered.replace(command,
      `${command.slice(0, opening + 1)}\\SimpleDiffAdd{${command.slice(opening + 1, -1)}}}`);
  }
  return rendered;
}

function renderUnmarkableChange(before, after) {
  const oldRaw = before.map(token => token.text).join('');
  const newRaw = after.map(token => token.text).join('');
  if (!oldRaw) return renderLargeAddition(newRaw);
  const oldItems = before.filter(token => token.kind !== 'space');
  const newItems = after.filter(token => token.kind !== 'space');
  let deleted;
  if (oldItems.length === 1 && oldItems[0].kind === 'math') {
    deleted = renderMath(oldItems[0], 'deleted');
  } else {
    deleted = renderLargeDeletion(oldRaw);
  }
  if (!newRaw) return deleted;
  let added;
  if (newItems.length === 1 && newItems[0].kind === 'math') {
    added = renderMath(newItems[0], 'replaced');
  } else if (canMark(after)) {
    added = mark(after, 'SimpleDiffReplace');
  } else {
    added = `\\SimpleDiffStructuralChange{}${newRaw}`;
  }
  return deleted + added;
}

function isSinglePunctuationChange(before, after) {
  const visible = tokens => tokens.filter(token => token.kind !== 'space');
  const oldVisible = visible(before);
  const newVisible = visible(after);
  if (!oldVisible.length && !newVisible.length) return false;
  return oldVisible.length <= 1 && newVisible.length <= 1 &&
    oldVisible.every(token => token.kind === 'punct') &&
    newVisible.every(token => token.kind === 'punct');
}

function diffBody(oldBody, newBody, minWords = 1, report, allowLineFallback = true) {
  if (!Number.isInteger(minWords) || minWords < 1) throw new Error('minWords must be a positive integer.');
  const heading = renderHeadingChange(oldBody, newBody, minWords, report);
  if (heading !== null) return heading;
  const oldTokens = tokenize(oldBody);
  const newTokens = tokenize(newBody);
  const operations = opcodes(oldTokens, newTokens);
  if (allowLineFallback && operations.some(operation => operation[5])) {
    return diffByLines(oldBody, newBody, minWords, report);
  }
  let result = '';
  for (const [i1, i2, j1, j2, equal] of operations) {
    const before = oldTokens.slice(i1, i2);
    const after = newTokens.slice(j1, j2);
    const special = equal ? null : renderSpecialChange(before, after);
    const structured = equal || special !== null ? null : renderStructuredChange(before, after, minWords, report);
    const changedWords = Math.max(before.filter(t => t.kind === 'word').length,
      after.filter(t => t.kind === 'word').length);
    const oldRaw = before.map(t => t.text).join('');
    const newRaw = after.map(t => t.text).join('');
    if (!equal && isSinglePunctuationChange(before, after)) {
      result += after.map(token => token.text).join('');
    } else if (special !== null) {
      result += special;
    } else if (structured !== null) {
      result += structured;
    } else if (!equal && (changedWords >= WORD_DIFF_MAX_WORDS || isLargeChange(oldRaw, newRaw))) {
      result += renderLargeDeletion(oldRaw) + renderLargeAddition(newRaw);
    } else if (equal || (Math.max(1, changedWords) < minWords && canMark(before) && canMark(after))) {
      result += after.map(t => t.text).join('');
    } else if (!canMark(before) || !canMark(after)) {
      if (report) report.unmarkedChanges++;
      result += renderUnmarkableChange(before, after);
    } else {
      result += mark(before, 'SimpleDiffDel') +
        mark(after, before.some(t => t.kind !== 'space') ? 'SimpleDiffReplace' : 'SimpleDiffAdd');
    }
  }
  return result;
}

function makeDiffWithReport(oldSource, newSource, minWords = 1) {
  const [, oldBody] = splitDocument(oldSource);
  const [preamble, newBody, ending] = splitDocument(newSource);
  const report = { unmarkedChanges: 0 };
  const injected = preamble.includes('% Added by simple-latex-diff.js') ? '' : PREAMBLE;
  const tex = preamble + (preamble.endsWith('\n') ? '' : '\n') + injected + BEGIN +
    diffDocumentBody(oldBody, newBody, minWords, report) + ending;
  return { tex, unmarkedChanges: report.unmarkedChanges };
}

function makeDiff(oldSource, newSource, minWords = 1) {
  return makeDiffWithReport(oldSource, newSource, minWords).tex;
}

function main(args) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node simple-latex-diff.js OLD.tex NEW.tex [-o OUTPUT.tex] [--min-words 1..10]');
    return 0;
  }
  let output, minWords = 1;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') {
      output = args[++i];
      if (!output) throw new Error('Missing output path after -o/--output.');
    }
    else if (args[i] === '--min-words') minWords = Number(args[++i]);
    else if (args[i].startsWith('-')) throw new Error(`Unknown option: ${args[i]}`);
    else positional.push(args[i]);
  }
  if (positional.length !== 2 || !Number.isInteger(minWords) || minWords < 1 || minWords > 10) {
    throw new Error('Expected OLD.tex NEW.tex and --min-words from 1 to 10. Use --help for usage.');
  }
  const [oldFile, newFile] = positional;
  output ||= path.join(path.dirname(newFile), `${path.parse(newFile).name}_diff.tex`);
  if ([oldFile, newFile].some(file => path.resolve(file) === path.resolve(output))) {
    throw new Error('Output must be different from both input files.');
  }
  const result = makeDiffWithReport(fs.readFileSync(oldFile, 'utf8'),
    fs.readFileSync(newFile, 'utf8'), minWords);
  fs.writeFileSync(output, result.tex, 'utf8');
  console.log(path.resolve(output));
  if (result.unmarkedChanges) console.warn(`${result.unmarkedChanges} complex structural changes use generic visible markers; review the output.`);
  return 0;
}

if (typeof module !== 'undefined' && require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (typeof module !== 'undefined') module.exports = {
  tokenize, segmentDocument, diffBody, makeDiff, makeDiffWithReport,
  readBalancedGroup, readEnvironment,
};
if (typeof window !== 'undefined') window.SimpleLatexDiff = { makeDiff, makeDiffWithReport };
