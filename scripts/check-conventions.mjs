// Checks the conventions of `src` that the compiler doesn't hold the code to (docs/APP.md, the code
// map), and lists what breaks them:
//
//   types   a module's exported interfaces are in the `*.types.ts` file beside it, which holds
//           types alone and imports types alone (src/db/schema.ts has no such file);
//   docs    every module-level `const`, every exported function and every interface has a JSDoc
//           comment (`/** ... */`) right on top of it;
//   order   a module's constants are at the top of the file, above its first function or class.
//           One that is built from an arrow function of the file stays below it, since that has
//           to be defined first, and so does one built from such a constant. A script, which has
//           statements of its own to run in their order, is left as it is.
//
// `npm run check` runs it, and so does CI: it prints one line for each, `<file>:<line> <what>`,
// and exits with 1 if there are any.
//
// It reads the source as text. TypeScript 7 has no parser a script can call, so this finds a
// file's statements by how the code is laid out: a statement starts on a line that isn't indented,
// outside every bracket. Comments, strings, templates and regular expressions are blanked first, so
// nothing written in one is read as code.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The one module whose exported interfaces stay in it: it holds the database's types and nothing else.
const TYPES_IN_PLACE = 'src/db/schema.ts';

// The words a regular expression can follow. After any other word, or a `)` or a `]`, a `/` divides.
const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof']);

const isWord = (c) => c !== undefined && /[\w$]/.test(c);

// The source with everything that isn't code blanked: comments, and what is inside strings,
// templates and regular expressions. Every character keeps its place and every line its number.
// The expressions of a template (`${...}`) are code, and stay. `comments` lists the comments, in
// order: where each starts and ends, and whether it is a JSDoc. `templates` lists the templates that
// aren't inside another: where each one's backticks are.
export function blank(text) {
  const out = text.split('');
  const comments = [];
  const templates = [];
  const erase = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  const n = text.length;
  // Where each template that is still open started, the outermost first.
  const open = [];
  // The brace depth each open `${` was at: the `}` that comes back to it ends the expression.
  const expressions = [];
  let braces = 0;
  // The last thing read that wasn't a space or a comment: a word, or a single character.
  let last = '';

  // Blanks a template's text from `from` to its closing backtick or its next `${`, and returns where the code after it starts.
  const template = (from) => {
    let j = from;
    while (j < n && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) j += text[j] === '\\' ? 2 : 1;
    erase(from, j);
    if (text[j] === '$') {
      expressions.push(braces++);
      last = '{';
      return j + 2;
    }
    const start = open.pop();
    if (open.length === 0) templates.push({ start, end: j });
    last = '`';
    return j + 1;
  };

  // Where the regular expression that starts at `from` ends, or -1 if what starts there isn't one: it doesn't end on its line.
  const regexEnd = (from) => {
    let inClass = false;
    for (let j = from + 1; j < n && text[j] !== '\n'; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === '[') inClass = true;
      else if (text[j] === ']') inClass = false;
      else if (text[j] === '/' && !inClass) return j;
    }
    return -1;
  };

  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const line = text[i + 1] === '/';
      const close = text.indexOf(line ? '\n' : '*/', i + 2);
      const end = close < 0 ? n : close + (line ? 0 : 2);
      comments.push({ start: i, end, doc: !line && text[i + 2] === '*' && text[i + 3] !== '/' });
      erase(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      erase(i + 1, j);
      i = j + 1;
      last = c;
    } else if (c === '`') {
      open.push(i);
      i = template(i + 1);
    } else if (c === '{') {
      braces++;
      i++;
      last = c;
    } else if (c === '}') {
      braces--;
      if (expressions.length && expressions.at(-1) === braces) {
        expressions.pop();
        i = template(i + 1);
      } else {
        i++;
        last = c;
      }
    } else if (c === '/') {
      const end = last === '' || BEFORE_REGEX.has(last) || '(,=:[!&|?{};+-*%<>~^'.includes(last) ? regexEnd(i) : -1;
      if (end < 0) {
        i++;
        last = c;
      } else {
        erase(i + 1, end);
        i = end + 1;
        while (isWord(text[i])) i++;
        last = ')';
      }
    } else if (isWord(c)) {
      let j = i;
      while (isWord(text[j])) j++;
      last = text.slice(i, j);
      i = j;
    } else {
      // A `!` right after a value says the value is there (`x!`): what follows it follows the value.
      if (!/\s/.test(c) && !(c === '!' && (isWord(text[i - 1]) || text[i - 1] === ')' || text[i - 1] === ']') && text[i + 1] !== '=')) last = c;
      i++;
    }
  }
  return { code: out.join(''), comments, templates };
}

// Where the bracket that opens at `from` closes, in blanked code.
function closing(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if ('([{'.includes(code[i])) depth++;
    else if (')]}'.includes(code[i]) && --depth === 0) return i;
  }
  return code.length;
}

// What a `const` is given: the code after the `=` of its declaration, which is the first `=` outside every bracket that isn't part of `=>`, `==`, `<=` and the like.
function initializer(statement) {
  let depth = 0;
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '=' && depth === 0 && !'=>'.includes(statement[i + 1]) && !'=!<>'.includes(statement[i - 1])) return statement.slice(i + 1);
  }
  return '';
}

// Whether what a `const` is given is a function: a `function`, or an arrow function.
function isFunction(init) {
  let t = init.trimStart();
  if (/^(async\s+)?function\b/.test(t)) return true;
  t = t.replace(/^async\s+/, '');
  if (t[0] === '<') {
    let depth = 0;
    let i = 0;
    do depth += t[i] === '<' ? 1 : t[i] === '>' && t[i - 1] !== '=' ? -1 : 0;
    while (depth > 0 && ++i < t.length);
    t = t.slice(i + 1).trimStart();
  }
  if (/^[\w$]+\s*=>/.test(t)) return true;
  // `(a, b) =>`, or `(a, b): type =>`. Nothing else has a `:` after its closing bracket.
  return t[0] === '(' && /^\s*(=>|:)/.test(t.slice(closing(t, 0) + 1));
}

// What a statement is: an `import`, a `reexport`, a `type` (an interface, a type alias), a
// `function`, a `class`, a `declare`, a `let`, a `const` (a value), a `const-fn` (a constant that
// is a function), or `code`, which is anything else and runs when the module loads.
function kindOf(statement) {
  if (/^import\b/.test(statement)) return 'import';
  if (/^export\s+(type\s+)?[{*]/.test(statement)) return 'reexport';
  if (/^(export\s+)?(declare\s+)?(interface|type|namespace|module)\s+[\w$'"]/.test(statement)) return 'type';
  if (/^(export\s+)?(default\s+)?(async\s+)?function\b/.test(statement)) return 'function';
  if (/^(export\s+)?(default\s+)?(abstract\s+)?class\b/.test(statement)) return 'class';
  if (/^(export\s+)?declare\b/.test(statement)) return 'declare';
  if (/^(export\s+)?(let|var)\b/.test(statement)) return 'let';
  if (/^(export\s+)?const\b/.test(statement)) return isFunction(initializer(statement)) ? 'const-fn' : 'const';
  return 'code';
}

// The names a `const` statement declares: one, or those its `{ ... }` or `[ ... ]` pattern takes apart.
function namesOf(statement) {
  const after = statement.replace(/^(export\s+)?(declare\s+)?const\s+/, '');
  return '{['.includes(after[0]) ? (after.slice(1, closing(after, 0)).match(/[\w$]+/g) ?? []) : [after.match(/^[\w$]+/)?.[0] ?? '?'];
}

// A file's statements, in order: where each starts, its line, its code and what it is. `templates` is where the file's templates are (see blank): a line of one starts no statement.
export function statementsOf(code, templates = []) {
  const starts = [];
  let depth = 0;
  let at = 0;
  for (const line of code.split('\n')) {
    if (depth === 0 && line.length > 0 && !/\s/.test(line[0]) && !templates.some((t) => t.start < at && at <= t.end)) starts.push(at);
    for (const c of line) depth += '([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0;
    at += line.length + 1;
  }
  return starts.map((start, i) => {
    const text = code.slice(start, starts[i + 1] ?? code.length);
    return { start, line: code.slice(0, start).split('\n').length, text, kind: kindOf(text) };
  });
}

// What in a file breaks a convention: `{ line, rule, message }` for each, in the order of the rules. `file` is its path from the repository's root.
export function check(file, text) {
  const { code, comments, templates } = blank(text);
  const statements = statementsOf(code, templates);
  const found = [];
  const lineAt = (pos) => code.slice(0, pos).split('\n').length;

  // Whether a JSDoc is right on top of what starts at `pos`: the comment before it is one, with no blank line and no code between them.
  const documented = (pos) => {
    const before = comments.findLast((c) => c.end <= pos);
    return !!before?.doc && !/\S|\n\s*\n/.test(code.slice(before.end, pos));
  };

  // types
  if (file.endsWith('.types.ts')) {
    for (const s of statements) {
      if (s.kind === 'import' ? !/^import\s+type\b/.test(s.text) : s.kind !== 'type' && !/^export\s+type\b/.test(s.text)) {
        found.push({ line: s.line, rule: 'types', message: s.kind === 'import' ? 'a *.types.ts file imports types alone: `import type`' : 'a *.types.ts file holds types alone' });
      }
    }
  } else if (file !== TYPES_IN_PLACE) {
    for (const s of statements) {
      const name = s.text.match(/^export\s+(?:declare\s+)?interface\s+([\w$]+)/)?.[1];
      if (name) found.push({ line: s.line, rule: 'types', message: `the exported interface ${name} goes in ${file.replace(/\.ts$/, '.types.ts')}` });
    }
  }

  // docs
  for (const s of statements) {
    if ((s.kind === 'const' || s.kind === 'const-fn' || /^(export\s+)?declare\s+const\b/.test(s.text)) && !documented(s.start)) found.push({ line: s.line, rule: 'docs', message: `the constant ${namesOf(s.text).join(', ')} has no JSDoc comment` });
    // A signature without a body is an overload, which the function's own comment covers.
    else if (s.kind === 'function' && /^export\b/.test(s.text) && s.text.includes('{') && !documented(s.start)) {
      found.push({ line: s.line, rule: 'docs', message: `the exported function ${s.text.match(/function\s*\*?\s*([\w$]+)/)?.[1] ?? 'default'} has no JSDoc comment` });
    }
  }
  for (const m of code.matchAll(/^[ \t]*((?:export\s+)?(?:declare\s+)?interface\s+([\w$]+))/gm)) {
    const pos = m.index + m[0].length - m[1].length;
    if (!documented(pos)) found.push({ line: lineAt(pos), rule: 'docs', message: `the interface ${m[2]} has no JSDoc comment` });
  }

  // order
  const first = statements.find((s) => ['function', 'class', 'const-fn', 'let', 'code'].includes(s.kind));
  if (first && !statements.some((s) => s.kind === 'code')) {
    // What has to be defined before a constant that uses it: the file's arrow functions, and the constants built from them.
    const late = new Set(statements.filter((s) => s.kind === 'const-fn').flatMap((s) => namesOf(s.text)));
    for (const s of statements) {
      if (s.kind !== 'const' || s.start < first.start) continue;
      const uses = new Set(initializer(s.text).match(/(?<![.\w$])[\w$]+/g) ?? []);
      if ([...late].some((name) => uses.has(name))) for (const name of namesOf(s.text)) late.add(name);
      else found.push({ line: s.line, rule: 'order', message: `the constant ${namesOf(s.text).join(', ')} goes at the top of the file, above its first function or class (line ${first.line})` });
    }
  }
  return found;
}

// Every `.ts` file under a directory, as paths from the repository's root, in order.
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [relative(root, join(dir, e.name)).split('\\').join('/')] : []))
    .sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = sourceFiles(join(root, 'src'));
  let count = 0;
  for (const file of files) {
    for (const { line, rule, message } of check(file, readFileSync(join(root, file), 'utf8'))) {
      console.log(`${file}:${line} [${rule}] ${message}`);
      count++;
    }
  }
  if (count > 0) {
    console.error(`\n${count} ${count === 1 ? 'place breaks' : 'places break'} the conventions of src (docs/APP.md, the code map).`);
    process.exit(1);
  }
  console.log(`${files.length} files of src keep its conventions.`);
}
