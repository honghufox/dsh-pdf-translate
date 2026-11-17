# PDF 文献翻译

把英文科研 PDF 变成中文，三条路子一套工具：

| 你要的 | 用哪个工具 / 参数 | 说明 |
|---|---|---|
| 中英对照翻着读 | `pdf_translate` → `to: pdf` | 保留公式、图表、双栏版面的双语 PDF，来自 PDFMathTranslate（`pdf2zh`） |
| 写综述要引用、贴进文档 | `pdf_translate` → `to: md` | 逐段英中对照的 Markdown，段落结构干净，方便摘句子 |
| 两样都要 | `to: both`（默认） | 一次生成两套产物 |
| 换台电脑/换显卡，挑本地模型 | `pdf_pick_model` | 读显卡型号与显存，列出能全量上卡的模型和启动命令 |
| 排查环境 | `pdf_translate_doctor` | 报 Python 环境、pdf2zh、当前会话模型、本地服务、缓存状态 |

## 翻译通道

| engine | 成本 | 说明 |
|---|---|---|
| `local` | **下载后免费** | 本机 `llama-server` / Ollama / LM Studio 的 OpenAI 兼容端点，跑腾讯混元 HY-MT 系列 GGUF |
| `dsh` | 按会话模型的 token 计费 | 直接复用当前会话已选的大模型，**不需要另配 key**；只用 `to: md`，因为 PDF 排版通道需要一个 OpenAI 兼容端点 |
| `deepseek` | 极低 | DeepSeek 官方 API，直连（不走代理）。30 页论文量级约 ¥0.3–0.5 |
| `free` | 0 | pdf2zh 内置的 Google / Bing 免费接口。**在受限网络下实测不通**（`translate.google.com`、`www.bing.com` 都是 SSL EOF；`translate.googleapis.com` 能连通但返回 429 限流）。只在能正常访问 Google 的环境里用 |

`engine: auto`（默认）的优先级：`local` → `deepseek` → `dsh`。

## 本地模型怎么选

运行 `pdf_pick_model`，插件会调 `nvidia-smi` 读型号和显存，然后按「能全量上卡的最大档位」排序。内置目录（体积为 GGUF 下载大小）：

| 模型 | 体积 | 全量上卡需要 | 备注 |
|---|---|---|---|
| Hy-MT2-1.8B · 1.25bit | 0.43 GB | ≥1 GB | 最小；但需要尚未并入 llama.cpp 主线的 STQ 内核，要自编译 |
| HY-MT1.5-1.8B · Q4_K_M | 1.06 GB | ≥2 GB | 2G 显存或纯 CPU 都能跑 |
| HY-MT1.5-1.8B · Q6_K | 1.37 GB | ≥3 GB | **4G 显卡（1650 级）首选**：速度最快、量化损失可忽略 |
| HY-MT1.5-1.8B · Q8_0 | 1.78 GB | ≥4 GB | 4G 显存刚好全量上卡 |
| HY-MT1.5-7B · Q4_K_M | 4.31 GB | ≥6 GB | 质量明显好于 1.8B；4G 卡只能部分 offload |
| Hy-MT2-7B · Q4_K_M | 4.31 GB | ≥6 GB | 2026 新代，指令跟随更强，启动必须加 `--jinja` |
| Hy-MT2-7B · Q5_K_M | 5.05 GB（估算） | ≥8 GB | 8G+ 的甜点位 |
| Hy-MT2-7B · Q8_0 | 7.66 GB（估算） | ≥10 GB | 接近 bf16 质量；**16G 显卡（4060 Ti）推荐这档** |

`pdf_pick_model` 给出的命令形如：

```powershell
hf download tencent/Hy-MT2-7B-GGUF --include "*Q5_K_M*.gguf" --local-dir ./models
llama-server -m <对应 gguf> --host 127.0.0.1 --port 9931 -ngl 99 -c 4096 -b 1024 -ub 256 -np 1 --jinja
```

然后把本地服务的地址填进插件配置：`localBaseUrl: http://127.0.0.1:9931/v1`、`localModel: hymt`。

## 生物医学领域怎么办

**没有可靠的、开源的、专门做生物医学英→中的翻译模型**，别去赌 HF 上那些自称「医疗专用」的小模型。可靠做法是「通用强翻译模型 + 术语约束」：

- `to: md` 通道会在 system prompt 里注入一份内置生物医学术语表（巨噬细胞、抗原呈递、总生存期、单细胞 RNA 测序……约 55 条），并对模型说明「基因/蛋白符号、缩写、统计记号原样保留」。
- 想换成自己的术语表，改 `index.js` 里的 `BIOMED_GLOSSARY`；格式是 `[英文, 中文]` 数组，按需增删即可。
- 权威来源可参考 MeSH（免费，但 MTMS 中文译本不在其条款覆盖范围）、ICD-11 中文（CC BY-ND 3.0 IGO，禁止改编）、全国名词委「术语在线」。**这些都需要你自己确认授权后再导入。**

## 省 token 的设计

1. **文本提取完全在本地做**（PyMuPDF 按版面块抽文字），不把页面图片发给模型——图片 token 是纯文字的几十倍。
2. **多段合并成一次请求**，按字符预算打包（默认约 3500 字符/请求），摊薄 system prompt 的重复开销。
3. **磁盘缓存**：每段译文的 hash 存到 `$DSH_HOME/pdf-translate/cache.json`，重复的句子/表头/参考文献条目只翻一次。`force: true` 才会绕过缓存。
4. **自动跳过参考文献段**，不把整段参考文献送去翻译。
5. pdf2zh 自带翻译缓存，同一篇重复跑也不会重复计费。

## 环境要求

插件需要一个装了 `pdf2zh` 的 Python 3.12 环境，默认找 `$DSH_HOME/pdf-translate/venv`。装法（`uv` 比 pip 快得多）：

```powershell
uv venv --python 3.12 "$env:DSH_HOME\pdf-translate\venv"
uv pip install --python "$env:DSH_HOME\pdf-translate\venv\Scripts\python.exe" pdf2zh "bitstring<5" pymupdf
```

两个必须的约束，都已在 `lib/pdf2zh_launch.py` 里写好解释：

- **`bitstring<5`**：babeldoc 仍从 `bitstring` 导入 `BitStream`，而 bitstring 5 把它改名成 `Bits`，不降级会在 import 阶段直接崩。
- **代理环境变量里的 `[::1]`**：Clash 一类工具导出的 `NO_PROXY` 含 `[::1]`，httpx 会把它当 URL 解析并抛 `InvalidURL: ':1]'`，而 pdf2zh 在 import 时就实例化了 ollama 客户端。启动器会在 import 前清掉带方括号的条目。

若要把解释器放到别处，在插件配置里写 `pythonPath`。

## 已知限制

- 只支持英→中方向。其他语言对没测过。
- 扫描版（图片型）PDF 需要 OCR：`pdf2zh` 有实验性 OCR 支持，本插件未启用；`to: md` 通道对扫描件会抽到空文本并报错。
- `to: pdf` 通道的术语注入受限于 pdf2zh 自己的 prompt，内置术语表只作用于 `to: md` 通道。
- 译文由机器生成，引用前请核对原文；统计数字、基因名、单位务必人工复核。
