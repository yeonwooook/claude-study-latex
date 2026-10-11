import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { binCandidates, documentForBlock, hashOf, refusedCommand, withoutComments } from '../hooks/texjobs'

// Math tests kept from zaahiral/claude-latex 0.5.0; the TikZ, surface, signal
// and safety tests are this fork's. TikZ tests turn compileBlocks on, which is
// off by default.

const SAMPLE = [
  'The loss is $L(\\boldsymbol{\\phi}) = \\sum_{i=1}^{I} (\\phi_0 + \\phi_1 x_i - y_i)^2$, and **its gradient** is',
  '',
  '$$\\frac{\\partial L}{\\partial \\phi_1} = 2\\sum_{i=1}^{I} x_i(\\phi_0 + \\phi_1 x_i - y_i) = 0.$$',
  '',
  'This costs $5 and $10.',
].join('\n')

const reply = (text: string) => ({ text, isFirstOfReply: true })

// Setup runs in the background after session start. Let it finish.
async function settle(clock: { advance: (ms: number) => Promise<void> }) {
  for (let i = 0; i < 5; i++) await clock.advance(0)
}

test('draws inline and display math as SVG on the desktop', async $ => {
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(SAMPLE) })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect(await ui.find({ type: 'Markdown', text: /costs \$5 and \$10/ })).toBeDefined()
  await ui.unmount()
})

test('leaves replies on every other surface to the app', async ($, on) => {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine drew this</Text>
  })
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'study-latex', surface, component: 'AssistantMessage', props: reply(SAMPLE) })
    expect(await ui.find({ type: 'Text', text: /engine drew/ })).toBeDefined()
    await ui.unmount()
  }
})

test('leaves dollar amounts to the app', async ($, on) => {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine drew this</Text>
  })
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('It costs $5 and $10 today.') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /engine drew/ })).toBeDefined()
  await ui.unmount()
})

test('keeps math inside code blocks as code', async $ => {
  const text = 'Run this:\n\n```bash\necho "$HOME and $PATH"\n```\n\nThen $x^2$.'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  expect(await ui.find({ type: 'Markdown', text: /echo/ })).toBeDefined()
  await ui.unmount()
})

test('shows a bad formula as red source', async $ => {
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('Broken: $\\frac{a$ here.') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  await ui.unmount()
})

test('reads formulas left to right, and leaves code spans alone', async $ => {
  const text = 'Adjacent $a$$b$ here.\n\nCode `$$PATH$$` and `$x$` stay.\n\n$$c^2$$\n\nNested $\\text{if $x>0$ then } y$ and an empty $$ $$ pair.\n\n$$d^2$$'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  const alts = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
  expect(alts).toEqual(['a', 'b', 'c^2', '\\text{if $x>0$ then } y', 'd^2'])
  await ui.unmount()
})

test('a macro defined in one formula does not reach the next', async $ => {
  const text = 'First $\\renewcommand{\\alpha}{\\text{changed}}\\alpha$ then $\\alpha$.'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  expect(String(svgs[1]?.props.source)).not.toContain('mtext')
  await ui.unmount()
})

test('draws \\div as the division sign, not the divergence of the physics package', async $ => {
  const sourceOf = async (formula: string) => {
    const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(`Then ${formula} here.`) })
    const svg = String((await ui.findAll({ type: 'Svg' }))[0]?.props.source)
    await ui.unmount()
    return svg
  }
  // The division sign with a binary operator's spacing, as TeX's own \div.
  const div = await sourceOf('$a \\div b$')
  expect(div).toEqual(await sourceOf('$a \\mathbin{\u00f7} b$'))
  expect(div).not.toEqual(await sourceOf('$a \\nabla\\cdot b$'))
})

test('lays out a table with math, and draws links and emphasis beside math', async $ => {
  const text = [
    '| Name | Formula |',
    '|---|---|',
    '| Absolute value | $|x|$ and $a \\mid b$ |',
    '',
    'A [link](https://example.com/zeta) next to $\\zeta(2)$, then _italic_ and ~~struck~~.',
  ].join('\n')
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Absolute/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~~|_italic_/ })).toBeUndefined()
  await ui.unmount()
})

test('a message with too much math for one drawing hands the rest to the app', async $ => {
  const formula = (k: number) =>
    `$$\\det\\begin{pmatrix} 1 & x_1 & x_1^2 & \\cdots & x_1^{${k}} \\\\ 1 & x_2 & x_2^2 & \\cdots & x_2^{n-1} \\\\ \\vdots & \\vdots & \\vdots & \\ddots & \\vdots \\\\ 1 & x_n & x_n^2 & \\cdots & x_n^{n-1} \\end{pmatrix} = \\prod_{1 \\le i < j \\le n} (x_j - x_i) \\sum_{n=1}^{\\infty} \\frac{1}{n^s} \\oint_{\\gamma} \\frac{f(z)}{z-a}\\,dz$$`
  const text = Array.from({ length: 36 }, (_, k) => formula(k)).join('\n\n')
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBeGreaterThan(5)
  expect(svgs.length).toBeLessThan(36)
  expect(svgs.reduce((n, svg) => n + String(svg.props.source).length, 0)).toBeLessThan(235_000)
  expect(await ui.find({ type: 'Text', text: /more math than/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /x_1\^\{23\}/ })).toBeDefined()
  await ui.unmount()
})

test('lays out lists with inline math', async $ => {
  const text = '- first $a_1$\n- second $a_2$\n1. third $a_3$'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  await ui.unmount()
})

test('draws arrows, dots, degrees and Korean text inside \\text', async $ => {
  const text = 'Force $\\vec{F}$ at $25^\\circ\\text{C}$, flow $\\dot{m}$:\n\n$$\\sigma_x = \\frac{P}{A} \\quad \\text{(\uc751\ub825)}$$'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)
  await ui.unmount()
})

test('shows an unknown command as red source, not as an SVG', async $ => {
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('Try $\\notacommand{x}$ now.') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /notacommand/ })).toBeDefined()
  await ui.unmount()
})

test('tells the model and the hooks that math renders, on the desktop only', async ($, on) => {
  const sets: { name: string; value?: string }[] = []
  on('env.set', async ($, e) => {
    sets.push(e)
    return { value: undefined }
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'You are an agent.', scope: 'shared' as const }] }))
  const facts = { model: 'claude', promptModel: 'claude', tools: [], outputStyle: null, traits: [] }
  const inTerminal = await $.prompt.compose({ ...facts, surfaces: ['terminal'] } as never)
  expect(inTerminal.sections.map(section => section.id)).toEqual(['intro'])
  expect(sets).toHaveLength(0)
  const onDesktop = await $.prompt.compose({ ...facts, surfaces: ['desktop'] } as never)
  const note = onDesktop.sections.find(section => section.id === 'study-latex:rendering')
  expect(note?.text).toContain('inline $...$')
  expect(note?.text).not.toContain('tikz')
  expect(sets).toEqual([expect.objectContaining({ name: 'STUDY_LATEX_MOD', value: '1' })])
})

// A fake MiKTeX: latex.exe says it wrote d.dvi, dvisvgm.exe prints an SVG.
const BIN = 'C:\\MiKTeX\\bin'
const ENV = { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PATH: `${BIN};C:\\Windows` }
const CACHE = 'C:\\Users\\test\\AppData\\Local\\claude-study-latex'
type Run = { argv: string[]; cwd?: string; env?: Record<string, string> }
// The engine hands file paths on in Windows form, with backslashes.
const win = (path: string) => path.replace(/\//g, '\\')
const isProgram = (argv0: string | undefined, name: string) => win(argv0 ?? '').endsWith(`\\${name}`)

function fakeTex(on: On, answer: { latexStdout?: string; svg?: string; fail?: string } = {}) {
  const files = new Map<string, string>()
  const runs: Run[] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', async ($, e) => ({ value: win(e.path).startsWith(`${BIN}\\`) || files.has(win(e.path)) }))
  on('fs.write', async ($, e) => {
    files.set(win(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', async ($, e) => ({ value: files.get(win(e.path)) ?? '' }))
  on('process.run', async ($, e) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, env: e.init?.env })
    if (answer.fail) throw new Error(answer.fail)
    const exited = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (isProgram(e.argv[0], 'latex.exe')) {
      return { value: { ...exited, stdout: answer.latexStdout ?? 'Output written on d.dvi (1 page, 2740 bytes).' } }
    }
    if (isProgram(e.argv[0], 'dvisvgm.exe')) {
      return { value: { ...exited, stdout: `<?xml version='1.0'?>\n${answer.svg ?? "<svg width='10pt' height='5pt'><path d=''/></svg>"}` } }
    }
    return { value: { ...exited, stdout: '' } }
  })
  return { files, runs }
}

const texRuns = (runs: Run[]) => runs.filter(run => isProgram(run.argv[0], 'latex.exe'))

test('a tikz block compiles with the MiKTeX safety switches and redraws by itself', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  const { runs, files } = fakeTex(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const text = 'A beam:\n\n```tikz\n\\draw (0,0) -- (2,0);\n```'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.find({ type: 'Text', text: /Compiling with LaTeX/ })).toBeDefined()
  for (let i = 0; i < 3; i++) await clock.advance(100)
  const latex = texRuns(runs)[0]
  expect(latex?.argv).toEqual(expect.arrayContaining(['-disable-installer', '-disable-write18', '-halt-on-error']))
  expect(latex?.env).toEqual(expect.objectContaining({ MIKTEX_CORE_ALLOWUNSAFEINPUTFILES: 'false', MIKTEX_CORE_ALLOWUNSAFEOUTPUTFILES: 'false' }))
  // PR #290 review: one build folder per block, so two sessions never share one
  expect(win(latex?.cwd ?? '')).toBe(`${CACHE}\\build\\${hashOf('tikz', '\\draw (0,0) -- (2,0);')}`)
  const dvisvgm = runs.find(run => isProgram(run.argv[0], 'dvisvgm.exe'))
  expect(dvisvgm?.argv).toEqual(expect.arrayContaining(['--no-specials=ps', '--stdout']))
  expect([...files.keys()].some(path => path.startsWith(`${CACHE}\\b-`))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Compiling with LaTeX/ })).toBeUndefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('with compiling on and MiKTeX found, the model is told how to write a figure', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  fakeTex(on)
  on('env.set', async () => ({ value: undefined }))
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'You are an agent.', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const facts = { model: 'claude', promptModel: 'claude', tools: [], outputStyle: null, traits: [] }
  const composed = await $.prompt.compose({ ...facts, surfaces: ['desktop'] } as never)
  const note = composed.sections.find(section => section.id === 'study-latex:rendering')
  expect(note?.text).toContain('```tikz')
  expect(note?.text).toContain('never the words file, table or graphics')
})

test('a run that fails without timing out is tried again, then shows its error', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  const { runs } = fakeTex(on, { fail: 'could not start' })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('```tikz\n\\draw (0,0) -- (1,1);\n```') })
  for (let i = 0; i < 10; i++) await clock.advance(100)
  // the first try and two retries, then an error in place of the drawing
  expect(texRuns(runs)).toHaveLength(3)
  expect(await ui.find({ type: 'Text', text: /LaTeX did not compile/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Compiling with LaTeX/ })).toBeUndefined()
  await ui.unmount()
})

test('a drawing compiled before is read from the cache without TeX', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  const { runs, files } = fakeTex(on)
  const source = '\\draw (0,0) circle (1);'
  files.set(`${CACHE}\\b-${hashOf('tikz', source)}.svg`, "<svg width='3pt' height='3pt'></svg>")
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(`\`\`\`tikz\n${source}\n\`\`\``) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  expect(texRuns(runs)).toHaveLength(0)
  await ui.unmount()
})

test('refuses a block that reaches for files, without running TeX', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  const { runs } = fakeTex(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const text = '```tikz\n\\newread\\r \\openin\\r=C:/Users/test/secret.txt\n\\draw (0,0) -- (1,1);\n```'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  for (let i = 0; i < 3; i++) await clock.advance(100)
  expect(texRuns(runs)).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /uses \\openin, which the mod does not compile/ })).toBeDefined()
  await ui.unmount()
})

test('the screen passes drawing commands and stops file access', () => {
  for (const ok of [
    '\\draw[-{Stealth}] (0,0) -- (1,0) node[right] {$F$};',
    '\\foreach \\x in {0,1} \\fill (\\x,0) circle (2pt);',
    '\\begin{axis}\\addplot coordinates {(0,0) (1,1)};\\end{axis}',
    '\\begin{axis}\\addplot3[surf] {x*y};\\end{axis}',
    '\\pgfmathsetmacro{\\L}{2}\\readlist',
    '\\node at (0,0) {50\\% of $F$};',
    // a word in a comment is never read by TeX
    '\\draw (0,0) -- (1,0); % no plot file here\n\\fill (0,0) circle (1pt);',
  ]) {
    expect(refusedCommand(ok)).toBe(null)
  }
  expect(refusedCommand('\\input{C:/x}')).toBe('\\input')
  expect(refusedCommand('\\includegraphics{x}')).toBe('\\includegraphics')
  expect(refusedCommand('\\readline\\r to\\x')).toBe('\\readline')
  expect(refusedCommand('\\csname openin\\endcsname')).toBe('\\csname')
  expect(refusedCommand('\\ifcsname tex_openin:D\\endcsname\\lastnamedcs\\fi')).toBe('\\ifcsname')
  expect(refusedCommand('\\^^6fpenin')).toBe('^^')
  expect(refusedCommand('\\special{ps: (x) run}')).toBe('\\special')
  expect(refusedCommand('\\usepackage{catchfile}')).toBe('\\usepackage')
  expect(refusedCommand('\\addplot table {data.txt};')).toBe('"table"')
  expect(refusedCommand('\\addplot+[mark=*] file {data.txt};')).toBe('"file"')
  // PR #290 review: a 3D plot, plot graphics and pgfplots tables read files too
  expect(refusedCommand('\\addplot3 table {C:/x.txt};')).toBe('"table"')
  expect(refusedCommand('\\addplot3[mark=*] file {C:/x.txt};')).toBe('"file"')
  expect(refusedCommand('\\addplot graphics[xmin=0,xmax=1,ymin=0,ymax=1] {C:/x.png};')).toBe('"graphics"')
  expect(refusedCommand('\\pgfplotstabletypeset{C:/x.txt}')).toBe('\\pgfplotstabletypeset')
  // PR #290 review, second round: TikZ's own plot file, the data visualization's
  // reader, a word joined across a comment, and a word kept in a macro
  expect(refusedCommand('\\draw plot file {C:/x.txt};')).toBe('"file"')
  expect(refusedCommand('\\datavisualization data [read from file=C:/x.csv];')).toBe('"file"')
  expect(refusedCommand('\\addplot ta%\n   ble [x=x,y=y] {C:/x.txt};')).toBe('"table"')
  expect(refusedCommand('\\pgfmathsetmacro{\\kw}{"FILE"}')).toBe('"FILE"')
  expect(refusedCommand('\\lowercase{\\draw plot FI}')).toBe('\\lowercase')
  expect(refusedCommand('\\endlinechar=-1 \\draw plot fi\nle {C:/x.txt};')).toBe('\\endlinechar')
  // PR #290 review, third round: macros spliced into what TikZ reads next
  expect(refusedCommand('\\edef\\x{\\noexpand\\draw plot \\a\\b {C:/x.txt};}\\x')).toBe('\\edef')
  expect(refusedCommand('\\expandafter\\y\\x {C:/x.txt}')).toBe('\\expandafter')
  expect(refusedCommand('\\tikzset{p/.expanded={plot \\a\\b {C:/x.txt}}}')).toBe('".expanded"')
  expect(refusedCommand('\\draw[insert path={plot fi}] le {C:/x.txt};')).toBe('"insert path"')
  // PR #290 review, fourth round: a key spelt with two spaces or a line
  // break, and a macro whose arguments join the word; a block now defines
  // no macro and takes no parameter at all
  expect(refusedCommand('\\draw[insert  path={plot fi}] le {C:/x.txt};')).toBe('"insert  path"')
  expect(refusedCommand('\\tikzset{p/.expand\nonce={x}}')).toBe('".expand\nonce"')
  expect(refusedCommand('\\newcommand{\\p}[2]{\\draw plot #1#2 {C:/x.txt};}\\p{fi}{le}')).toBe('\\newcommand')
  expect(refusedCommand('\\tikzset{force/.style={->, thick, #1}}')).toBe('#1')
  expect(refusedCommand('\\def\\L{3}')).toBe('\\def')
  expect(refusedCommand('\\let\\x\\relax')).toBe('\\let')
  expect(refusedCommand('\\NewDocumentCommand{\\p}{m}{x}')).toBe('\\NewDocumentCommand')
  expect(refusedCommand('\\node {Part \\#1};')).toBe(null)
  expect(refusedCommand('\\draw (0,0) -- (1,0) node[left] {$\\left(F\\right)$};')).toBe(null)
  expect(refusedCommand('\\definecolor{steel}{RGB}{70,90,110}')).toBe(null)
  expect(refusedCommand('\\pgfimage{C:/x}')).toBe('\\pgfimage')
  // PR #290 review: expl3 reaches \openin as \tex_openin:D, and the kernel's
  // \UseName and \ExpandArgs build a command from its name
  expect(refusedCommand('\\ExplSyntaxOn \\tex_openin:D 15 = C:/Windows/win.ini')).toBe('\\ExplSyntaxOn')
  expect(refusedCommand('\\UseName{tex_openin:D}')).toBe('\\UseName')
  expect(refusedCommand('\\ExpandArgs{c}\\let\\x{tex_openin:D}')).toBe('\\ExpandArgs')
})

test('a leading \\tikzset over several lines moves to the preamble whole', () => {
  const doc = documentForBlock({ key: 'k', lang: 'tikz', source: '\\tikzset{\n  force/.style={->, thick},\n}\n\\draw[force] (0,0) -- (1,0);' })
  const [preamble, body] = doc.split('\\begin{document}')
  expect(preamble).toContain('force/.style={->, thick},\n}')
  expect(body).toContain('\\begin{tikzpicture}\n\\draw[force] (0,0) -- (1,0);')
  expect(body).not.toContain('tikzset')
})

test('only a MiKTeX install is used, even with another TeX first on PATH', () => {
  const dirs = binCandidates('C:\\texlive\\2026\\bin\\windows;C:\\Users\\me\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64;C:\\Windows', 'C:\\Users\\me\\AppData\\Local')
  expect(dirs).toEqual(['C:\\Users\\me\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64'])
})

test('reads a block as TeX does: a comment drops its line break and the next indent', () => {
  expect(withoutComments('ta%x\n   ble')).toBe('table')
  expect(withoutComments('50\\% done')).toBe('50\\% done')
  expect(withoutComments('a\\\\%c\nb')).toBe('a\\\\b')
  expect(withoutComments('end % last line')).toBe('end ')
})

test('a run that wrote no page shows an error, not the last drawing', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  fakeTex(on, { latexStdout: 'No pages of output.' })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('```tikz\n\\path (0,0);\n```') })
  for (let i = 0; i < 3; i++) await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /wrote no page/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  await ui.unmount()
})

test('a block that draws nothing shows an error, not a blank gap', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  // what dvisvgm 3.6 writes for an empty tikzpicture
  fakeTex(on, { svg: "<svg version='1.1' width='0pt' height='0pt' viewBox='-69.0 -69.0 0 0'></svg>" })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('```tikz\n\\tikzset{every node/.style={draw}}\n```') })
  for (let i = 0; i < 3; i++) await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /draws nothing/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  await ui.unmount()
})

test('a drawing over the size the app takes shows an error in its place', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  fakeTex(on, { svg: `<svg width='9pt' height='9pt'><path d='${'M0 0L1 1'.repeat(17000)}'/></svg>` })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('```tikz\n\\draw plot coordinates {(0,0) (1,1)};\n```') })
  for (let i = 0; i < 3; i++) await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /The app draws at most 128 KB/ })).toBeDefined()
  await ui.unmount()
})

test('tikz-cd and latex fences stay code; only tikz compiles', { options: { compileBlocks: true } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  const { runs } = fakeTex(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const text = '```tikzcd\nA \\arrow[r] & B\n```\n\n```latex\n\\textbf{x}\n```\n\nThen $x^2$.'
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  for (let i = 0; i < 3; i++) await clock.advance(100)
  expect(texRuns(runs)).toHaveLength(0)
  expect(await ui.find({ type: 'Markdown', text: /tikzcd/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('by default compiling is off: tikz blocks stay code and TeX is never looked for', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, ENV)
  const { runs } = fakeTex(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await settle(clock)
  const ui = await $.ui.mount({ plugin: 'study-latex', surface: 'desktop', component: 'AssistantMessage', props: reply('```tikz\n\\draw (0,0) -- (1,0);\n```\n\nThen $x^2$.') })
  for (let i = 0; i < 3; i++) await clock.advance(100)
  expect(runs).toHaveLength(0)
  expect(await ui.find({ type: 'Markdown', text: /\\draw/ })).toBeDefined()
  await ui.unmount()
})
