#!/usr/bin/env node
/**
 * Stage 1 — Automated plugin submission validator
 *
 * Checks (in order):
 *   1. Rate limit — max 3 open PRs per GitHub account
 *   2. Schema    — all required fields present, correct types
 *   3. SHA pin   — sourceUrl must be raw.githubusercontent.com + 40-char SHA
 *   4. Verified  — only the repo owner may set verified:true
 *   5. Fetch     — sourceUrl is reachable and returns code
 *   6. Validator — syntax + semantic check (adapted from pluginValidator.js)
 *   7. Patterns  — flags known risky code patterns
 *
 * Posts a structured comment on the PR and sets a commit status.
 */

'use strict'

const { execSync } = require('child_process')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')
const vm = require('vm')

// ── Config ────────────────────────────────────────────────────────────────────

const GH_TOKEN   = process.env.GH_TOKEN
const PR_NUMBER  = process.env.PR_NUMBER
const PR_AUTHOR  = process.env.PR_AUTHOR
const REPO_FULL  = 'freddan-teamleader/plugin-marketplace'
const REPO_OWNER = 'freddan-teamleader'
const GH_API     = 'https://api.github.com'
const RAW_HOST   = 'raw.githubusercontent.com'
const SHA_RE     = /^[0-9a-f]{40}$/i
const MAX_OPEN_PRS = 3

const REQUIRED_FIELDS = [
  'id', 'name', 'description', 'author', 'authorUrl',
  'version', 'tags', 'license', 'sourceUrl', 'publishedAt',
  'status', 'verified', 'maintainer',
]

const RISKY_PATTERNS = [
  { re: /(?<!\w)eval\s*\(/,                label: '`eval()` detected — dynamic code execution is not allowed' },
  { re: /document\.cookie/,               label: '`document.cookie` access detected' },
  { re: /localStorage\s*\.\s*setItem/,    label: '`localStorage.setItem` detected — use `api.updateConfig()` instead' },
  { re: /navigator\.sendBeacon/,          label: '`navigator.sendBeacon` detected — use `api.fetch()` for network calls' },
  { re: /new\s+WebSocket\s*\(/,           label: '`WebSocket` detected — not permitted in plugins' },
  { re: /atob\s*\(|btoa\s*\(/,            label: 'Base64 encoding detected — possible obfuscation' },
  { re: /(?<![.\w])fetch\s*\(/,           label: 'Bare `fetch()` detected — use `api.fetch()` so requests route through the CORS proxy' },
]

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function ghFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${GH_API}${path}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  })
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
  catch { return { ok: res.ok, status: res.status, data: text } }
}

async function postComment(body) {
  await ghFetch(`/repos/${REPO_FULL}/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

async function setCommitStatus(sha, state, description) {
  await ghFetch(`/repos/${REPO_FULL}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({
      state,           // 'success' | 'failure' | 'error' | 'pending'
      description: description.slice(0, 140),
      context: 'plugin-marketplace/validate',
    }),
  })
}

// ── Worker thread: sandbox plugin execution ───────────────────────────────────
// Runs in a separate thread so any accidental side-effects are isolated.

const WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads')
const vm = require('vm')

const code = workerData.code

const widgets  = []
const services = []

const api = {
  registerWidget(def)  { widgets.push(def) },
  registerService(def) { services.push(def) },
  fetch() {},
  updateConfig() {},
  getService() {},
  emit() {},
  on() { return () => {} },
  listEvents() { return [] },
}

// Strip static import lines (ESM) — same as pluginValidator
const stripped = code.replace(/^\\s*import\\s[^\\n]*/gm, '')

try {
  const sandbox = vm.createContext({
    api,
    console: { log() {}, warn() {}, error() {} },
    setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
  })
  const fn = new vm.Script('(async function(api){' + stripped + '})(api)', { timeout: 5000 })
  const result = fn.runInContext(sandbox, { timeout: 5000 })
  if (result && typeof result.then === 'function') {
    result.then(() => {
      parentPort.postMessage({ ok: true, widgets, services })
    }).catch(err => {
      parentPort.postMessage({ ok: false, error: err.message, widgets, services })
    })
  } else {
    parentPort.postMessage({ ok: true, widgets, services })
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message, widgets: [], services: [] })
}
`

function runInSandbox(code) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { code } })
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Plugin execution timed out (5s)')) }, 6000)
    worker.on('message', result => { clearTimeout(timer); resolve(result) })
    worker.on('error',   err    => { clearTimeout(timer); reject(err) })
  })
}

// ── Semantic validator (mirrors pluginValidator.js) ───────────────────────────

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

function semanticValidate(widgets, services) {
  const errors   = []
  const warnings = []

  if (widgets.length === 0 && services.length === 0) {
    errors.push('No widgets or services registered. Plugin must call `api.registerWidget()` or `api.registerService()`.')
    return { errors, warnings }
  }

  const seen = new Set()
  for (const def of widgets) {
    const label = def.type ? `Widget "${def.type}"` : 'A widget'
    if (!def.type)                         errors.push(`${label}: missing required "type" field.`)
    else if (!KEBAB_RE.test(def.type))     warnings.push(`${label}: type should be kebab-case, got "${def.type}".`)
    else if (seen.has(def.type))           errors.push(`${label}: duplicate type within the same plugin.`)
    seen.add(def.type)

    if (!def.title)                        errors.push(`${label}: missing required "title" field.`)
    if (typeof def.render !== 'function')  errors.push(`${label}: missing required "render" function.`)
  }

  for (const type of services) {
    if (!KEBAB_RE.test(type)) warnings.push(`Service "${type}": type should be kebab-case.`)
  }

  return { errors, warnings }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const results  = []   // { check, status: 'pass'|'fail'|'warn', message }
  let   fatal    = false

  // ── Get PR metadata ─────────────────────────────────────────────────────────
  const prRes = await ghFetch(`/repos/${REPO_FULL}/pulls/${PR_NUMBER}`)
  if (!prRes.ok) { console.error('Cannot fetch PR:', prRes.data); process.exit(1) }
  const pr = prRes.data
  const headSha = pr.head.sha

  // ── 1. Rate limit ───────────────────────────────────────────────────────────
  const openRes = await ghFetch(`/repos/${REPO_FULL}/pulls?state=open&per_page=100`)
  if (openRes.ok) {
    const authorPRs = openRes.data.filter(p =>
      p.user.login === PR_AUTHOR && String(p.number) !== String(PR_NUMBER)
    )
    if (authorPRs.length >= MAX_OPEN_PRS) {
      results.push({
        check: 'Rate limit',
        status: 'fail',
        message: `@${PR_AUTHOR} already has ${authorPRs.length} open PR${authorPRs.length !== 1 ? 's' : ''}. Maximum is ${MAX_OPEN_PRS}. Please close one before submitting another.`,
      })
      fatal = true
    } else {
      results.push({ check: 'Rate limit', status: 'pass', message: `${authorPRs.length}/${MAX_OPEN_PRS} open PRs for @${PR_AUTHOR}.` })
    }
  }

  // ── Get changed entries from index.json ─────────────────────────────────────
  // Fetch the full index.json from the PR branch
  const idxRes = await ghFetch(`/repos/${REPO_FULL}/contents/index.json?ref=${headSha}`)
  let entries = []
  if (idxRes.ok) {
    try {
      entries = JSON.parse(Buffer.from(idxRes.data.content, 'base64').toString('utf8'))
    } catch { /* will catch below */ }
  }

  // Fetch base index.json to find new/changed entries
  const baseRes = await ghFetch(`/repos/${REPO_FULL}/contents/index.json?ref=${pr.base.sha}`)
  let baseEntries = []
  if (baseRes.ok) {
    try {
      baseEntries = JSON.parse(Buffer.from(baseRes.data.content, 'base64').toString('utf8'))
    } catch {}
  }
  const baseIds   = new Set(baseEntries.map(e => e.id))
  const changed   = entries.filter(e => !baseIds.has(e.id) || JSON.stringify(e) !== JSON.stringify(baseEntries.find(b => b.id === e.id)))

  if (changed.length === 0) {
    results.push({ check: 'Changed entries', status: 'warn', message: 'No changes detected in `index.json`. Did you forget to add your entry?' })
  } else {
    results.push({ check: 'Changed entries', status: 'pass', message: `${changed.length} entry/entries to validate: ${changed.map(e => `\`${e.id}\``).join(', ')}.` })
  }

  // ── Validate each changed entry ─────────────────────────────────────────────
  for (const entry of changed) {
    const prefix = `**\`${entry.id}\`**`

    // 2. Schema
    const missing = REQUIRED_FIELDS.filter(f => entry[f] === undefined || entry[f] === null || entry[f] === '')
    if (missing.length > 0) {
      results.push({ check: `${prefix} Schema`, status: 'fail', message: `Missing required fields: ${missing.map(f => `\`${f}\``).join(', ')}.` })
      fatal = true
    } else {
      results.push({ check: `${prefix} Schema`, status: 'pass', message: 'All required fields present.' })
    }

    if (!Array.isArray(entry.tags)) {
      results.push({ check: `${prefix} Schema`, status: 'fail', message: '`tags` must be an array.' })
      fatal = true
    }

    if (typeof entry.maintainer !== 'object' || !entry.maintainer.github) {
      results.push({ check: `${prefix} Schema`, status: 'fail', message: '`maintainer.github` is required.' })
      fatal = true
    }

    // 3. SHA pinning
    if (typeof entry.sourceUrl === 'string') {
      let shaOk = false
      try {
        const url  = new URL(entry.sourceUrl)
        const parts = url.pathname.split('/').filter(Boolean)
        // raw.githubusercontent.com / owner / repo / SHA / ...file
        if (url.hostname === RAW_HOST && parts.length >= 4 && SHA_RE.test(parts[2])) shaOk = true
      } catch {}

      if (!shaOk) {
        results.push({
          check: `${prefix} SHA pin`,
          status: 'fail',
          message: `\`sourceUrl\` must be a \`${RAW_HOST}\` URL with a full 40-character commit SHA, not a branch name. ` +
                   `Got: \`${entry.sourceUrl}\`\n\n` +
                   `Get your SHA with: \`git rev-parse HEAD\``,
        })
        fatal = true
      } else {
        results.push({ check: `${prefix} SHA pin`, status: 'pass', message: 'Pinned to a specific commit SHA.' })
      }
    }

    // 4. Verified guard
    if (entry.verified === true && PR_AUTHOR !== REPO_OWNER) {
      results.push({
        check: `${prefix} Verified field`,
        status: 'fail',
        message: `Only \`@${REPO_OWNER}\` may set \`"verified": true\`. Please set it to \`false\`.`,
      })
      fatal = true
    } else if (entry.verified === false || entry.verified === undefined) {
      results.push({ check: `${prefix} Verified field`, status: 'pass', message: '`verified` is correctly set to `false`.' })
    }

    // 5–7. Fetch + validate + pattern scan (skip if schema/SHA already failed)
    if (!fatal && typeof entry.sourceUrl === 'string') {
      let code = null
      try {
        const codeRes = await fetch(entry.sourceUrl)
        if (!codeRes.ok) throw new Error(`HTTP ${codeRes.status}`)
        code = await codeRes.text()
        results.push({ check: `${prefix} Source fetch`, status: 'pass', message: `Plugin source fetched (${(code.length / 1024).toFixed(1)} KB).` })
      } catch (err) {
        results.push({ check: `${prefix} Source fetch`, status: 'fail', message: `Cannot fetch plugin source: ${err.message}` })
        fatal = true
      }

      if (code) {
        // 6. pluginValidator — syntax check (fast, no sandbox)
        try {
          const stripped = code.replace(/^\s*import\s[^\n]*/gm, '')
          // eslint-disable-next-line no-new-func
          new Function('api', stripped)
          results.push({ check: `${prefix} Syntax`, status: 'pass', message: 'No syntax errors.' })
        } catch (err) {
          results.push({ check: `${prefix} Syntax`, status: 'fail', message: `Syntax error: ${err.message}` })
          fatal = true
        }

        // pluginValidator — semantic check via sandbox
        if (!fatal) {
          try {
            const sandboxResult = await runInSandbox(code)
            if (!sandboxResult.ok && sandboxResult.error) {
              results.push({ check: `${prefix} Execution`, status: 'warn', message: `Plugin threw during extraction: ${sandboxResult.error}` })
            }
            const { errors, warnings } = semanticValidate(sandboxResult.widgets, sandboxResult.services)
            if (errors.length > 0) {
              results.push({ check: `${prefix} Semantic`, status: 'fail', message: errors.join('\n') })
              fatal = true
            } else {
              const widgetCount  = sandboxResult.widgets.length
              const serviceCount = sandboxResult.services.length
              results.push({
                check: `${prefix} Semantic`,
                status: 'pass',
                message: `Registered ${widgetCount} widget${widgetCount !== 1 ? 's' : ''}, ${serviceCount} service${serviceCount !== 1 ? 's' : ''}.`,
              })
            }
            if (warnings.length > 0) {
              results.push({ check: `${prefix} Semantic warnings`, status: 'warn', message: warnings.join('\n') })
            }
          } catch (err) {
            results.push({ check: `${prefix} Execution`, status: 'fail', message: `Sandbox error: ${err.message}` })
            fatal = true
          }
        }

        // 7. Pattern scan
        const flagged = RISKY_PATTERNS.filter(p => p.re.test(code))
        if (flagged.length > 0) {
          results.push({
            check: `${prefix} Pattern scan`,
            status: 'fail',
            message: flagged.map(p => `- ${p.label}`).join('\n'),
          })
          fatal = true
        } else {
          results.push({ check: `${prefix} Pattern scan`, status: 'pass', message: 'No risky patterns detected.' })
        }
      }
    }
  }

  // ── Build comment ────────────────────────────────────────────────────────────
  const icon  = { pass: '✅', fail: '❌', warn: '⚠️' }
  const overall = fatal ? '❌ **Validation failed** — please fix the issues below before this PR can be reviewed.' :
                          '✅ **All checks passed** — ready for Stage 2 AI review.'

  const table = results.map(r =>
    `| ${icon[r.status]} | **${r.check}** | ${r.message.replace(/\n/g, '<br>')} |`
  ).join('\n')

  const comment = `## Plugin Marketplace — Stage 1 Validation\n\n${overall}\n\n` +
    `| | Check | Details |\n|---|---|---|\n${table}\n\n` +
    `<sub>Automated check · [plugin-marketplace](https://github.com/${REPO_FULL})</sub>`

  await postComment(comment)
  await setCommitStatus(headSha, fatal ? 'failure' : 'success',
    fatal ? 'Validation failed — see PR comment for details' : 'All checks passed')

  console.log(fatal ? 'FAILED' : 'PASSED')
  process.exit(fatal ? 1 : 0)
}

main().catch(err => {
  console.error('Validator crashed:', err)
  process.exit(1)
})
