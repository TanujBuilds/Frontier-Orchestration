# Terminal display-width qualification

Qualified on 2026-11-17 with **Node v24.22.0**, ICU 78.3, Unicode 17.0,
on macOS arm64. This is a measured source and owned-PTY fixture result.
The M019 owner-workflow gate still depends on M009; this qualification does
not close either external gate.

## Measurement contract

The observer sanitizes input before measuring, wrapping, clipping or padding.
It segments sanitized text with `Intl.Segmenter` at grapheme boundaries and
counts cells after NFC normalization. The same scoped cell model is used for
word-wrap remainders, labels, rules, badges, picker columns and feed prefixes.
Sanitized output retains its original Unicode spelling. A grapheme that exceeds
the entire available column is replaced with `�` (one measured cell), rather
than emitting part of that grapheme. For example, a long consonant/virama
conjunct or an eight-cell family in a six-cell picker column uses this fallback.

The independent test oracle uses only public `Console` and `Writable` APIs.
`Console.table({[specimen]: null, [asciiSentinel]: null})` prints the specimen
literally as an index key. A 2048-character ASCII sentinel fixes that column's
width. Subtracting the specimen's trailing ASCII padding from the sentinel's
padding gives its display-cell width. Tests verify the literal row and padding;
they do not import an internal Node width API or the observer's measurement
helper. Rendered line dimensions are checked with this oracle, including frames
captured from the PTY. The specimen oracle excludes newline and `│` keys.

The declared matrix contains these **26 measured specimens**:

| Specimen | Code points | Cells |
| --- | --- | ---: |
| ASCII `A` | U+0041 | 1 |
| Fullwidth `Ａ` | U+FF21 | 2 |
| Fullwidth `！` | U+FF01 | 2 |
| Ideographic space | U+3000 | 2 |
| Han `界` | U+754C | 2 |
| Hangul `가` | U+AC00 | 2 |
| Decomposed Hangul `가` | U+1100 U+1161 | 2 |
| Halfwidth Katakana `ｶ` | U+FF76 | 1 |
| Combining `é` | U+0065 U+0301 | 1 |
| Isolated combining accent | U+0301 | 0 |
| Devanagari `का` | U+0915 U+093E | 2 |
| Devanagari `क्` | U+0915 U+094D | 1 |
| Emoji `😀` | U+1F600 | 2 |
| ZWJ emoji `👩‍💻` | U+1F469 U+200D U+1F4BB | 4 |
| Flag `🇺🇸` | U+1F1FA U+1F1F8 | 4 |
| Modifier `👍🏽` | U+1F44D U+1F3FD | 4 |
| Family `👨‍👩‍👧‍👦` | U+1F468 U+200D U+1F469 U+200D U+1F467 U+200D U+1F466 | 8 |
| Keycap `1️⃣` | U+0031 U+FE0F U+20E3 | 1 |
| Text pictograph `☀` | U+2600 | 1 |
| Pictograph with variation `☀️` | U+2600 U+FE0F | 1 |
| Zero-width joiner | U+200D | 0 |
| Zero-width space | U+200B | 0 |
| Soft hyphen | U+00AD | 1 |
| Ambiguous-width `Ω` | U+03A9 | 1 |
| Rule `─` | U+2500 | 1 |
| Ellipsis `…` | U+2026 | 1 |

Node's table contract counts the constituent cells of the selected emoji
sequences. A terminal may instead draw the entire ZWJ emoji, flag or family in
two cells; emoji presentation and ambiguous characters also depend on fonts,
locale and emulator. This matrix promises no universal `wcwidth` result,
exhaustive Unicode coverage, bidirectional shaping, cursor-position measurement,
or compatibility certification for another Node/ICU version or terminal.
Remeasure the matrix and rendered frames when changing the runtime. The scoped
range algorithm is not a complete Unicode East Asian Width database.

## Reproduction and checks

The accepted source rendered an objective of sixty U+FF21 characters at width
20, height 20, with color and interaction disabled. Its continuation lines
contained twenty fullwidth characters: **40 measured cells in a 20-cell frame**.
The first title line also overflowed. The regression measures cells rather than
JavaScript string length. The corrected reproduction fits every line within
20 cells and retains the objective.

Run with the pinned runtime selected as `node`:

```sh
node --version # v24.22.0
node --test --test-concurrency=1 test/mosaic-m019-terminal-width.test.mjs test/beta-observer.test.mjs test/beta-sources.test.mjs test/beta-current.test.mjs
```

The focused run passed **65/65 checks**, with no failures, cancellations or
skips on the qualified host. Coverage includes plain, compact, polished,
picker and evidence views; 8-, 20-, 55-, 56-, 80- and 110-column specimens;
mixed-width word wrapping, including space-based combining graphemes; exact
packing of selected graphemes; cell-aware
padding and feed provenance; unknown wide labels; and ANSI, OSC, C1 control,
unterminated escape and bidi-control sanitization. Only renderer-owned SGR
escapes survive in color frames. Existing observer history, reconnect, current
selection and source-routing checks remain part of the focused command.

Two finite Python 3 PTY fixtures exercise the actual `runObserver` function with
synthetic read-only snapshot/timeline responses. They allocate their own PTY,
launch one Node child in its own process group, select the fifth assignment,
resize 80×36 → 20×10 → 55×24, then send `q` or raw Ctrl-C. Every captured
frame is measured by the independent oracle. The narrow frame retains the
selected assignment and saved handoff. Checks confirm raw mode during the run,
restored termios/raw state, alternate-screen exit, restored cursor, removed
observer listeners and an absent owned process group after exit. The driver
uses a 12-second readiness deadline, a 2 MiB capture ceiling and owned-group
cleanup; it never targets the caller's interactive terminal. The two new PTY
checks are macOS-specific and explicitly skip elsewhere.

This result does not qualify a real owner project, live provider/model, actual
host pilot, clean Mac, other platform, packaged installation or broad terminal
matrix. It changes no coordinator state, approval, routing or native policy.
Combined source and distribution qualification remains a separate ROOT step.
