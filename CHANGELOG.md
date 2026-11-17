# Changelog

## 0.2.1

The npm package is now published as **`dsh-pdf-zh`**: the name `dsh-pdf-translate` on npm is held by another
account, so 0.2.1 is the first release under the new name. The repository, the Loader row id (`pdf-translate`)
and the tools are unchanged.

Fixes found while running the plugin end to end against a local `llama-server` (HY-MT 1.8B / 7B)
on Windows.

### Fixed

- **`md` and `pdf` routes failed with `ReferenceError: cwd is not defined`.** `execute()` passed an
  undefined `cwd` to `resolvePython()`, so every translation request threw before touching the PDF
  and the tool reported only `1 failed`. It is now taken from `exec.cwd`, falling back to the
  process working directory.
- **Every paragraph was translated from the string `[object Object]`.** `translateParagraphs()`
  iterated `paragraphs` with `(text, index) => …`, but each entry is `{ page, text }`, so the
  paragraph object was interpolated into the prompt. The model dutifully translated
  `[object Object]`, which is why a 1.8B HY-MT answered `[对象]` / `[对象对象]` for whole
  documents. The text field is now read from the paragraph.
- **The layout-preserving PDF came out in Traditional Chinese.** The `pdf` route passed
  `-lo zh` with pdf2zh's default prompt, so the model answered in 繁体 (肝細胞 / 我們 / 這). It now
  passes `-lo zh-CN` and points the OpenAI-compatible backends (`local`, `deepseek`) at
  `lib/zh_cn_prompt.txt`, which asks for Simplified Chinese only.

### Notes

- The `free` (Google/Bing) route is unchanged: the custom prompt is only injected for the
  OpenAI-compatible backends, where it is meaningful.
- `pdf_translate` still renders only its summary line, so a per-file `error` is not shown in the
  transcript; it remains available in the tool's structured result.
