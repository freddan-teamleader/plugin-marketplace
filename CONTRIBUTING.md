# Contributing to the Plugin Marketplace

Anyone with a GitHub account can submit a plugin. Here's how.

## Before you submit

1. **Build and test your plugin** in the Dashboard (use the chat to create and install it).
2. **Push your plugin file to a public GitHub repo.**
3. **Get the exact commit SHA** of the version you want to publish:
   ```bash
   git rev-parse HEAD
   ```
4. **Construct your `sourceUrl`** using that SHA:
   ```
   https://raw.githubusercontent.com/you/your-repo/THE_SHA/your-plugin.js
   ```
   Using a branch name (`main`, `master`) is not allowed — the SHA ensures the reviewed
   code cannot change after approval.

## Submitting

1. Fork this repository.
2. Open `index.json` and add your entry. Use `PLUGIN_TEMPLATE.md` as a guide.
3. Set `"status": "pending"` — do not set it to `"approved"` yourself.
4. Open a Pull Request against `main`. Fill in the PR checklist.
5. The automated validation (Stage 1) will run within seconds. Fix any reported issues.
6. Once Stage 1 passes, a reviewer will trigger the AI review (Stage 2) and merge if approved.

## Rate limits

To keep the review queue manageable, each GitHub account may have at most **3 open PRs**
at a time. The CI will reject a 4th submission until one of the existing PRs is closed.

## Updating an existing plugin

Open a new PR bumping `version`, `sourceUrl` (new SHA), and `publishedAt`. The full
review pipeline runs again. Your old approved version stays live until the PR is merged.

## Code of conduct

Submissions must not contain malicious code, exfiltrate user data, or violate anyone's
privacy or intellectual property. Violations result in immediate rejection and a ban.
