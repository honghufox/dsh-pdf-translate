# dsh-pdf-translate

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) plugin that turns English
scientific PDFs into Chinese — a layout-preserving bilingual PDF, a bilingual Markdown draft you can quote from, and a
GPU-aware recommendation of which local translation model your card can actually run.

Registers three tools:

| Tool | What it does |
|---|---|
| `pdf_translate` | `to: pdf` → bilingual/monolingual PDF with formulas, figures and two-column layout intact (via [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate)). `to: md` → per-paragraph English/Chinese Markdown. `to: both` |
| `pdf_pick_model` | Reads the GPU model and VRAM (`nvidia-smi`, then WMI, then the PCI registry key) and ranks the quantized [Hunyuan HY-MT](https://github.com/Tencent-Hunyuan/HY-MT) models that fit entirely on that card, with the exact download and `llama-server` command |
| `pdf_translate_doctor` | Reports the managed Python environment, `pdf2zh`, the session model, the local inference server, the DeepSeek key and the translation cache |

## Translation routes

| `engine` | Cost | Notes |
|---|---|---|
| `local` | **free after the download** | Any OpenAI-compatible endpoint — `llama-server`, Ollama, LM Studio — serving a HY-MT GGUF. The only route that can also feed the PDF layout pass while staying offline |
| `dsh` | token cost of the session model | Reuses the model already selected in the Harness, so **no extra API key**. Markdown output only: the PDF pass needs an OpenAI-compatible endpoint |
| `deepseek` | very low | DeepSeek API, direct connection. A 30-page paper lands around ¥0.3–0.5 |
| `free` | 0 | The free Google/Bing endpoints bundled with `pdf2zh`. **Unreachable on some networks** — `translate.google.com` and `www.bing.com` fail with SSL EOF there, and `translate.googleapis.com` returns 429 without a key |

`engine: auto` (the default) resolves to `local` → `deepseek` → `dsh`.

## Requirements

- DeepSeek Harness with the **Tools** capability (any normal agent preset).
- Python 3.12 with `pdf2zh` and `pymupdf`. The plugin looks for it at `$DSH_HOME/pdf-translate/venv`, or wherever
  `pythonPath` in the plugin config points.

```powershell
uv venv --python 3.12 "$env:DSH_HOME\pdf-translate\venv"
uv pip install --python "$env:DSH_HOME\pdf-translate\venv\Scripts\python.exe" pdf2zh "bitstring<5" pymupdf
```

Two pins are load-bearing, and `lib/pdf2zh_launch.py` documents both:

- **`bitstring<5`** — babeldoc still imports `BitStream`, which bitstring 5 renamed to `Bits`; without the pin
  `pdf2zh` dies at import time.
- **Bracketed IPv6 entries in `NO_PROXY`** — Windows proxy tools (Clash, V2RayN) export a `NO_PROXY` list containing
  `[::1]`. `httpx` parses each entry as a URL and raises `InvalidURL: Invalid port: ':1]'`, and `pdf2zh` builds an
  `ollama` client at import time. The launcher strips bracket entries before importing.

## Install the plugin

```
Plugins → Add plugin → pick this directory
```

or from the CLI with the Plugin Manager pointed at the checkout directory. The bundle inserts one Loader row named
`pdf-translate`.

## Choosing a local model

Run `pdf_pick_model` — it reads the actual card and returns commands you can paste. The bundled catalog:

| Model | Download | Fits entirely on | Notes |
|---|---|---|---|
| Hy-MT2-1.8B · 1.25bit | 0.43 GB | ≥1 GB | Smallest. Needs a llama.cpp kernel that is not on mainline yet, so it requires a self-built binary |
| HY-MT1.5-1.8B · Q4_K_M | 1.06 GB | ≥2 GB | Runs on 2 GB or on CPU |
| HY-MT1.5-1.8B · Q6_K | 1.37 GB | ≥3 GB | **Best pick for a 4 GB card** — fastest and the quantisation is essentially lossless |
| HY-MT1.5-1.8B · Q8_0 | 1.78 GB | ≥4 GB | Largest 1.8B quant worth running |
| HY-MT1.5-7B · Q4_K_M | 4.31 GB | ≥6 GB | Clear quality gain over 1.8B |
| Hy-MT2-7B · Q4_K_M | 4.31 GB | ≥6 GB | Newer generation, stronger instruction following. `--jinja` is mandatory so the bundled chat template is used |
| Hy-MT2-7B · Q5_K_M | 5.05 GB (est.) | ≥8 GB | Sweet spot for 8 GB+ |
| Hy-MT2-7B · Q8_0 | 7.66 GB (est.) | ≥10 GB | Near-bf16 quality; the right tier for a 16 GB card |

Sizes are the GGUF downloads; entries marked *est.* are derived from the verified Q4_K_M size. Then point the plugin at
the server:

```yaml
localBaseUrl: http://127.0.0.1:9931/v1
localModel: hymt
```

## Biomedical text

There is **no trustworthy open translation model specialised for English→Chinese biomedical text**. The reliable
approach is a strong general translation model plus terminology constraints, and that is what the plugin does: the
`md` route injects a built-in glossary (~55 terms: macrophage 巨噬细胞, antigen presentation 抗原呈递, progression-free
survival 无进展生存期, single-cell RNA sequencing 单细胞 RNA 测序, …) and instructs the model to preserve gene and protein
symbols, abbreviations and statistical notation verbatim.

Replace or extend `BIOMED_GLOSSARY` in `index.js` — it is a plain `[english, chinese]` array. Authoritative sources to
build a larger list from: **MeSH** (free, but its Chinese translation file is outside the redistribution terms), **ICD-11
Chinese** (CC BY-ND 3.0 IGO — no derivatives), and 术语在线 (bulk download licensing unconfirmed). Check each licence
before importing.

HY-MT also supports terminology intervention in the prompt itself:

```
参考下面的翻译：
{source_term} 翻译成 {target_term}

将以下文本翻译为{target_language}，注意只需要输出翻译后的结果，不要额外解释：
{source_text}
```

## Why it is cheap

1. **Text is extracted locally** (PyMuPDF, layout-block aware). Page images are never sent to a model, and image tokens
   cost an order of magnitude more than the same text.
2. **Paragraphs are batched** into single requests (~3500 characters each), amortising the system prompt.
3. **Every finished paragraph is cached on disk** — `$DSH_HOME/pdf-translate/cache.json`, keyed by engine, model and
   source hash. Repeated sentences, running heads and boilerplate are translated once. `force: true` bypasses it.
4. **Reference lists are skipped**, since nobody reads a translated bibliography.
5. `pdf2zh` keeps its own translation cache, so re-running a paper costs nothing.

## Limitations

- English → Simplified Chinese only; other directions are untested.
- Scanned (image-only) PDFs need OCR. `pdf2zh` has experimental OCR support, but this plugin does not enable it, and the
  `md` route will find no text.
- The glossary reaches the `md` route only; the `pdf` route is limited to `pdf2zh`'s own prompting.
- Interpreter discovery assumes a Windows layout (`venv/Scripts/python.exe`). Linux and macOS need `pythonPath` set.
- Machine output. Verify numbers, gene names and units against the source before quoting.

## Development

```bash
node scripts/check-plugin.mjs            # registration + recommendation table
node scripts/check-plugin.mjs paper.pdf  # also exercise the extractor
```

`scripts/check-plugin.mjs` runs the tools against a stub registry, so it needs no live Harness session. It reads
`PDF_TRANSLATE_PYTHON` for the interpreter.

## License

MIT.

## 中文速览

把英文科研 PDF 翻成中文的 DSH 插件，三个工具：`pdf_translate`（保留排版的双语 PDF / 逐段双语 Markdown）、
`pdf_pick_model`（读显卡显存，推荐能全量上卡的本地模型并给出下载与启动命令）、`pdf_translate_doctor`（环境自检）。

装法：先备好 Python 3.12 环境（`uv pip install pdf2zh "bitstring<5" pymupdf`），再到 Plugins → Add plugin 选本目录。

翻译通道：`local`（本地 llama-server 跑 HY-MT，下载后免费）、`dsh`（复用会话模型，不必另配 key）、
`deepseek`（便宜、直连）、`free`（pdf2zh 内置免费接口，部分网络不通）。

省 token 靠四件事：本地抽文本不发图、多段合并成一次请求、每段译文落盘缓存、自动跳过参考文献。

详见 [docs/DETAIL.md](docs/DETAIL.md)。
