# Study LaTeX for Claude Code

**[한국어 안내는 아래에 있어요](#한국어-안내)**

In the Code tab of the Claude desktop app, only display blocks (`$$...$$` on their own lines) are
drawn as math; inline math in a sentence shows as raw source
([anthropics/claude-code#65632](https://github.com/anthropics/claude-code/issues/65632)). For anyone
who studies with Claude (engineering, physics, maths) that makes every explanation harder to read.

This mod draws inline and display TeX math in Claude's replies as typeset formulas, tells Claude to
write math that way, and, on Windows with MiKTeX, can compile TikZ figures such as free-body diagrams
and plots. It was built by an engineering student who studies with Claude every day. It is a fork of
[zaahiral/claude-latex](https://github.com/zaahiral/claude-latex) 0.5.0 (MIT).

## What you get

- Inline `$...$` and `\(...\)`, display `$$...$$`, `\[...\]` and `equation`/`align` environments,
  drawn by MathJax 3.2.2, which runs inside the mod with no file, process or network access.
- Tables with math, and `\div` as the division sign (the bundled physics package would otherwise
  draw it as a divergence).
- Claude is told, in one short section of its instructions, how to write math so it renders: symbols
  inline, equations and fractions as display blocks. You do not need to prompt it.
- Optional, **off by default**: ` ```tikz ` code blocks compiled into figures with your MiKTeX.
- Only replies in the desktop Code tab are redrawn. The terminal, the VS Code extension, the phone
  and your own messages keep the app's own drawing.

## Requirements

- The Code tab of the Claude desktop app, with Claude Code 2.1.287 or later (the first version with
  mods). Tested with 2.1.295 and 2.1.296 on Windows 11.
- For TikZ figures only: Windows and [MiKTeX](https://miktex.org/) (`latex.exe` and `dvisvgm.exe`;
  MiKTeX's per-user install folder is found by itself). Math needs nothing else. On macOS, the
  upstream mod compiles TikZ inside a macOS sandbox.

## Install

In a terminal:

```sh
claude plugin marketplace add yeonwooook/claude-study-latex
claude plugin install study-latex@claude-study-latex
```

Then start a new session in the desktop app. Claude's instructions about math arrive with the first
message of a session, so a session that was already open keeps writing math the old way. To check,
ask Claude to write the stress σ with subscript x inline in a sentence.

To update later: `claude plugin update study-latex@claude-study-latex`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Math color (`colorScheme`) | `auto` | `auto` follows the system's light or dark setting; pick `light` or `dark` if the app's theme differs |
| Compile TikZ blocks (`compileBlocks`) | off | On, ` ```tikz ` blocks in replies are compiled with your MiKTeX. Read [Safety](#safety) first |

Change them with `claude plugin configure study-latex@claude-study-latex` in a terminal, then start
a new session.

## Figures (when TikZ compiling is on)

A ` ```tikz ` block holds the inside of a `tikzpicture` (or a whole one). Claude is told the rules;
for reference:

- **Plain TikZ only**: no macro definitions (`\def`, `\newcommand`, `\let`), no `#` parameters, no
  `\edef` or `\expandafter`, no `\usepackage`, no file access, and never the words `file`, `table`
  or `graphics`, not even in labels. Numbers go in `\pgfmathsetmacro`, plot data in
  `coordinates {...}`. A block that breaks a rule shows an error in place of the figure.
- Leading `\usetikzlibrary`, `\tikzset`, `\pgfplotsset` and `\definecolor` lines go to the
  preamble, which is fixed: amsmath, amssymb, bm, xcolor, tikz and pgfplots with the common TikZ
  libraries. `tikzcd` and `latex` code blocks stay code.
- At most 4 to 6 figures in one reply. A figure compiles in about a second once MiKTeX is warm (the
  first one after a restart can take ten) and is cached in `%LOCALAPPDATA%\claude-study-latex`.

## Safety

The math path reads no file, runs no program and uses no network.

Compiling TikZ runs MiKTeX on your computer for text that Claude wrote, and Claude's replies can be
shaped by what it reads (a web page, a file, an issue comment). So every block is treated as
untrusted:

| Layer | What it stops |
|---|---|
| A screen in `hooks/texjobs.ts`, applied to the block as TeX reads it | file-access commands, ways of spelling a command or a word from other text, macro definitions, `#` parameters, macro splicing, packages, and the words `file`, `table`, `graphics` |
| `-disable-write18`, `-disable-installer` | running programs; MiKTeX downloading a missing package |
| `MIKTEX_CORE_ALLOWUNSAFEINPUTFILES=false`, `..._OUTPUTFILES=false` | `\input` and `\openout` outside the build folder |
| `dvisvgm --no-specials=ps` | Ghostscript |
| 60 s per program, 128 KB per figure, about 235 KB per reply | runaway blocks and drawings the app would drop |

What is left: TeX's `\openin` reads a file by its full path under every MiKTeX setting, and the
screen that stops it is a list, which can miss a spelling. A missed one could make TeX read a file
and show part of it in the figure, on your screen only; TeX still cannot write outside its folder,
run a program, install a package or reach the network, and Claude never sees the figure. There is
no operating-system sandbox on Windows. That is why compiling is off by default. `dvisvgm` has no
switch to turn MiKTeX's automatic install off; it reads the outlines of fonts whose metrics `latex`
found with the installer off. `claude plugin validate` lists every call the mod makes.

## Limits

- Desktop Code tab only (the terminal cannot draw SVG; the VS Code extension and `claude -p` do not
  draw mods).
- About 235 KB of drawing per reply, roughly 75 formulas or 4 to 6 figures; past it the app draws
  the rest of the reply itself.
- Your own messages are not redrawn.

## For your own hooks

While the mod draws, every program the session starts, your settings hooks included, sees
`STUDY_LATEX_MOD=1`. A hook that checks Claude's math notation can use it to allow inline TeX.

## Changes from upstream

Kept: the parser (`hooks/parse.ts`), the drawing (`hooks/draw.tsx`), the MathJax bundle and its
build script (`mathjax-build/`, upstream's `build/`). Changed: `\div` set back to the division sign;
the TikZ compile rewritten for Windows and MiKTeX with the screen above; a note to Claude about how
to write math; the desktop surface only. Dropped: your-message rendering, the `/latex` pane and
welcome band, the LaTeX math fonts, the Copy TeX button, saved LaTeX formats and the `tikzcd` and
`latex` blocks.

## Development

```sh
claude plugin validate .
claude plugin test .
```

`mathjax-build/build.sh` rebuilds the bundle from npm `mathjax-full` 3.2.2 (needs npm and Bun).

## License

MIT, see `LICENSE`; the upstream copyright notice is kept. MathJax is Apache 2.0
(`hooks/mathjax/LICENSE`).

---

## 한국어 안내

Claude 데스크톱 앱의 Code tab은 줄 단독 수식(`$$...$$`)만 수식으로 그리고, 문장 속 inline 수식은
원래 코드 그대로 보여줘요. Claude로 공부하는 공대생에게는 설명을 읽기가 훨씬 불편해지는 문제예요.

이 mod를 설치하면 Claude의 답에 들어 있는 inline 수식과 줄 단독 수식이 모두 제대로 된 수식으로
그려지고, Claude도 그렇게 쓰도록 안내받아요. Windows에 MiKTeX가 있으면 free-body diagram이나
그래프 같은 TikZ 그림도 그릴 수 있어요. Claude로 매일 공부하는 공대생이 만든 mod이고,
[zaahiral/claude-latex](https://github.com/zaahiral/claude-latex) 0.5.0(MIT)을 바탕으로 했어요.

### 설치

터미널에서:

```sh
claude plugin marketplace add yeonwooook/claude-study-latex
claude plugin install study-latex@claude-study-latex
```

설치한 뒤에는 데스크톱 앱에서 **새 세션**을 열어야 해요. 수식 작성법 안내가 세션의 첫 메시지와
함께 Claude에게 전달되기 때문이에요. 확인하려면 "응력 σ_x를 문장 안에 inline으로 써봐"라고
물어보면 돼요.

### 필요한 것

- Claude 데스크톱 앱의 Code tab, Claude Code 2.1.287 이상
- TikZ 그림을 쓸 때만: Windows와 MiKTeX. 수식만 쓸 때는 다른 게 필요 없어요.

### 설정

- **Math color**: 기본 `auto`(시스템의 밝은/어두운 모드를 따름). 앱 테마가 시스템과 다르면
  `light`나 `dark`로 바꿔요.
- **Compile TikZ blocks**: 기본 **꺼짐**. 켜려면 아래 안전 안내를 먼저 읽어 주세요.

바꾸는 방법: 터미널에서 `claude plugin configure study-latex@claude-study-latex`를 실행한 뒤 새 세션을
열어요.

### 안전 (TikZ를 켜기 전에)

수식을 그리는 부분은 파일을 읽거나 프로그램을 실행하지 않아요. TikZ compile은 Claude가 쓴 코드를
내 컴퓨터의 MiKTeX로 실행하는데, Claude의 답은 Claude가 읽은 웹페이지나 파일의 영향을 받을 수
있어요. 그래서 위험한 명령은 막아 두었어요(파일 접근, 매크로 정의, 패키지, 외부 프로그램, 네트워크).
다만 차단 목록은 완벽할 수 없어서, 놓친 경우에는 TeX가 내 컴퓨터의 파일 일부를 읽어 그림 안에 보여줄 수
있어요. 이 내용은 내 화면에만 보이고, 밖으로 전송되지 않으며, Claude도 그 그림을 보지 못해요. 그래서
기본값을 꺼 두었어요.

### 한계

- 데스크톱 앱의 Code tab에서만 그려져요(터미널, VS Code, 폰은 원래대로 보여요).
- 한 답에 수식 약 75개 또는 그림 4~6개까지예요. 넘으면 나머지는 앱이 원래대로 그려요.
- 내가 보낸 메시지의 수식은 그대로 보여요.
