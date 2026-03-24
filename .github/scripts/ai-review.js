#!/usr/bin/env node
/**
 * Stage 2 — AI review via Claude (workflow_dispatch)
 *
 * Environment variables (injected by ai-review.yml):
 *   GH_TOKEN            — GitHub Actions token (PR comment + label + status)
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   PR_NUMBER           — PR number to review
 *
 * Steps:
 *   1. Fetch PR details + changed index.json entry
 *   2. Fetch plugin source code from the pinned sourceUrl
 *   3. Call Claude with a structured review prompt
 *   4. Post the AI review as a PR comment
 *   5. Apply label: ai-approved | ai-flagged | ai-changes-requested
 *   6. Set commit status reflecting the AI recommendation
 */

const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk')

const GH_TOKEN          = process.env.GH_TOKEN
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const PR_NUMBER         = process.env.PR_NUMBER

const REPO       = 'freddan-teamleader/plugin-marketplace'
const REPO_OWNER = 'freddan-teamleader'

if (!GH_TOKEN || !ANTHROPIC_API_KEY || !PR_NUMBER) {
  console.error('Missing required environment variables: GH_TOKEN, ANTHROPIC_API_KEY, PR_NUMBER')
  process.exit(1)
}

const GH_API = 'https://api.github.com'

// ── GitHub helpers ─────────────────────────────────────────────────────────

function ghHeaders(extra = {}) {
  return {
    Authorization: `token ${GH_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    ...extra,
  }
}

async function ghGet(path) {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders() })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`GitHub GET ${path} failed (${res.status}): ${body}`)
  }
  return res.json()
}

async function ghPost(path, body) {
  const res = await fetch(`${GH_API}${path}`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub POST ${path} failed (${res.status}): ${text}`)
  }
  return res.json()
}

async function ghPatch(path, body) {
  const res = await fetch(`${GH_API}${path}`, {
    method: 'PATCH',
    headers: ghHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub PATCH ${path} failed (${res.status}): ${text}`)
  }
  return res.json()
}

// ── PR helpers ─────────────────────────────────────────────────────────────

async function getPR() {
  return ghGet(`/repos/${REPO}/pulls/${PR_NUMBER}`)
}

async function getPRFiles() {
  return ghGet(`/repos/${REPO}/pulls/${PR_NUMBER}/files`)
}

/**
 * Extract the new/modified index.json entry from the PR diff.
 * Returns the parsed entry object or null if not found.
 */
async function getChangedEntry() {
  const files = await getPRFiles()
  const indexFile = files.find(f => f.filename === 'index.json')
  if (!indexFile) return null

  // Fetch the file content from the PR head ref
  const pr = await getPR()
  const headSha = pr.head.sha
  const contentRes = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${headSha}/index.json`,
    { headers: { Authorization: `token ${GH_TOKEN}` } }
  )
  if (!contentRes.ok) return null

  const index = await contentRes.json()
  if (!Array.isArray(index) || index.length === 0) return null

  // Find the entry added/modified in this PR by comparing with base
  const baseSha = pr.base.sha
  let baseIndex = []
  try {
    const baseRes = await fetch(
      `https://raw.githubusercontent.com/${REPO}/${baseSha}/index.json`,
      { headers: { Authorization: `token ${GH_TOKEN}` } }
    )
    if (baseRes.ok) baseIndex = await baseRes.json()
  } catch { /* new repo, base may be empty */ }

  const baseIds = new Set((Array.isArray(baseIndex) ? baseIndex : []).map(e => e.id))
  const changed = index.find(e => !baseIds.has(e.id))
    ?? index.find(e => {
      const base = baseIndex.find(b => b.id === e.id)
      return base && (base.version !== e.version || base.sourceUrl !== e.sourceUrl)
    })

  return changed ?? null
}

async function fetchPluginCode(sourceUrl) {
  const res = await fetch(sourceUrl, {
    headers: { Authorization: `token ${GH_TOKEN}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch plugin source (${res.status})`)
  return res.text()
}

// ── Claude review ──────────────────────────────────────────────────────────

const REVIEW_PROMPT = (entry, code) => `You are reviewing a community-submitted plugin for a developer Dashboard.
The Dashboard plugin system works as follows:
- Plugins are JavaScript files that call \`api.registerWidget({ type, defaultConfig, hiddenConfig, render })\`
- \`render(container, config, api)\` receives a DOM container, a config object, and an API object
- \`api.fetch(url, options)\` — CORS-proxied fetch (plugins must use this, not bare fetch)
- \`api.updateConfig(partial)\` — persist config changes
- \`api.emit(event, data)\` / \`api.on(event, handler)\` — inter-plugin event bus
- \`api.registerService(name, impl)\` / \`api.getService(name)\` — service registry
- External npm packages can be loaded via \`import ... from 'https://esm.sh/<pkg>'\`

## Plugin metadata from index.json

\`\`\`json
${JSON.stringify(entry, null, 2)}
\`\`\`

## Plugin source code

\`\`\`javascript
${code}
\`\`\`

## Your review task

Evaluate this plugin across the following dimensions and give a structured response:

### 1. Code Quality
- Is the code readable, well-structured, and maintainable?
- Are there obvious bugs or logic errors?
- Does it handle errors gracefully?

### 2. Security
- What data does the plugin access (DOM, config, browser APIs)?
- What external calls does it make and to which domains?
- Are there any concerning patterns: \`eval()\`, \`document.cookie\`, \`localStorage\` exfiltration,
  data URIs with encoded payloads, obfuscated strings, unexpected network calls?
- Does it use bare \`fetch()\` instead of \`api.fetch()\`? (bare fetch bypasses the CORS proxy)

### 3. Behaviour vs. Description
- Does the plugin actually do what the description says?
- Are there hidden side-effects not mentioned in the description or tags?

### 4. API Contract Compliance
- Does it call \`api.registerWidget\` correctly?
- Does it respect \`defaultConfig\` / \`hiddenConfig\` conventions?
- If it uses the event bus or service registry, is it used correctly?

### 5. Overall Recommendation
Choose exactly one of:
- **APPROVE** — ready to merge as-is
- **REQUEST_CHANGES** — good intent but needs specific fixes before approval
- **REJECT** — fundamental problems, security concerns, or misrepresented purpose

End your response with a single line in this exact format:
RECOMMENDATION: APPROVE | REQUEST_CHANGES | REJECT`

async function callClaude(prompt) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })
  return message.content[0].text
}

function parseRecommendation(review) {
  const match = review.match(/RECOMMENDATION:\s*(APPROVE|REQUEST_CHANGES|REJECT)/i)
  return match ? match[1].toUpperCase() : 'REQUEST_CHANGES'
}

function recommendationToLabel(rec) {
  switch (rec) {
    case 'APPROVE':          return 'ai-approved'
    case 'REJECT':           return 'ai-flagged'
    case 'REQUEST_CHANGES':
    default:                 return 'ai-changes-requested'
  }
}

function recommendationToStatus(rec) {
  switch (rec) {
    case 'APPROVE':   return { state: 'success',  description: 'AI review: approved' }
    case 'REJECT':    return { state: 'failure',  description: 'AI review: flagged for rejection' }
    default:          return { state: 'pending',  description: 'AI review: changes requested' }
  }
}

// ── Label helpers ──────────────────────────────────────────────────────────

const ALL_AI_LABELS = ['ai-approved', 'ai-flagged', 'ai-changes-requested']

async function ensureLabelExists(name, color, description) {
  try {
    await ghGet(`/repos/${REPO}/labels/${encodeURIComponent(name)}`)
  } catch {
    // Label doesn't exist yet — create it
    try {
      await ghPost(`/repos/${REPO}/labels`, { name, color, description })
    } catch { /* ignore if it already exists (race condition) */ }
  }
}

async function ensureAllLabels() {
  await Promise.all([
    ensureLabelExists('ai-approved',           '0e8a16', 'AI review: approved for merge'),
    ensureLabelExists('ai-flagged',            'b60205', 'AI review: flagged for rejection'),
    ensureLabelExists('ai-changes-requested',  'e4e669', 'AI review: changes requested'),
  ])
}

async function setLabel(label) {
  // Remove any existing AI labels first
  for (const l of ALL_AI_LABELS) {
    try {
      await fetch(`${GH_API}/repos/${REPO}/issues/${PR_NUMBER}/labels/${encodeURIComponent(l)}`, {
        method: 'DELETE',
        headers: ghHeaders(),
      })
    } catch { /* label not present — ok */ }
  }
  await ghPost(`/repos/${REPO}/issues/${PR_NUMBER}/labels`, { labels: [label] })
}

async function postComment(body) {
  await ghPost(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, { body })
}

async function setCommitStatus(sha, state, description) {
  await ghPost(`/repos/${REPO}/statuses/${sha}`, {
    state,
    description,
    context: 'ai-review / claude',
    target_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
  })
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖  Stage 2 AI review — PR #${PR_NUMBER}`)

  // 1. Fetch PR metadata
  const pr = await getPR()
  const headSha = pr.head.sha
  console.log(`    Head SHA: ${headSha}`)
  console.log(`    Author:   ${pr.user.login}`)

  // 2. Find the changed entry
  console.log('\n📋  Resolving changed index.json entry…')
  const entry = await getChangedEntry()
  if (!entry) {
    const msg = '> **AI review skipped** — could not identify a changed plugin entry in `index.json`.'
    await postComment(msg)
    console.log('    No changed entry found. Skipping.')
    return
  }
  console.log(`    Entry: ${entry.id} v${entry.version}`)
  console.log(`    Source URL: ${entry.sourceUrl}`)

  // 3. Fetch plugin source code
  console.log('\n⬇️   Fetching plugin source…')
  let code
  try {
    code = await fetchPluginCode(entry.sourceUrl)
    console.log(`    Fetched ${code.length} characters`)
  } catch (err) {
    const msg = `> **AI review could not start** — failed to fetch plugin source code.\n>\n> Error: \`${err.message}\``
    await postComment(msg)
    await setCommitStatus(headSha, 'error', 'AI review: could not fetch plugin source')
    console.error(`    Fetch failed: ${err.message}`)
    process.exit(1)
  }

  // 4. Call Claude
  console.log('\n🧠  Calling Claude for review…')
  let review
  try {
    review = await callClaude(REVIEW_PROMPT(entry, code))
    console.log('    Review received.')
  } catch (err) {
    const msg = `> **AI review failed** — Anthropic API error.\n>\n> Error: \`${err.message}\``
    await postComment(msg)
    await setCommitStatus(headSha, 'error', 'AI review: Anthropic API error')
    console.error(`    Anthropic error: ${err.message}`)
    process.exit(1)
  }

  // 5. Parse recommendation
  const rec   = parseRecommendation(review)
  const label = recommendationToLabel(rec)
  const { state, description } = recommendationToStatus(rec)
  console.log(`    Recommendation: ${rec}  →  label: ${label}`)

  // 6. Post formatted PR comment
  const recEmoji = rec === 'APPROVE' ? '✅' : rec === 'REJECT' ? '❌' : '⚠️'
  const commentBody = [
    `## 🤖 AI Code Review — \`${entry.id}\` v${entry.version}`,
    '',
    `> **Recommendation: ${recEmoji} ${rec}**`,
    '',
    '---',
    '',
    review.replace(/RECOMMENDATION:\s*(APPROVE|REQUEST_CHANGES|REJECT)\s*$/i, '').trimEnd(),
    '',
    '---',
    '',
    `*Reviewed by Claude (${new Date().toISOString()})*`,
    `*This review is advisory — the repo owner makes the final merge decision.*`,
  ].join('\n')

  await ensureAllLabels()
  await postComment(commentBody)
  await setLabel(label)
  await setCommitStatus(headSha, state, description)

  console.log(`\n✅  Done. Comment posted, label "${label}" applied, status: ${state}.`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
