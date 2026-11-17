/**
 * Offline harness: registers the plugin tools against a stub registry and drives
 * the environment-facing ones, so the checkout can be checked without a live
 * Harness session.
 *
 *   node scripts/check-plugin.mjs [sample.pdf]
 *
 * Set PDF_TRANSLATE_PYTHON to the interpreter that has pdf2zh installed; it
 * otherwise defaults to $DSH_HOME/pdf-translate/venv/Scripts/python.exe.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const PYTHON =
  process.env.PDF_TRANSLATE_PYTHON ??
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'pdf-translate', 'venv', 'Scripts', 'python.exe')
const SAMPLE = process.argv[2]

const registered = []
const stubCtx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  get() {
    return undefined
  },
}

apply(stubCtx, {})
console.log(`registered tools: ${registered.map(item => item.name).join(', ')}`)

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.on('error', error => resolve({ code: -1, stdout: '', stderr: error.message }))
  })
}

const exec = { signal: new AbortController().signal, config: {}, ctx: stubCtx }

for (const definition of registered) {
  // Exercise the recommendation table for the GPU classes the plugin targets.
  const plans = definition.name === 'pdf_pick_model' ? [{}, { vram: 4 }, { vram: 16 }] : []
  for (const args of plans) {
    try {
      const value = await definition.execute(args, exec)
      console.log(`\n=== ${definition.name} ${JSON.stringify(args)} ===`)
      console.log(definition.output.render(args, value).map(block => block.text).join('\n'))
    } catch (error) {
      console.log(`\n=== ${definition.name} ${JSON.stringify(args)} FAILED: ${error.message}`)
    }
  }
}

if (SAMPLE) {
  console.log('\n=== extract.py ===')
  if (!existsSync(PYTHON)) {
    console.log(`skipped: interpreter not found at ${PYTHON}`)
  } else {
    const extracted = await run(PYTHON, ['lib/extract.py', SAMPLE])
    if (extracted.code !== 0) {
      console.log(`failed: ${extracted.stderr.slice(-400)}`)
    } else {
      const blocks = JSON.parse(extracted.stdout)
      const pages = [...new Set(blocks.map(block => block.page))]
      const chars = blocks.reduce((sum, block) => sum + block.text.length, 0)
      console.log(`blocks=${blocks.length} pages=${pages.join(',')} chars=${chars}`)
      console.log(`first block: ${blocks[0].text.slice(0, 100)}`)
    }
  }
}
