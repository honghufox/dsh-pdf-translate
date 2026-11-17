/**
 * PDF literature translation for DeepSeek Harness.
 *
 * Two outputs from one PDF:
 *  - `pdf`  layout-preserving bilingual/monolingual PDF, produced by PDFMathTranslate
 *           (`pdf2zh`) running in a managed Python environment;
 *  - `md`   a bilingual Markdown draft (English source + Chinese translation per
 *           paragraph) that is safe to quote from, produced by this plugin itself.
 *
 * Translation engines:
 *  - `dsh`      the Harness LLM service — the model already selected for the
 *               session, so no extra API key and no proxy surprises;
 *  - `local`    any OpenAI-compatible endpoint, typically `llama-server` running a
 *               Hunyuan HY-MT GGUF on the local GPU (free after the download);
 *  - `deepseek` the DeepSeek API over a direct connection;
 *  - `free`     pdf2zh's built-in free endpoints (Google/Bing) — often unreachable
 *               from mainland networks, kept only as a last resort.
 *
 * Token cost is kept down by translating paragraph runs in one batched request,
 * caching every finished translation on disk, and skipping reference lists.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'pdf-translate'
export const inject = ['tools']

const SEG = '\u2043\u2043SEG\u2043\u2043'
const DATA_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'pdf-translate')
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

const BIOMED_GLOSSARY = [
  ['tumour', '肿瘤'], ['tumor', '肿瘤'], ['carcinoma', '癌'], ['adenocarcinoma', '腺癌'],
  ['macrophage', '巨噬细胞'], ['lymphocyte', '淋巴细胞'], ['neutrophil', '中性粒细胞'],
  ['T cell', 'T 细胞'], ['B cell', 'B 细胞'], ['CD8+ T cell', 'CD8+ T 细胞'],
  ['antigen presentation', '抗原呈递'], ['antibody', '抗体'], ['monoclonal antibody', '单克隆抗体'],
  ['cytokine', '细胞因子'], ['chemokine', '趋化因子'], ['receptor', '受体'], ['ligand', '配体'],
  ['apoptosis', '凋亡'], ['proliferation', '增殖'], ['differentiation', '分化'],
  ['metastasis', '转移'], ['angiogenesis', '血管生成'], ['inflammation', '炎症'],
  ['transcription factor', '转录因子'], ['gene expression', '基因表达'],
  ['single-cell RNA sequencing', '单细胞 RNA 测序'], ['immunohistochemistry', '免疫组织化学'],
  ['formalin-fixed paraffin-embedded', '福尔马林固定石蜡包埋'],
  ['overall survival', '总生存期'], ['progression-free survival', '无进展生存期'],
  ['hazard ratio', '风险比'], ['confidence interval', '置信区间'],
  ['placebo', '安慰剂'], ['randomised', '随机'], ['randomized', '随机'],
  ['in vitro', '体外'], ['in vivo', '体内'], ['knockout', '敲除'], ['knockdown', '敲低'],
  ['wild-type', '野生型'], ['upregulation', '上调'], ['downregulation', '下调'],
  ['signalling pathway', '信号通路'], ['signal transduction', '信号转导'],
  ['myeloid', '髓系'], ['stromal', '基质'], ['epithelial', '上皮'], ['endothelial', '内皮'],
  ['ligand-binding domain', '配体结合域'], ['pharmacokinetics', '药代动力学'],
  ['adverse event', '不良事件'], ['biomarker', '生物标志物'],
]

const ENGINE_HELP = {
  dsh: 'the Harness LLM already selected for this session (no key, cheapest when the session model is deepseek-flash)',
  local: 'a local OpenAI-compatible server (llama-server / Ollama / LM Studio); free after the model download',
  deepseek: 'the DeepSeek API directly (needs deepseekApiKey in the plugin config)',
  free: 'pdf2zh free Google/Bing endpoints; usually blocked on mainland networks',
}

/** Resolve the managed Python interpreter, preferring an explicit configuration. */
function resolvePython(config, cwd) {
  const candidates = [
    config.pythonPath,
    join(DATA_DIR, 'venv', 'Scripts', 'python.exe'),
    join(cwd ?? '', '.venv', 'Scripts', 'python.exe'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Run a child process and collect its stdout/stderr without leaking the pipe. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const limit = options.maxBuffer ?? 2_000_000
    child.stdout.on('data', chunk => {
      if (stdout.length < limit) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < limit) stderr += chunk.toString('utf8')
    })
    child.on('error', rejectPromise)
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
    if (options.signal) {
      if (options.signal.aborted) child.kill()
      else options.signal.addEventListener('abort', () => child.kill(), { once: true })
    }
  })
}

/** Read the persisted translation cache; a missing or corrupt file is simply empty. */
async function readCache() {
  try {
    return JSON.parse(await readFile(join(DATA_DIR, 'cache.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function writeCache(cache) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(join(DATA_DIR, 'cache.json'), JSON.stringify(cache, null, 0), 'utf8')
}

function cacheKey(engine, model, text) {
  return createHash('sha1').update(`${engine}\u0000${model ?? ''}\u0000${text}`).digest('hex')
}

/** Collect streamed assistant text from a Harness LLM call. */
async function streamText(llm, selection, system, prompt, signal) {
  let text = ''
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0.2,
    signal,
    purpose: 'pdf-translate',
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text.trim()
}

/** One OpenAI-compatible chat completion, used for local and DeepSeek routes. */
async function chatCompletion(baseUrl, apiKey, model, system, prompt, signal) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey || 'sk-local'}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`${baseUrl} returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  const payload = await response.json()
  return payload?.choices?.[0]?.message?.content?.trim() ?? ''
}

function buildSystemPrompt(domain, glossary, target) {
  const lines = [
    'You are a professional scientific translator working from English into ' + (target || 'Simplified Chinese') + '.',
    'Translate faithfully and precisely; preserve numbers, units, gene and protein symbols, statistical notation and citation markers exactly.',
    'Do not add explanations, notes or summaries. Do not merge or split segments.',
  ]
  if (domain === 'biomed') {
    lines.push('Domain: biomedicine. Use standard Chinese medical terminology.')
    lines.push(
      'Keep abbreviations that are conventionally left in Latin script (e.g. TNF, IL-6, PD-1, H&E) unchanged.',
    )
  }
  if (glossary.length > 0) {
    lines.push(
      'Reference translations for terminology: ' +
        glossary.map(([source, zh]) => `${source} → ${zh}`).join('; ') +
        '.',
    )
  }
  lines.push(`Separate translations with the line ${SEG} on its own line, one translation per segment, in the same order.`)
  return lines.join(' ')
}

/** Translate an array of paragraphs in batches, reusing the on-disk cache. */
async function translateParagraphs(paragraphs, { engine, domain, target, glossary, channel, signal, log }) {
  const cache = await readCache()
  const model = channel.model ?? engine
  const out = new Array(paragraphs.length)
  const pending = []
  paragraphs.forEach((text, index) => {
    const hit = cache[cacheKey(engine, model, text)]
    if (typeof hit === 'string') out[index] = hit
    else pending.push({ index, text })
  })

  const BATCH_CHARS = 3500
  let cursor = 0
  while (cursor < pending.length) {
    signal?.throwIfAborted()
    const batch = []
    let size = 0
    while (cursor < pending.length && (batch.length === 0 || size + pending[cursor].text.length < BATCH_CHARS)) {
      batch.push(pending[cursor])
      size += pending[cursor].text.length
      cursor += 1
    }
    const system = buildSystemPrompt(domain, glossary, target)
    const prompt =
      batch.length === 1
        ? `Translate the following segment into ${target || 'Simplified Chinese'}.\n\n${batch[0].text}`
        : `Translate each segment into ${target || 'Simplified Chinese'}. ` +
          `Between translated segments output the line ${SEG}.\n\n` +
          batch.map(item => item.text).join(`\n${SEG}\n`)
    const reply = await channel.complete(system, prompt)
    // A single-segment batch carries no separator, so it maps one to one.
    const pieces = batch.length === 1 ? [reply] : reply.split(SEG)
    if (pieces.length !== batch.length) {
      // The model dropped or added a separator; fall back to one request per
      // paragraph rather than silently misaligning translations.
      log?.(`segment split mismatch (${pieces.length} vs ${batch.length}); retrying individually`)
      for (const item of batch) {
        const single = await channel.complete(
          buildSystemPrompt(domain, glossary, target),
          `Translate the following segment into ${target || 'Simplified Chinese'}.\n\n${item.text}`,
        )
        out[item.index] = single
        cache[cacheKey(engine, model, item.text)] = single
      }
      continue
    }
    batch.forEach((item, offset) => {
      out[item.index] = pieces[offset].trim()
      cache[cacheKey(engine, model, item.text)] = pieces[offset].trim()
    })
  }
  await writeCache(cache)
  return out
}

/** Split document text into reference-free paragraphs worth translating. */
function buildParagraphs(blocks) {
  const paragraphs = []
  let inReferences = false
  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    if (/^(references|bibliography|literature cited|参考文献)\s*$/i.test(text)) {
      inReferences = true
      continue
    }
    if (inReferences) continue
    if (text.length < 3) continue
    // Bare numbers, table rules and page furniture are not prose.
    if (!/[A-Za-z\u4e00-\u9fff]/.test(text)) continue
    paragraphs.push({ page: block.page, text })
  }
  return paragraphs
}

async function collectPdfs(target) {
  const info = await stat(target)
  if (info.isFile()) return [target]
  const names = (await readdir(target)).filter(file => file.toLowerCase().endsWith('.pdf')).sort()
  return names.map(file => join(target, file))
}

/** Choose the translation channel for the requested engine. */
function makeChannel(engine, config, ctx) {
  if (engine === 'dsh') {
    const llm = ctx.get('llm')
    const selector = ctx.get('agentDefaultModel')
    if (!llm || !selector) throw new Error('engine "dsh" needs the Harness LLM service, which is not mounted')
    const selection = selector.currentSelection()
    if (!selection?.provider || !selection?.model) {
      throw new Error('engine "dsh" has no model selected for this session')
    }
    return {
      model: `${selection.provider}/${selection.model}`,
      complete: (system, prompt) => streamText(llm, selection, system, prompt),
    }
  }
  if (engine === 'deepseek') {
    if (!config.deepseekApiKey) {
      throw new Error('engine "deepseek" needs deepseekApiKey in the plugin configuration')
    }
    const baseUrl = config.deepseekBaseUrl || 'https://api.deepseek.com/v1'
    const model = config.deepseekModel || 'deepseek-flash'
    return { model, complete: (system, prompt) => chatCompletion(baseUrl, config.deepseekApiKey, model, system, prompt) }
  }
  if (engine === 'local') {
    const baseUrl = config.localBaseUrl || 'http://127.0.0.1:9931/v1'
    const model = config.localModel || 'hymt'
    return { model, complete: (system, prompt) => chatCompletion(baseUrl, 'sk-local', model, system, prompt) }
  }
  throw new Error(`engine "${engine}" cannot translate Markdown; use dsh, local or deepseek`)
}

/** Render the bilingual Markdown deliverable. */
function renderMarkdown(source, translations, paragraphs) {
  const lines = [
    `# ${source}`,
    '',
    '> 双语对照稿：原文段落在下，中文译文紧随其后。译文由机器翻译生成，引用前请核对原文。',
    '',
  ]
  let page = 0
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.page !== page) {
      page = paragraph.page
      lines.push(`<!-- page ${page + 1} -->`, '')
    }
    lines.push(paragraph.text, '', translations[index] ?? '', '')
  })
  return lines.join('\n')
}

function selectEngine(requested, config) {
  if (requested && requested !== 'auto') return requested
  if (config.localBaseUrl) return 'local'
  if (config.deepseekApiKey) return 'deepseek'
  return 'dsh'
}

const tools = []

tools.push({
  name: 'pdf_translate',
  description:
    'Translate English scientific PDFs into Chinese: emit a layout-preserving bilingual PDF with pdf2zh, ' +
    'a bilingual Markdown draft, or both. Use it when the user wants papers read in Chinese, ' +
    'quoted in a review, or filed in a reference manager.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: {
      input: { type: 'string', description: 'A PDF file path, or a directory whose PDFs are all translated.' },
      to: {
        type: 'string',
        enum: ['pdf', 'md', 'both'],
        description: 'pdf = layout-preserving PDF only, md = bilingual Markdown only, both = run both. Default md.',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'local', 'dsh', 'deepseek', 'free'],
        description:
          'Translation route. auto prefers local, then deepseek, then dsh. dsh and free never produce a PDF. ' +
          'Default auto.',
      },
      output: { type: 'string', description: 'Output directory. Default: <pdf directory>/zh-output.' },
      pages: { type: 'string', description: 'Page selection for the PDF pass, e.g. "1-10,15". Default: every page.' },
      domain: {
        type: 'string',
        enum: ['biomed', 'general'],
        description: 'biomed injects biomedical terminology and agent rules. Default biomed.',
      },
      force: { type: 'boolean', description: 'Ignore the translation cache and retranslate. Default false.' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['engine', 'files'],
      properties: {
        engine: { type: 'string' },
        summary: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['source', 'outputs'],
            properties: {
              source: { type: 'string' },
              outputs: { type: 'array', items: { type: 'string' } },
              paragraphs: { type: 'integer' },
              cached: { type: 'integer' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: value.summary ?? `${value.files.length} file(s) translated with ${value.engine}.` },
    ],
  },
  async execute(args, exec) {
    const { ctx } = exec
    const config = readConfig(exec)
    const engine = selectEngine(args.engine, config)
    const want = args.to ?? 'md'
    const domain = args.domain ?? 'biomed'
    const pdfs = await collectPdfs(resolve(args.input))
    if (pdfs.length === 0) throw new Error(`no PDF found at ${args.input}`)
    const results = []
    let cachedTotal = 0
    let paragraphTotal = 0

    for (const pdf of pdfs) {
      const outDir = resolve(args.output ?? join(dirname(pdf), 'zh-output'))
      await mkdir(outDir, { recursive: true })
      const stem = pdf.split(sep).pop().replace(/\.pdf$/i, '')
      const produced = []
      const record = { source: pdf, outputs: produced }

      try {
        if (want === 'md' || want === 'both') {
          const python = resolvePython(config, cwd)
          if (!python) throw new Error('managed Python environment missing; run the PDF translation setup first')
          const helper = join(PACKAGE_DIR, 'lib', 'extract.py')
          const extracted = await run(python, [helper, pdf], {
            signal: exec.signal,
            env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          })
          if (extracted.code !== 0) throw new Error(`PDF text extraction failed: ${extracted.stderr.slice(-500)}`)
          const blocks = JSON.parse(extracted.stdout)
          const paragraphs = buildParagraphs(blocks)
          const glossary = domain === 'biomed' ? BIOMED_GLOSSARY : []
          const channel = makeChannel(engine, config, ctx)
          const translations = await translateParagraphs(paragraphs, {
            engine,
            domain,
            target: 'Simplified Chinese',
            glossary,
            channel,
            signal: exec.signal,
          })
          const markdownPath = join(outDir, `${stem}.zh.md`)
          await writeFile(markdownPath, renderMarkdown(stem, translations, paragraphs), 'utf8')
          produced.push(markdownPath)
          record.paragraphs = paragraphs.length
          paragraphTotal += paragraphs.length
          cachedTotal += paragraphs.filter((_, index) => typeof translations[index] === 'string').length
        }

        if (want === 'pdf' || want === 'both') {
          if (engine === 'dsh') throw new Error('engine "dsh" cannot feed the PDF layout pass; use local, deepseek or free')
          const python = resolvePython(config, cwd)
          if (!python) throw new Error('managed Python environment missing; run the PDF translation setup first')
          const helper = join(PACKAGE_DIR, 'lib', 'pdf2zh_launch.py')
          const pdfArgs = [helper, pdf, '-li', 'en', '-lo', 'zh', '-o', outDir]
          if (args.pages) pdfArgs.push('-p', args.pages)
          if (args.force) pdfArgs.push('--ignore-cache')
          const env = { PDF2ZH_HOME: join(DATA_DIR, 'cache') }
          if (engine === 'local') {
            env.OPENAI_BASE_URL = config.localBaseUrl || 'http://127.0.0.1:9931/v1'
            env.OPENAI_API_KEY = 'sk-local'
            env.OPENAI_MODEL = config.localModel || 'hymt'
            pdfArgs.push('-s', 'openai')
          } else if (engine === 'deepseek') {
            if (!config.deepseekApiKey) throw new Error('deepseekApiKey is required for the deepseek engine')
            env.OPENAI_BASE_URL = config.deepseekBaseUrl || 'https://api.deepseek.com/v1'
            env.OPENAI_API_KEY = config.deepseekApiKey
            env.OPENAI_MODEL = config.deepseekModel || 'deepseek-flash'
            pdfArgs.push('-s', 'openai')
          } else {
            pdfArgs.push('-s', 'google')
          }
          const pdfRun = await run(python, pdfArgs, { env, signal: exec.signal, maxBuffer: 400_000 })
          if (pdfRun.code !== 0) throw new Error(`pdf2zh failed: ${pdfRun.stderr.slice(-600)}`)
          for (const file of await readdir(outDir)) {
            if (file.startsWith(stem) && file.toLowerCase().endsWith('.pdf')) produced.push(join(outDir, file))
          }
        }
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error)
      }
      results.push(record)
    }

    const failed = results.filter(item => item.error).length
    const summary =
      `${results.length - failed}/${results.length} file(s) processed with engine "${engine}"` +
      (paragraphTotal ? `, ${paragraphTotal} paragraph(s) translated` : '') +
      (failed ? `; ${failed} failed` : '') +
      '.'
    return { engine, summary, files: results }
  },
})

tools.push({
  name: 'pdf_translate_doctor',
  description:
    'Report whether PDF translation can run here: the managed Python environment, pdf2zh, the local model server, ' +
    'the DeepSeek credential, the GPU and the translation cache. Use it before translating, or when a translation fails.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ready', 'checks'],
      properties: {
        ready: { type: 'boolean' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'ok', 'detail'],
            properties: {
              name: { type: 'string' },
              ok: { type: 'boolean' },
              detail: { type: 'string' },
            },
          },
        },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: value.checks.map(check => `${check.ok ? 'ok' : 'no'}  ${check.name}: ${check.detail}`).join('\n') },
    ],
  },
  async execute(_args, exec) {
    const { ctx } = exec
    const config = readConfig(exec)
    const checks = []
    const push = (name, ok, detail) => checks.push({ name, ok, detail })

    const python = resolvePython(config)
    push('python', Boolean(python), python ?? 'no managed interpreter; see the plugin detail document for the setup command')

    if (python) {
      const probeModule = async (module, label) => {
        const probe = await run(python, [
          '-c',
          `import importlib.util as u, importlib.metadata as m; print((m.version('${module}') if u.find_spec('${module}') else 'missing'))`,
        ]).catch(() => undefined)
        const answer = probe?.stdout.trim() ?? ''
        push(label, probe?.code === 0 && answer !== 'missing' && answer !== '', answer === 'missing' ? 'not installed in the managed environment' : answer || 'probe failed')
      }
      await probeModule('pdf2zh', 'pdf2zh')
      await probeModule('pymupdf', 'pymupdf (text extraction)')
    } else {
      push('pdf2zh', false, 'skipped: no interpreter')
    }

    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    push(
      'harness llm (engine dsh)',
      Boolean(llm && selection?.model),
      selection?.model ? `${selection.provider}/${selection.model}` : 'no model selected for this session',
    )
    push('deepseek key (engine deepseek)', Boolean(config.deepseekApiKey), config.deepseekApiKey ? 'configured' : 'not configured')
    push(
      'local server (engine local)',
      Boolean(config.localBaseUrl),
      config.localBaseUrl ? `${config.localBaseUrl} model=${config.localModel ?? 'hymt'}` : 'not configured',
    )

    if (config.localBaseUrl) {
      try {
        const response = await fetch(`${config.localBaseUrl.replace(/\/$/, '')}/models`, { signal: exec.signal })
        push('local server reachable', response.ok, response.ok ? 'answered /models' : `HTTP ${response.status}`)
      } catch (error) {
        push('local server reachable', false, error instanceof Error ? error.message : String(error))
      }
    }

    const cache = await readCache()
    push('translation cache', Object.keys(cache).length > 0, `${Object.keys(cache).length} cached segment(s) in ${DATA_DIR}`)
    const ready = checks.filter(check => ['python', 'pdf2zh'].includes(check.name)).every(check => check.ok)
    return { ready, checks }
  },
})

/**
 * Local translation models, smallest first. `weightsGiB` is the GGUF download
 * size; `minVramGiB` is the显存 needed to keep the whole model on the GPU at a
 * 4k context. Everything above 7B Q4 is an estimate derived from the verified
 * Q4_K_M size, so `estimated` marks it.
 */
const LOCAL_MODELS = [
  {
    id: 'mt2-1.8b-1.25bit',
    label: 'Hy-MT2-1.8B · 1.25bit (GGUF)',
    repo: 'AngelSlim/Hy-MT2-1.8B-1.25bit-GGUF',
    include: '*1.25*Bit*.gguf',
    weightsGiB: 0.43,
    minVramGiB: 1,
    tier: 'any',
    note: '占用最小，但 1.25bit 需要尚未并入主线的 llama.cpp 内核（PR #22836），要自编译；不建议作为第一选择。',
  },
  {
    id: 'mt15-1.8b-q4',
    label: 'HY-MT1.5-1.8B · Q4_K_M',
    repo: 'tencent/HY-MT1.5-1.8B-GGUF',
    include: '*Q4_K_M*.gguf',
    weightsGiB: 1.06,
    minVramGiB: 2,
    tier: '4gb',
    note: '官方称同尺寸最强，质量接近商业翻译 API；2G 显存也能跑，纯 CPU 也可用。',
  },
  {
    id: 'mt15-1.8b-q6',
    label: 'HY-MT1.5-1.8B · Q6_K',
    repo: 'tencent/HY-MT1.5-1.8B-GGUF',
    include: '*Q6_K*.gguf',
    weightsGiB: 1.37,
    minVramGiB: 3,
    tier: '4gb',
    note: '4G 显卡（1650 级）最舒服的档位：全量上卡、速度最快、量化损失几乎可以忽略。',
  },
  {
    id: 'mt15-1.8b-q8',
    label: 'HY-MT1.5-1.8B · Q8_0',
    repo: 'tencent/HY-MT1.5-1.8B-GGUF',
    include: '*Q8_0*.gguf',
    weightsGiB: 1.78,
    minVramGiB: 4,
    tier: '4gb',
    note: '4G 显存刚好全量上卡；再大就没有收益，1.8B 的瓶颈已是模型本身。',
  },
  {
    id: 'mt15-7b-q4',
    label: 'HY-MT1.5-7B · Q4_K_M',
    repo: 'tencent/HY-MT1.5-7B-GGUF',
    include: '*Q4_K_M*.gguf',
    weightsGiB: 4.31,
    minVramGiB: 6,
    tier: '6gb',
    note: '质量明显好于 1.8B。4G 显卡只能部分 offload（-ngl 18~22，约 4–8 tok/s）。',
  },
  {
    id: 'mt2-7b-q4',
    label: 'Hy-MT2-7B · Q4_K_M',
    repo: 'tencent/Hy-MT2-7B-GGUF',
    include: '*Q4_K_M*.gguf',
    weightsGiB: 4.31,
    minVramGiB: 6,
    tier: '8gb',
    note: '2026 年的新一代：指令跟随更强，支持多行术语干预。启动必须加 --jinja 才会用官方对话模板。',
  },
  {
    id: 'mt2-7b-q5',
    label: 'Hy-MT2-7B · Q5_K_M',
    repo: 'tencent/Hy-MT2-7B-GGUF',
    include: '*Q5_K_M*.gguf',
    weightsGiB: 5.05,
    minVramGiB: 8,
    estimated: true,
    tier: '8gb',
    note: '8G 以上显卡的甜点位。',
  },
  {
    id: 'mt2-7b-q8',
    label: 'Hy-MT2-7B · Q8_0',
    repo: 'tencent/Hy-MT2-7B-GGUF',
    include: '*Q8_0*.gguf',
    weightsGiB: 7.66,
    minVramGiB: 10,
    estimated: true,
    tier: '12gb',
    note: '基本等价于 bf16 质量，12G 显存可全量上卡。',
  },
]

const LLAMA_DEFAULTS = {
  port: 9931,
  ctx: 4096,
  batch: 1024,
  microBatch: 256,
}

/** Detect graphics adapters and their memory, in GiB. */
async function detectGpus() {
  const smiCandidates = [
    'nvidia-smi',
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ]
  for (const candidate of smiCandidates) {
    const smi = await run(candidate, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
      maxBuffer: 64_000,
    }).catch(() => undefined)
    if (smi?.code !== 0 || !smi.stdout.trim()) continue
    const parsed = smi.stdout
      .trim()
      .split(/\r?\n/)
      .map(line => {
        const [smiName, memory] = line.split(',').map(part => part.trim())
        return { name: smiName ?? 'NVIDIA GPU', vramGiB: Number(memory) / 1024 }
      })
      .filter(gpu => Number.isFinite(gpu.vramGiB))
    if (parsed.length > 0) return parsed
  }

  for (const shell of ['pwsh', 'powershell']) {
    const probed = await run(
      shell,
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress',
      ],
      { maxBuffer: 64_000 },
    ).catch(() => undefined)
    if (probed?.code !== 0 || !probed.stdout.trim()) continue
    try {
      const parsed = JSON.parse(probed.stdout)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      const gpus = list
        .filter(item => item?.Name && !/Virtual|Basic|Remote|Mirror|RayLink/i.test(item.Name))
        .map(item => ({
          name: String(item.Name),
          // Win32_VideoController.AdapterRAM saturates at 4 GiB, so treat the
          // result as a lower bound and keep the recommendation conservative.
          vramGiB: Number(item.AdapterRAM) > 0 ? Number(item.AdapterRAM) / 1024 ** 3 : 0,
        }))
      if (gpus.length > 0) return gpus
    } catch {
      // fall through to the registry probe
    }
  }

  // The registry keeps the real amount even when AdapterRAM saturates.
  const reg = await run(
    'reg',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}', '/s', '/v', 'HardwareInformation.qwMemorySize'],
    { maxBuffer: 128_000 },
  ).catch(() => undefined)
  if (reg?.code === 0 && reg.stdout.trim()) {
    const gpus = []
    for (const match of reg.stdout.matchAll(/([0-9a-f]{8})\s+REG_QWORD\s+0x([0-9a-f]+)/gi)) {
      const bytes = Number.parseInt(match[2], 16)
      if (bytes > 0) gpus.push({ name: `display adapter (${match[1]})`, vramGiB: bytes / 1024 ** 3 })
    }
    if (gpus.length > 0) return gpus
  }
  return []
}

/** Pick the strongest model whose GPU footprint fits, plus neighbours. */
function recommendModels(vramGiB, limit) {
  const known = vramGiB > 0
  // With no detected GPU there is nothing to fill, so lead with the model that
  // is comfortable on CPU instead of the smallest niche quantization.
  const effective = known ? vramGiB : 0
  const fitting = known
    ? LOCAL_MODELS.filter(model => model.minVramGiB <= vramGiB)
    : LOCAL_MODELS.filter(model => model.id === 'mt15-1.8b-q4' || model.id === 'mt15-1.8b-q6')
  const byFootprint = [...fitting].sort((a, b) => b.weightsGiB - a.weightsGiB)
  const chosen = byFootprint.slice(0, limit ?? 3)
  const upgrade = LOCAL_MODELS.filter(model => model.minVramGiB > Math.max(effective, 0) && !chosen.includes(model)).sort(
    (a, b) => a.minVramGiB - b.minVramGiB,
  )[0]
  return { chosen, upgrade, known }
}

function llamaCommand(model, vramGiB) {
  const full = vramGiB >= model.minVramGiB
  const layers = vramGiB <= 0 ? 0 : full ? 99 : Math.max(1, Math.floor((vramGiB / model.weightsGiB) * 32))
  return [
    '-m <解压后的 .gguf 路径>',
    '--host 127.0.0.1',
    `--port ${LLAMA_DEFAULTS.port}`,
    `-ngl ${layers}`,
    `-c ${LLAMA_DEFAULTS.ctx}`,
    `-b ${LLAMA_DEFAULTS.batch}`,
    `-ub ${LLAMA_DEFAULTS.microBatch}`,
    '-np 1',
    '--jinja',
  ].join(' ')
}

tools.push({
  name: 'pdf_pick_model',
  description:
    'Detect the machine GPU and VRAM, then rank the local translation models that fit, with the exact download and ' +
    'llama-server command for each. Use it when choosing a local model for PDF translation, or after moving to another computer.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      vram: { type: 'number', description: 'Override the detected VRAM in GiB, for a machine other than this one.' },
      count: { type: 'integer', description: 'How many recommendations to return, 1-5. Default 3.' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['gpus', 'recommendations'],
      properties: {
        gpus: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'vramGiB'],
            properties: { name: { type: 'string' }, vramGiB: { type: 'number' } },
          },
        },
        vramGiB: { type: 'number' },
        tier: { type: 'string' },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'repo', 'include', 'weightsGiB', 'fitsGpu', 'download', 'serve'],
            properties: {
              label: { type: 'string' },
              repo: { type: 'string' },
              include: { type: 'string' },
              weightsGiB: { type: 'number' },
              minVramGiB: { type: 'number' },
              fitsGpu: { type: 'boolean' },
              note: { type: 'string' },
              download: { type: 'string' },
              serve: { type: 'string' },
            },
          },
        },
        upgradePath: { type: 'string' },
        summary: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const gpus = args.vram ? [] : await detectGpus()
    const vramGiB = Number(args.vram ?? gpus[0]?.vramGiB ?? 0)
    const limit = Math.min(Math.max(args.count ?? 3, 1), 5)
    const { chosen, upgrade, known } = recommendModels(vramGiB, limit)
    const tier = !known ? 'CPU' : vramGiB >= 16 ? '16GB' : vramGiB >= 12 ? '12GB' : vramGiB >= 8 ? '8GB' : vramGiB >= 4 ? '4GB' : 'CPU'
    const recommendations = chosen.map(model => ({
      label: model.label,
      repo: model.repo,
      include: model.include,
      weightsGiB: model.weightsGiB,
      minVramGiB: model.minVramGiB,
      fitsGpu: known && vramGiB >= model.minVramGiB,
      note: model.note + (model.estimated ? '（体积为估算）' : ''),
      download: `hf download ${model.repo} --include "${model.include}" --local-dir ./models`,
      serve: llamaCommand(model, vramGiB),
    }))
    const summary = [
      known
        ? `Detection: ${gpus.map(gpu => `${gpu.name} ${gpu.vramGiB.toFixed(1)}GB`).join(', ') || `overridden ${vramGiB}GB`} → tier ${tier}.`
        : 'No GPU detected: the recommendation stays on CPU. Accepts a manual `vram` override for another machine.',
      '',
      ...recommendations.map((item, index) => {
        const fit = !known ? '（纯 CPU，速度约为显卡的 1/10）' : item.fitsGpu ? '（可全量上卡）' : '（需部分 offload）'
        return `${index + 1}. ${item.label} — ${item.weightsGiB}GB${fit}\n   ${item.note}\n   ${item.download}\n   ${item.serve}`
      }),
      upgrade
        ? `\n升级空间: 再往后是 ${upgrade.label}（需约 ${upgrade.minVramGiB}GB 显存）。`
        : '\n已是本机可用的最强档位。',
    ].join('\n')
    return {
      gpus,
      vramGiB,
      tier,
      recommendations,
      ...(upgrade ? { upgradePath: upgrade.label } : {}),
      summary,
    }
  },
})

/** Read the loader row config passed to this registration. */
function readConfig(exec) {
  return exec?.config ?? {}
}

/**
 * Register the PDF translation tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - loader row configuration.
 */
export function apply(ctx, config = {}) {
  for (const tool of tools) {
    ctx.tools.register({
      ...tool,
      execute: (args, exec) => tool.execute(args, { ...exec, config, ctx }),
    })
  }
}

export { ENGINE_HELP, BIOMED_GLOSSARY }
