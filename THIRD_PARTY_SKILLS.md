# Third-party skills

Installed on 2026-10-31 for local OpenCode use; UI/UX Pro Max and the DocDown
design skill were added on 2026-11-11. Skills are development-time instructions
only; they are not loaded into the extension and add no runtime dependency.

## Installed

Location: `.opencode/skills/`

| Source | Commit | License | Skills |
|---|---|---|---|
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e` | MIT | `planning-and-task-breakdown`, `incremental-implementation`, `test-driven-development`, `debugging-and-error-recovery`, `code-review-and-quality`, `security-and-hardening`, `performance-optimization`, `code-simplification` |
| [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) | `4f2b13e25c5815b3f080ca0d983e828d96561a0f` | Apache-2.0 | `chrome-extensions` |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | `8909f6af8806897cbb8330c11028eee168ad7cc7` | MIT (repo LICENSE is a scope note; `skills/` is not in the BSL list) | `caveman-commit` |
| [blader/humanizer](https://github.com/blader/humanizer) | `d4b81278e6604e237bf32f0f7ce5c217aee94269` | MIT | `humanizer` |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `6ae86f61f520d6ca229d2f40e070410638c908c5` / CLI `2.15.0` | MIT | `ui-ux-pro-max` |
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | `fcc70284932276d085f01ef9f83edde90b1258cb` | MIT | `linear.app` DESIGN.md used as a reference for `DESIGN.md` |
| Local DocDown skill | n/a | same as this repository | `docdown-design` (reads `/DESIGN.md`) |

Shared checklists: `.opencode/references/` (from `addyosmani/agent-skills`).
License texts: `.opencode/licenses/` and
`.opencode/skills/ui-ux-pro-max/LICENSE`.

## Audit notes

- Most installed files are `.md`; no executable scripts, binaries, or archives.
- **Exception:** `ui-ux-pro-max` includes Python 3 search scripts and CSV data
  under `.opencode/skills/ui-ux-pro-max/`. They use the standard library only,
  make no network calls, and are never referenced by `manifest.json`,
  `background.js`, `print.html`, content scripts, or any extension page.
- Scanned for `eval`, `new Function`, shell download commands, encoded payloads,
  cookie/storage access, and suspicious network endpoints. The only hits are
  documentation examples and security warnings.
- No Chrome DevTools MCP or other MCP server was installed.
- The extension source itself was not modified by this installation.

## Updating

Re-clone the source repos, review the diff of the selected skill directories,
copy them over, and update the commit hashes above. Do not update blindly.
