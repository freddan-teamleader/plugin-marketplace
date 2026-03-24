# Plugin Template

Copy this entry into `index.json` and fill in all fields before opening a PR.

```json
{
  "id": "your-github-username-plugin-slug",
  "name": "Your Plugin Name",
  "description": "One or two sentences describing what the plugin does.",
  "author": "your-github-username",
  "authorUrl": "https://github.com/your-github-username",
  "version": "1.0.0",
  "tags": ["tag1", "tag2"],
  "license": "MIT",
  "sourceUrl": "https://raw.githubusercontent.com/your-github-username/your-repo/FULL_COMMIT_SHA/your-plugin.js",
  "publishedAt": "2026-01-01T00:00:00Z",
  "status": "pending",
  "verified": false,
  "maintainer": {
    "github": "your-github-username/your-repo",
    "allowPRs": true,
    "prBranch": "main"
  }
}
```

## Rules

- `id` must be unique and follow `kebab-case`. Convention: `author-pluginname`.
- `sourceUrl` **must** point to a specific commit SHA, not a branch like `main`.
  Get the SHA from your repo: `git rev-parse HEAD`
  Then use: `https://raw.githubusercontent.com/owner/repo/THE_SHA/plugin.js`
- `status` must be `"pending"` when submitting. The reviewer sets it to `"approved"`.
- `verified` must be `false`. Only the marketplace owner can set this to `true`.
- `license` should be a valid SPDX identifier (e.g. `"MIT"`, `"Apache-2.0"`).
- `tags` should be lowercase, short, and descriptive.
