import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, ProcessRunResult, Register } from 'claude-code'
import { renderTex, withInk, type ColorScheme } from './math'
import { drawMessage } from './draw'
import { looksLikeMath, parse, type Piece } from './parse'
import {
  binCandidates,
  documentForBlock,
  hashOf,
  hasQueued,
  refusedCommand,
  release,
  requestBlock,
  resultOf,
  setResult,
  takeBlock,
  texError,
  themeInk,
  type BlockJob,
  type Rendered,
} from './texjobs'

// Draws Claude's replies in the desktop Code tab with TeX rendered: a fork of
// zaahiral/claude-latex 0.5.0 (MIT, commit 606d897) for students who study
// with Claude. $$...$$, \[...\] and equation/align environments become
// centered SVG blocks. A paragraph with $...$ or \(...\) is laid out word by
// word, each formula an inline SVG sitting on the text's baseline. MathJax,
// bundled in hooks/mathjax/, draws every formula. With compileBlocks on, a
// ```tikz block is compiled with the local MiKTeX into a drawing. Everything
// else stays the app's own Markdown. Only replies on the desktop surface are
// drawn: other surfaces and the user's own messages keep the app's drawing.

// Goes up each time a compile finishes. A message waiting on a compile reads
// it, so writing it redraws exactly those messages.
const version = atom({ plugin: 'study-latex', key: 'version' } as const, 0)

// The section the model gets while the mod draws: it cannot see how its reply
// is drawn, so it is told how to write math that renders here, and how to
// write a figure when TikZ blocks compile.
function modelNote(withFigures: boolean): string {
  const lines = [
    '# Math rendering (study-latex mod)',
    '',
    'This desktop session draws TeX in your replies. Write math as TeX, not as Unicode symbols:',
    '- Symbols and short quantities in a sentence: inline $...$, such as $\\sigma_x$, $h_2$, $\\dot{m}$, $\\vec{F}$, $25^\\circ\\text{C}$.',
    '- Equations, fractions and derivation steps: a display block, $$...$$ on lines of its own with a blank line before and after.',
    '- Inside every formula, LaTeX commands, never raw Unicode. Write \\$ for a dollar sign that could pair with another.',
    '- Past about 75 formulas in one reply the app draws the rest itself, with simpler math support: split long material over several replies.',
  ]
  if (withFigures) {
    lines.push(
      '- A figure: a ```tikz code block holding the inside of a tikzpicture, compiled into a drawing; at most 4 to 6 per reply. Plain TikZ only: no \\def, \\newcommand or \\let, no # parameters, no \\edef or \\expandafter, no \\usepackage and no file access, and never the words file, table or graphics, not even in labels. Numbers go in \\pgfmathsetmacro, plot data in coordinates {...}. A block that breaks this shows an error instead of the figure.',
    )
  }
  return lines.join('\n')
}

// Compiles run side by side, at most this many at once.
const WORKERS = 2
// Interrupted compiles are retried this many times.
const MAX_RETRIES = 2
const retries = new Map<string, number>()
// The app refuses an Svg over 131072 characters, and refusing one refuses the
// whole message's drawing. Leave room for the color style withInk adds.
const MAX_SVG_CHARS = 131072 - 400
// How large one message's drawing may be. Upstream measured the desktop app
// dropping a drawing of about 257,000 characters without a word; past this
// size the rest of the message goes to the app's own Markdown.
const MAX_MESSAGE_CHARS = 235_000
// The variables override MiKTeX's own settings for that one process, so
// \input and \openout stay inside the build folder; \openin and \read are
// not covered, and the screen in texjobs.ts stops those. The flags turn off
// the package installer and \write18.
const TEX_ENV = { MIKTEX_CORE_ALLOWUNSAFEINPUTFILES: 'false', MIKTEX_CORE_ALLOWUNSAFEOUTPUTFILES: 'false' }
const LATEX_FLAGS = ['-disable-installer', '-disable-write18', '-interaction=nonstopmode', '-halt-on-error']
// dvisvgm leaves PostScript specials alone, so Ghostscript never runs.
const DVISVGM_FLAGS = ['--no-specials=ps', '--no-fonts', '--exact-bbox', '--zoom=1.3', '--stdout']
const TIMEOUT_MS = 60_000

// The folder holding latex.exe and dvisvgm.exe, once found.
let texBin: string | null = null
// %LOCALAPPDATA%\claude-study-latex: compiled SVGs, the build folders and the
// debug log. Never the mod's own folder, which is in the repository.
let cacheDir = ''
const debugLines: string[] = []

function debug($: Engine, line: string): void {
  debugLines.push(`${new Date().toISOString()} ${line}`)
  if (debugLines.length > 600) debugLines.splice(0, debugLines.length - 600)
  if (cacheDir) void $.fs.write(`${cacheDir}/debug/setup.log`, debugLines.join('\n') + '\n').catch(() => undefined)
}

// A failed call that is not a timeout (a reload, a process that could not
// start): worth another try.
function describeFailure(error: unknown): Rendered {
  return { error: String(error), interrupted: true }
}

// Runs one program of a compile and times it on its own. A run killed at the
// timeout makes the call reject, in words the mod does not rely on, or could
// come back with an exit code; either way a run that ends at the limit is
// the timeout, never an interrupted run to retry.
async function runTool($: Engine, argv: string[], dir: string): Promise<ProcessRunResult | 'timed out'> {
  const started = Date.now()
  const atLimit = () => Date.now() - started >= TIMEOUT_MS - 2_000
  try {
    const run = await $.process.run(argv, { cwd: dir, env: TEX_ENV, timeoutMs: TIMEOUT_MS })
    return run.exitCode !== 0 && atLimit() ? 'timed out' : run
  } catch (error) {
    if (atLimit()) return 'timed out'
    throw error
  }
}

// Compiles one block in a build folder named after the block, so two
// sessions compiling at once never share one: latex, then dvisvgm with the
// SVG on standard output. A later compile of the same block overwrites the
// folder's files, so nothing is deleted.
async function compileBlock($: Engine, job: BlockJob): Promise<Rendered> {
  const cached = `${cacheDir}/b-${job.key}.svg`
  if (await $.fs.exists(cached)) return { svg: await $.fs.read(cached) }
  const refused = refusedCommand(job.source)
  if (refused) return { error: `This block uses ${refused}, which the mod does not compile: a block is plain TikZ, with no file access, packages, macro definitions or parameters (see the mod's README).` }
  const dir = `${cacheDir}/build/${job.key}`
  await $.fs.write(`${dir}/d.tex`, documentForBlock(job))
  const latex = await runTool($, [`${texBin}/latex.exe`, ...LATEX_FLAGS, 'd.tex'], dir)
  if (latex === 'timed out') return { error: 'LaTeX ran for 60 seconds without finishing, so it was stopped. The block may loop forever.' }
  if (latex.exitCode !== 0) {
    // A run with no error line was stopped from outside, not by the TeX.
    const isTexError = latex.stdout.includes('\n!') || latex.stdout.startsWith('!')
    return isTexError ? { error: texError(latex.stdout) } : { error: 'The compile was interrupted.', interrupted: true }
  }
  // A run that wrote no page leaves an earlier try's d.dvi in the folder.
  if (!latex.stdout.includes('Output written on d.dvi')) return { error: 'LaTeX wrote no page: the block draws nothing.' }
  const dvisvgm = await runTool($, [`${texBin}/dvisvgm.exe`, ...DVISVGM_FLAGS, 'd.dvi'], dir)
  if (dvisvgm === 'timed out') return { error: 'dvisvgm ran for 60 seconds without finishing, so it was stopped.' }
  if (dvisvgm.exitCode !== 0 || !dvisvgm.stdout.includes('<svg')) return { error: 'dvisvgm stopped before writing the SVG.', interrupted: true }
  const svg = themeInk(dvisvgm.stdout)
  // A block with nothing to draw (only settings or comments) still makes a
  // page, which dvisvgm turns into an SVG of no size.
  if (/^<svg[^>]*\s(?:width|height)=['"]0(?:\.0*)?(?:pt)?['"]/.test(svg)) return { error: 'The block draws nothing.' }
  if (svg.length > MAX_SVG_CHARS) {
    return { error: `This drawing is ${Math.round(svg.length / 1024)} KB of SVG. The app draws at most 128 KB.` }
  }
  await $.fs.write(cached, svg)
  return { svg }
}

// Compiles queued blocks, up to WORKERS at once, and redraws waiting messages
// as results land.
let workersStarted = false
function startWorkers($: Engine): void {
  if (workersStarted) return
  workersStarted = true
  let running = 0
  let finished = 0
  let lastBump = 0
  $.clock.every(100, () => {
    // Redraw waiting messages at most every 400 ms, and once more when the
    // queue drains, rather than once per compile.
    const now = Date.now()
    if (finished > 0 && (now - lastBump >= 400 || (running === 0 && !hasQueued()))) {
      finished = 0
      lastBump = now
      void update($, version, n => n + 1).catch(() => undefined)
    }
    while (running < WORKERS && hasQueued()) {
      const block = takeBlock()
      if (!block) break
      running += 1
      void (async () => {
        const started = Date.now()
        const result = await compileBlock($, block).catch(describeFailure)
        const tries = retries.get(block.key) ?? 0
        const outcome = 'svg' in result ? `${result.svg.length} chars` : `error${result.interrupted ? ' (interrupted)' : ''}: ${result.error.split('\n')[0]}`
        debug($, `compiled ${block.key}, try ${tries + 1}: ${outcome}, ${Date.now() - started} ms | ${JSON.stringify(block.source.slice(0, 40))}`)
        if ('error' in result && result.interrupted && tries < MAX_RETRIES) {
          retries.set(block.key, tries + 1)
          release(block.key)
          requestBlock(block)
        } else {
          setResult(block.key, result)
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          running -= 1
          finished += 1
        })
    }
  })
}

// A compiled SVG already on disk is read straight into memory, so a diagram
// compiled in an earlier session appears at once.
async function fromDisk($: Engine, key: string): Promise<void> {
  if (!cacheDir) return
  const path = `${cacheDir}/b-${key}.svg`
  if (!(await $.fs.exists(path).catch(() => false))) return
  const svg = await $.fs.read(path).catch(() => '')
  if (svg) setResult(key, { svg })
}

const blockKey = (source: string) => hashOf('tikz', source)

export const register: Register = (on, options) => {
  const scheme = (['light', 'dark'].includes(String(options.colorScheme)) ? options.colorScheme : 'auto') as ColorScheme
  const blocksOn = options.compileBlocks === true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Setup runs after the session is ready, so it never holds it up.
    void (async () => {
      const localAppData = (await $.env.get('LOCALAPPDATA').catch(() => undefined)) ?? ''
      cacheDir = localAppData ? `${localAppData}/claude-study-latex` : ''
      debug($, `session start, options ${JSON.stringify(options)}`)
      if (!blocksOn || !cacheDir) return
      const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
      for (const dir of binCandidates(path, localAppData)) {
        const found =
          (await $.fs.exists(`${dir}/latex.exe`).catch(() => false)) &&
          (await $.fs.exists(`${dir}/dvisvgm.exe`).catch(() => false))
        if (found) {
          texBin = dir
          break
        }
      }
      debug($, `TeX ${texBin ? `at ${texBin}` : 'not found, so tikz blocks stay code'}`)
      if (!texBin) return
      startWorkers($)
      // Messages drawn before TeX was found left their blocks as code. Draw
      // them again now that blocks can compile.
      await update($, version, n => n + 1).catch(() => undefined)
    })().catch(error => debug($, `setup failed: ${String(error)}`))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // One redraw for everything that compiled during the turn.
    await update($, version, n => n + 1).catch(() => undefined)
    return done
  })

  // Where the mod draws, the model gets one section of the system prompt (the
  // desktop app sends such sections with the conversation's first message, so
  // a mod installed mid-session reaches the model from the next session on),
  // and every program the session starts from here on, your own hooks
  // included, sees STUDY_LATEX_MOD=1. The variable is never unset: a
  // subagent's prompt may be composed with no surface.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.surfaces.includes('desktop')) return composed
    await $.env.set('STUDY_LATEX_MOD', '1').catch(() => undefined)
    const note = modelNote(blocksOn && texBin !== null)
    return { sections: [...composed.sections, { id: 'study-latex:rendering', text: note, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'desktop') return next(e)
    const renderStarted = Date.now()
    try {
      const text = e.props.text
      if (!looksLikeMath(text)) return next(e)
      // Before TeX is found, blocks are left as code. Listen for the redraw
      // that follows setup.
      if (blocksOn && texBin === null && /```\s*tikz/.test(text)) await read($, version)
      // Only tikz blocks compile here; a tikzcd or latex fence the parser
      // picked up goes back to the app's Markdown as written.
      const pieces: Piece[] = parse(text, { blocks: blocksOn && texBin !== null }).map(p =>
        p.kind === 'block' && p.lang !== 'tikz' ? { kind: 'md', text: p.raw } : p,
      )
      // Dollars that turned out not to be math leave nothing to draw.
      if (!pieces.some(p => p.kind !== 'md')) return next(e)
      const { Box, Text, Markdown, Svg, Button, Link } = $.ui.resolve(e)

      let isWaiting = false
      // What this drawing hands the app, for the debug log.
      const handed = { svgs: 0, svgChars: 0 }
      let size: { chars: number; handedBackAt: number | null } = { chars: 0, handedBackAt: null }
      const count = (svg: string) => {
        handed.svgs += 1
        handed.svgChars += svg.length
        return svg
      }
      const compiled = (p: { source: string }): Rendered | undefined => {
        const key = blockKey(p.source)
        const result = resultOf(key)
        if (!result) {
          requestBlock({ key, lang: 'tikz', source: p.source })
          isWaiting = true
          return undefined
        }
        return 'svg' in result ? { svg: count(withInk(result.svg, scheme)) } : result
      }

      // Fill the in-memory results from the disk cache before drawing.
      for (const p of pieces) {
        if (p.kind === 'block' && !resultOf(blockKey(p.source))) await fromDisk($, blockKey(p.source))
      }

      const tree = drawMessage(pieces, {
        el: { Box, Text, Markdown, Svg, Button, Link },
        formula: (source, display) => {
          const svg = renderTex(source, display)
          return svg ? count(withInk(svg, scheme)) : null
        },
        block: compiled,
        maxChars: MAX_MESSAGE_CHARS,
        onDrawn: drawn => {
          size = drawn
        },
        showCopy: false,
        onCopy: () => undefined,
      })
      // Only a message still waiting on a compile listens for finished
      // compiles. A finished message is never redrawn by them.
      if (isWaiting) await read($, version)
      // A reply is redrawn about ten times a second while it streams, so only
      // a drawing that hit the size guard is logged.
      if (size.handedBackAt !== null) {
        const kinds = pieces.map(p => p.kind[0]).join('')
        debug($, `drew ${text.length} chars: pieces ${kinds}, ${handed.svgs} svgs of ${handed.svgChars} chars, drawing ${size.chars} chars, handed back from piece ${size.handedBackAt} | ${JSON.stringify(text.slice(0, 40))}`)
      }
      return tree
    } catch (error) {
      // Never leave a message undrawn: fall back to the app's own drawing.
      debug($, `render error (${e.props.text.length} chars): ${String(error)}`)
      return next(e)
    } finally {
      const ms = Date.now() - renderStarted
      if (ms > 150) debug($, `slow render ${ms} ms (${e.props.text.length} chars)`)
    }
  }).catch(async ($, e, next) => {
    // The engine refused the drawing, or the hook overran. Write down why,
    // and let the app draw the message itself.
    debug($, `REFUSED ${e.props.text.length} chars: ${next.error.kind} ${next.error.message ?? ''} | ${JSON.stringify(e.props.text.slice(0, 40))}`)
    return next(e)
  })
}
