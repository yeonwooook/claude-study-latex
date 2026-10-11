// The pure half of TikZ rendering: the document a block becomes, the screen
// that refuses file access, the job queue and the SVG clean-up. register.tsx
// runs latex and dvisvgm, since only a function in the hooks module's own
// file may call the engine.
//
// Adapted from zaahiral/claude-latex 0.5.0 (MIT) for Windows and MiKTeX:
// tikz blocks only, a fixed preamble of packages installed on this machine,
// no saved LaTeX formats and no LaTeX math fonts.

export type BlockLang = 'tikz'
// `interrupted`: stopped from outside (a reload, a killed process), not a
// TeX error, so worth one more try.
export type Rendered = { svg: string } | { error: string; interrupted?: boolean }
export type BlockJob = { key: string; lang: BlockLang; source: string }

// Where MiKTeX's latex.exe and dvisvgm.exe may be: each folder on PATH
// (Windows separates them with ;) whose path names MiKTeX, then MiKTeX's
// per-user install folder. Only MiKTeX is used: the safety switches in
// register.tsx are MiKTeX's own, and another TeX would not apply them.
export function binCandidates(path: string, localAppData: string): string[] {
  const dirs = path
    .split(';')
    .map(dir => dir.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, ''))
    .filter(Boolean)
  if (localAppData) dirs.push(`${localAppData}\\Programs\\MiKTeX\\miktex\\bin\\x64`)
  return [...new Set(dirs)].filter(dir => /miktex/i.test(dir))
}

const blockQueue = new Map<string, BlockJob>()
const results = new Map<string, Rendered>()
// Jobs a worker has taken and not finished. A message redrawn while its
// block compiles asks for the block again: without this the same block
// went to a second worker.
const inFlight = new Set<string>()

// cyrb53: a fast 53-bit string hash, plenty to key a cache.
export function hashOf(...parts: string[]): string {
  const str = ['study-v1', ...parts].join('\n')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

export function resultOf(key: string): Rendered | undefined {
  return results.get(key)
}

export function setResult(key: string, result: Rendered): void {
  results.set(key, result)
  inFlight.delete(key)
}

// Lets a job that was stopped from outside be asked for again.
export function release(key: string): void {
  inFlight.delete(key)
}

export function requestBlock(job: BlockJob): void {
  if (!results.has(job.key) && !inFlight.has(job.key)) blockQueue.set(job.key, job)
}

export function hasQueued(): boolean {
  return blockQueue.size > 0
}

export function takeBlock(): BlockJob | undefined {
  const next = blockQueue.values().next()
  if (next.done) return undefined
  blockQueue.delete(next.value.key)
  inFlight.add(next.value.key)
  return next.value
}

// TeX commands a block may not use. MiKTeX is told to refuse \input and
// \openout outside the build folder (register.tsx), but \openin and \read
// still reach any file by its full path, and so do their expl3 names
// (\tex_openin:D once \ExplSyntaxOn is given). A PostScript special hands a
// file name to Ghostscript, pgf images read files, and \csname and its kin,
// \UseName, \ExpandArgs, \catcode, ^^, \scantokens, a changed \endlinechar
// and \lowercase or \uppercase can spell any command or word from other
// text. A block is plain TikZ: it defines no macro and takes no parameter
// (#1), because a macro's arguments, or \edef, \xdef, \expanded and
// \expandafter, can splice text into what TikZ reads next and so join a
// refused word from parts. Only Claude writes these blocks, and a figure
// needs none of it. \usepackage stays out because the preamble is fixed.
const REFUSED =
  /\\(?:openin|openout|read|readline|input|include|includegraphics|catcode|scantokens|special|makeatletter|immediate|write18|IfFileExists|InputIfFileExists|pdf[a-z]+|directlua|lastnamedcs|endlinechar|lowercase|uppercase|MakeLowercase|MakeUppercase|def|gdef|edef|xdef|let|expanded|expandafter|noexpand|unexpanded|newcommand|renewcommand|providecommand|DeclareRobustCommand|NewCommandCopy|[A-Za-z]*DocumentCommand|newenvironment|renewenvironment|[A-Za-z]*DocumentEnvironment|DeclareMathOperator|usepackage|RequirePackage|documentclass|lstinputlisting|verbatiminput|pgfplotstable[a-zA-Z]*|pgfimage|pgfdeclareimage|pgfuseimage|ExplSyntaxOn|ExplSyntaxNamesOn|ProvidesExpl[a-zA-Z]*|UseName|ExpandArgs)(?![a-zA-Z])|\\[a-zA-Z]*csname|\^\^|(?<!\\)#+[1-9]/
// The pgfkeys handlers that expand a value before it is used, and the key
// that puts path text back in front of TikZ: the same splicing by keys.
// TeX reads any run of spaces or a line break between words as one space.
const REFUSED_KEY = /\.(?:expand(?:ed|\s+once|\s+twice)|e(?:style|code|store))\b|\binsert\s+path\b/
// The words that make a plot read a file: TikZ's `plot file`, pgfplots'
// `table`, `file` and `graphics`, the data visualization's `read from file`.
// They are refused anywhere, labels included, so one kept in a \tikzset
// value or a \pgfmathsetmacro string is caught as well.
const REFUSED_WORD = /\b(?:file|table|graphics)\b/i

// The block as TeX reads it: a % that is not \% drops the rest of its line,
// the line break and the next line's leading spaces, which joins the two
// halves of a word split across a comment.
export function withoutComments(source: string): string {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === '\\') {
      out += c + (source[i + 1] ?? '')
      i += 1
    } else if (c === '%') {
      const end = source.indexOf('\n', i)
      if (end < 0) break
      i = end
      while (source[i + 1] === ' ' || source[i + 1] === '\t') i += 1
    } else {
      out += c
    }
  }
  return out
}

// What keeps a block from compiling, for the reader: a command, or a key or
// word in quotes; null when nothing does. This is a screen, not a sandbox:
// being a list it can miss a spelling, so the MiKTeX switches stay on behind
// it, and what a missed spelling could still do is bounded (README.md).
export function refusedCommand(source: string): string | null {
  const text = withoutComments(source)
  const command = REFUSED.exec(text)
  if (command) return command[0]
  const quoted = REFUSED_KEY.exec(text) ?? REFUSED_WORD.exec(text)
  return quoted ? `"${quoted[0]}"` : null
}

// The fixed preamble: what a figure needs, from packages installed with
// MiKTeX on this machine. The package installer is off while a block
// compiles, so nothing is fetched for one.
const PREAMBLE = [
  '\\documentclass[dvisvgm,border=3pt]{standalone}',
  '\\usepackage{amsmath,amssymb}',
  '\\usepackage{bm,xcolor}',
  '\\usepackage{tikz,pgfplots}',
  '\\pgfplotsset{compat=newest}',
  '\\usetikzlibrary{arrows.meta,positioning,calc,shapes.geometric,shapes.misc,decorations.pathreplacing,decorations.markings,patterns,matrix,fit,backgrounds}',
].join('\n')

// Lines that belong in the preamble may lead a block: TikZ and pgfplots
// libraries and settings, styles and colors.
const PREAMBLE_LINE =
  /^\s*(\\usetikzlibrary|\\usepgfplotslibrary|\\pgfplotsset|\\tikzset|\\definecolor|\\colorlet|\\setlength|%|$)/

// How many braces a line leaves open: each { counts one, each } takes one
// back; \{, \} and a comment do not count.
function openBraces(line: string): number {
  let depth = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') i += 1
    else if (c === '%') break
    else if (c === '{') depth += 1
    else if (c === '}') depth -= 1
  }
  return depth
}

// The whole LaTeX document for one block: the body of a tikzpicture, or a
// block that writes its own tikzpicture or \tikz. A leading preamble line
// that leaves a brace open, such as a \tikzset over several lines, moves
// with the lines up to the one that closes it.
export function documentForBlock(job: BlockJob): string {
  const lines = job.source.split('\n')
  const leading: string[] = []
  let open = 0
  while (lines.length && (open > 0 || PREAMBLE_LINE.test(lines[0] ?? 'x'))) {
    const line = lines.shift()!
    leading.push(line)
    open = Math.max(0, open + openBraces(line))
  }
  let body = lines.join('\n')
  if (!/\\begin\{tikzpicture\}|\\tikz\b/.test(body)) {
    body = `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`
  }
  return [PREAMBLE, ...leading, '\\begin{document}', body, '\\end{document}', ''].join('\n')
}

export function texError(log: string): string {
  const lines = log.split('\n')
  const at = lines.findIndex(l => l.startsWith('!'))
  if (at < 0) return 'LaTeX failed without an error line.'
  return lines.slice(at, at + 4).join('\n').trim()
}

// Black ink follows the theme. Other colors stay as written.
export function themeInk(svg: string): string {
  return svg
    .replace(/^[\s\S]*?(<svg)/, '$1')
    .replace(/(fill|stroke)='(#000|#000000|black)'/g, "$1='currentColor'")
    .replace(/(fill|stroke)="(#000|#000000|black)"/g, '$1="currentColor"')
    .replace(/^<svg /, "<svg fill='currentColor' ")
}
