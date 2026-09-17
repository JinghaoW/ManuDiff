# Simple LaTeX Diff for Manuscript Revisions

[简体中文](README.md) | **English**

Compare an original and a revised `.tex` file and generate a LaTeX document with visible revision marks. Deleted text appears in **red with a strikeout**, replacement text in **blue**, and newly inserted text in **blue with an underline**. The tool also handles selected math, citation, figure, and table changes.

## Use the browser interface

Open `index.html` directly in a browser. Select the **Original** and **New** `.tex` files, choose a minimum word count from **1 to 10** with the slider (default: 1), and click **Generate and download**. The browser downloads `tex_difference.tex`. Files are read and processed locally; no server or installation is required for this step.

**Try the web here** [https://jinghaow.github.io/ManuDiff/](https://jinghaow.github.io/ManuDiff/)

To try the interface, upload `examples/sample_org.tex` and `examples/sample_rev.tex`. Their figure assets, `examples/figure_org.png` and `examples/figure_rev.png`, must remain alongside the generated `.tex` file when you compile it. A pre-generated result at the default threshold is available as `examples/tex_difference.tex`.

### Installation links

- ## **Browser-only `.tex` generation:** no project dependencies, Node.js, or LaTeX installation is needed.
- **Command-line use and tests:** install [Node.js from the official download page](https://nodejs.org/en/download) (version 18 or later).
- **PDF compilation:** install one LaTeX distribution, such as [MiKTeX for Windows](https://miktex.org/download) or [TeX Live](https://tug.org/texlive/acquire-netinstall.html). You do not need both.
- **Required LaTeX packages:** [xcolor](https://ctan.org/pkg/xcolor), [ulem](https://ctan.org/pkg/ulem), and [cancel](https://ctan.org/pkg/cancel). These CTAN pages provide package information and downloads; packages are usually managed through your LaTeX distribution. The sample manuscript also uses [amsmath](https://ctan.org/pkg/amsmath) and [graphicx](https://ctan.org/pkg/graphicx).

## Compile the result

Put `tex_difference.tex` in the appropriate directory of your LaTeX project so relative paths to figures and bibliography files still work. Compile it with the same engine and build steps as the original manuscript. For a simple pdfLaTeX project:

```sh
pdflatex tex_difference.tex
```

This normally produces `tex_difference.pdf`. The generated source uses the `xcolor`, `ulem`, and `cancel` packages, which must be available in your LaTeX installation. If your manuscript uses XeLaTeX or LuaLaTeX, continue using that engine. Run any bibliography or cross-reference passes your project normally requires.

The example shown in the browser is an illustration of the marks, not a live preview of your uploaded files. Always inspect the compiled PDF before submitting it.

## How changes are marked 

| Change | Mark in the compiled PDF |
| --- | --- |
| Deleted ordinary text | Red strikeout |
| Text replacing an earlier passage | Old text: red strikeout; new text: blue |
| Pure text insertion | Blue underline |
| Changed inline math (`$...$`, `\(...\)`) | Old expression: red cancellation; new expression: blue |
| Added inline math | Blue underline |
| Changed display math (`\[...\]`, `equation`, `align`, `gather`, `multline`) | Old expression: red and unnumbered; new expression: blue, with its original number and label retained |
| Changed `\cite` or common `\ref` command | Old rendered citation/reference: red strikeout; new one: blue |
| Changed `\includegraphics` command | Red note with the previous image filename, blue note, and the revised image |
| Figure captions and table cell text | Same word-level marks as ordinary text |

The Sample figure:

<img src="examples/Sample figure.PNG" width="50%">

The minimum word count applies **only to ordinary text**. It means that at least that many word tokens on either side of one contiguous edit must change before the edit is marked. Smaller text edits use the revised wording without visible marks. Supported formula, citation, and image-command changes are treated as individual changes regardless of the slider value.

A word token is a run of Unicode letters or digits. The tool does not perform language-aware word segmentation, so a Chinese phrase without spaces may count as a single token.

The tool compares image commands and filenames; it does **not** compare image pixels. If an old citation key or reference label is no longer resolvable in the revised project, the old citation/reference may appear as `?` in the PDF.

## Command-line use

The command-line tool requires Node.js 18 or later:

```sh
node simple-latex-diff.js old.tex new.tex --min-words 1 -o comparison.tex
```

`--min-words` accepts an integer from `1` to `10` and defaults to `1`. If `-o` is omitted, the output is saved beside the revised file as `NEWNAME_diff.tex`.

Run the checks with:

```sh
node --test simple-latex-diff.test.js
```

## Scope and limitations

- Both inputs must be complete `.tex` documents with `\begin{document}` and `\end{document}`. The output uses the **revised** preamble and document structure.
- Comments, labels, code environments, and unsupported custom commands generally use the revised version without a visible mark. Whole-figure or whole-table insertion/deletion, table layout changes, and complex macros require manual review.
- `\input` and `\include` files are not expanded. Compare or combine those files separately if they contain revised text.
- The interface and CLI report a count for some detected structural changes that could not be marked. This count is not a complete audit of unmarked changes; review the source and compiled PDF.
- The comparison treats words, whitespace, punctuation, and some LaTeX structures as separate tokens. If the shortest edit sequence requires **more than 1,000 token insertions/deletions**, the tool stops to limit memory use. This is not a 1,000-word limit. For broader LaTeX syntax and complex projects, use [latexdiff](https://github.com/ftilmann/latexdiff/).
- The automated tests check the generated source but do not compile a PDF. Compile and inspect the result with your manuscript's toolchain, especially for complex math, citation styles, and floats.

This tool is intended to help prepare a manuscript with tracked changes. Check the target journal's specific submission instructions and review the final PDF before uploading it.

If you find this tool useful, please give the GitHub repository a star!
