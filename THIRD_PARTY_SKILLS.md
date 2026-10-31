# Third-party skills

Installed on 2026-10-31 for local OpenCode use. Skills are Markdown instructions
only; they are not loaded into the extension and add no runtime dependency.

## Installed

Location: `.opencode/skills/`

| Source | Commit | License | Skills |
|---|---|---|---|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e` | MIT | `planning-and-task-breakdown`, `incremental-implementation`, `test-driven-development`, `debugging-and-error-recovery`, `code-review-and-quality`, `security-and-hardening`, `performance-optimization`, `code-simplification` |
| [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) | `4f2b13e25c5815b3f080ca0d983e828d96561a0f` | Apache-2.0 | `chrome-extensions` |

Shared checklists: `.opencode/references/` (from `addyosmani/agent-skills`).
License texts: `.opencode/licenses/`.

## Audit notes

- All installed files are `.md`; no executable scripts, binaries, or archives.
- Scanned for `eval`, `new Function`, shell download commands, encoded payloads,
  cookie/storage access, and suspicious network endpoints. The only hits are
  documentation examples and security warnings.
- No Chrome DevTools MCP or other MCP server was installed.
- The extension source itself was not modified by this installation.

## Updating

Re-clone the source repos, review the diff of the selected skill directories,
copy them over, and update the commit hashes above. Do not update blindly.
