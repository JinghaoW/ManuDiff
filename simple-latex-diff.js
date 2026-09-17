#!/usr/bin/env node
/** Compare visible text in two complete LaTeX documents, in Node or a browser. */

const BEGIN = '\\begin{document}';
const END = '\\end{document}';
const WORD = /^[\p{L}\p{N}]+/u;
const COMMAND = /^\\(?:[A-Za-z@]+\*?|[\s\S])/;
const CITATION = /^\\(?:[A-Za-z]*cite[A-Za-z]*|ref|eqref|autoref|cref|pageref)\*?(?:\[[^\]\n]*\]){0,2}\{[^{}]*\}/i;
const GRAPHIC = /^\\includegraphics\*?(?:\[[^\]\n]*\])?\{[^{}]*\}/;
const STRUCTURAL_PREFIX = /^(?:\\begin\{(?:figure|table|algorithm|enumerate|itemize)\*?\}(?:\[[^\]\n]*\])?|\\begin\{(?:tabular|longtable)\}\{[^{}]*\}|\\begin\{(?:tabular\*|tabularx)\}\{[^{}]*\}\{[^{}]*\}|\\(?:multicolumn|multirow)\{[^{}]*\}\{[^{}]*\}|\\(?:caption|section|subsection|subsubsection)\[[^\]\n]*\])/;
const OPAQUE_ARGUMENT = /^\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref|label|input|include|includegraphics|bibliography|url|path)(?:\[[^\]\n]*\])?\{[^{}]*\}/;
const PROTECTED_ENVIRONMENTS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
  'multline', 'multline*', 'verbatim', 'verbatim*', 'lstlisting',
  'minted', 'tikzpicture',
]);
const SAFE_PUNCTUATION = new Set([...`.,!?;:'"-()/[]`]);
const PREAMBLE = `% Added by simple-latex-diff.js
\\usepackage{xcolor}
\\usepackage[normalem]{ulem}
\\usepackage{cancel}
\\DeclareRobustCommand{\\SimpleDiffAdd}[1]{\\textcolor{blue}{\\uline{#1}}}
\\DeclareRobustCommand{\\SimpleDiffReplace}[1]{\\textcolor{blue}{#1}}
\\DeclareRobustCommand{\\SimpleDiffDel}[1]{\\textcolor{red}{\\sout{#1}}}
\\newcommand{\\SimpleDiffGraphicOld}[1]{{\\color{red}\\footnotesize [Previous image: \\texttt{\\detokenize{#1}}]\\par}}
\\newcommand{\\SimpleDiffGraphicNew}[1]{{\\color{blue}\\footnotesize [New or revised image]\\par}#1}
`;

function splitDocument(source) {
  const start = source.indexOf(BEGIN);
  const end = source.lastIndexOf(END);
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
      kind = 'protected';
    } else if (rest[0] === '\\') {
      const command = rest.match(COMMAND)[0];
      const citation = rest.match(CITATION);
      const graphic = rest.match(GRAPHIC);
      const structural = rest.match(STRUCTURAL_PREFIX);
      const opaque = rest.match(OPAQUE_ARGUMENT);
      const env = command === '\\begin' && rest.match(/^\\begin\{([^}]+)\}/)?.[1];
      if (citation) {
        text = citation[0];
        kind = 'citation';
      } else if (graphic) {
        text = graphic[0];
        kind = 'graphic';
      } else if (structural) {
        text = structural[0];
      } else if (opaque) {
        text = opaque[0];
      } else if (PROTECTED_ENVIRONMENTS.has(env)) {
        const closing = `\\end{${env}}`;
        const end = source.indexOf(closing, i + command.length + env.length + 2);
        text = source.slice(i, end < 0 ? source.length : end + closing.length);
        if (env !== 'tikzpicture' && !env.startsWith('verbatim') && env !== 'lstlisting' && env !== 'minted') kind = 'math';
      } else if (command === '\\(' || command === '\\[') {
        const closing = command === '\\(' ? '\\)' : '\\]';
        const end = source.indexOf(closing, i + command.length);
        text = source.slice(i, end < 0 ? source.length : end + closing.length);
        kind = 'math';
      } else {
        text = command;
      }
      kind ||= 'protected';
    } else if (rest[0] === '$') {
      const marker = rest.startsWith('$$') ? '$$' : '$';
      const end = source.indexOf(marker, i + marker.length);
      text = source.slice(i, end < 0 ? source.length : end + marker.length);
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
    i += text.length;
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
  const maxDistance = Math.min(a.length + b.length, 1000);
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
    throw new Error('More than 1000 token edits; split the document or use latexdiff for a large rewrite.');
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

function renderMath(token, role) {
  const { display, environment, inner } = mathParts(token.text);
  if (!display) {
    const content = role === 'deleted' ? `\\textcolor{red}{\\cancel{${inner}}}` :
      role === 'added' ? `\\textcolor{blue}{\\underline{${inner}}}` :
        `\\textcolor{blue}{${inner}}`;
    return `$${content}$`;
  }
  if (role !== 'deleted') return `\\begingroup\\color{blue}${token.text}\\endgroup`;
  // The removed display must not consume an equation number or define a duplicate label.
  const oldContent = inner.replace(/\\label\{[^{}]*\}/g, '').replace(/\\tag\*?\{[^{}]*\}/g, '');
  const oldEnvironment = environment && /^(?:align|gather|multline)(?:\*)?$/.test(environment)
    ? environment.replace(/\*?$/, '*') : null;
  const oldDisplay = oldEnvironment
    ? `\\begin{${oldEnvironment}}${oldContent}\\end{${oldEnvironment}}`
    : `\\[${oldContent}\\]`;
  return `\\begingroup\\color{red}${oldDisplay}\\endgroup`;
}

function renderSpecialChange(before, after) {
  const oldItems = before.filter(t => t.kind !== 'space');
  const newItems = after.filter(t => t.kind !== 'space');
  if (oldItems.length > 1 || newItems.length > 1) return null;
  const oldItem = oldItems[0], newItem = newItems[0];
  const type = oldItem?.kind || newItem?.kind;
  if (!['math', 'citation', 'graphic'].includes(type) ||
      (oldItem && oldItem.kind !== type) || (newItem && newItem.kind !== type)) return null;
  let rendered = '';
  if (type === 'math') {
    if (oldItem) rendered += renderMath(oldItem, 'deleted');
    if (oldItem && newItem) rendered += mathParts(oldItem.text).display ? '\n' : ' ';
    if (newItem) rendered += renderMath(newItem, oldItem ? 'replaced' : 'added');
  } else if (type === 'citation') {
    if (oldItem) rendered += `\\SimpleDiffDel{\\mbox{${oldItem.text}}}`;
    if (oldItem && newItem) rendered += ' ';
    if (newItem) rendered += `\\${oldItem ? 'SimpleDiffReplace' : 'SimpleDiffAdd'}{\\mbox{${newItem.text}}}`;
  } else {
    const oldPath = oldItem?.text.match(/\{([^{}]*)\}$/)?.[1];
    if (oldItem) rendered += `\\SimpleDiffGraphicOld{${oldPath}}`;
    if (newItem) rendered += `\\SimpleDiffGraphicNew{${newItem.text}}`;
  }
  const spacing = after.length ? after : before;
  const first = spacing.findIndex(t => t.kind !== 'space');
  if (first < 0) return rendered + spacing.map(t => t.text).join('');
  return spacing.slice(0, first).map(t => t.text).join('') + rendered +
    spacing.slice(first + 1).map(t => t.text).join('');
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
    if (oldItem.token.kind === 'protected' && oldItem.token.text !== newItem.token.text &&
        !oldItem.token.text.startsWith('%') && !oldItem.token.text.startsWith('\\label')) {
      if (report) report.unmarkedChanges++;
    }
    result += oldItem.token.text === newItem.token.text ? newItem.token.text :
      (renderSpecialChange([oldItem.token], [newItem.token]) ?? newItem.token.text);
    oldStart = oldItem.index + 1;
    newStart = newItem.index + 1;
  }
  return result + diffBody(before.slice(oldStart).map(t => t.text).join(''),
    after.slice(newStart).map(t => t.text).join(''), minWords, report);
}

function diffBody(oldBody, newBody, minWords = 1, report) {
  if (!Number.isInteger(minWords) || minWords < 1) throw new Error('minWords must be a positive integer.');
  const oldTokens = tokenize(oldBody);
  const newTokens = tokenize(newBody);
  let result = '';
  for (const [i1, i2, j1, j2, equal] of opcodes(oldTokens, newTokens)) {
    const before = oldTokens.slice(i1, i2);
    const after = newTokens.slice(j1, j2);
    const special = equal ? null : renderSpecialChange(before, after);
    const structured = equal || special !== null ? null : renderStructuredChange(before, after, minWords, report);
    const changedWords = Math.max(before.filter(t => t.kind === 'word').length,
      after.filter(t => t.kind === 'word').length);
    if (special !== null) {
      result += special;
    } else if (structured !== null) {
      result += structured;
    } else if (equal || changedWords < minWords || !canMark(before) || !canMark(after)) {
      if (!equal && report && (before.some(t => !['word', 'space', 'punct'].includes(t.kind)) ||
          after.some(t => !['word', 'space', 'punct'].includes(t.kind)))) report.unmarkedChanges++;
      result += after.map(t => t.text).join('');
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
  const tex = preamble + (preamble.endsWith('\n') ? '' : '\n') + PREAMBLE + BEGIN +
    diffBody(oldBody, newBody, minWords, report) + ending;
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
  if (result.unmarkedChanges) console.warn(`${result.unmarkedChanges} structural changes were not visually marked; review the output.`);
  return 0;
}

if (typeof module !== 'undefined' && require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (typeof module !== 'undefined') module.exports = { tokenize, diffBody, makeDiff, makeDiffWithReport };
if (typeof window !== 'undefined') window.SimpleLatexDiff = { makeDiff, makeDiffWithReport };
