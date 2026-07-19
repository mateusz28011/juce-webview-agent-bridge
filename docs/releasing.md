# Releasing

The runbook for cutting a release. Follow it in order — the steps are ordered so
that anything that can fail does so **before** the tree is mutated or anything is
published.

## Who owns what

| Thing | Owner | Notes |
|---|---|---|
| The 6 version sites | `scripts/release.sh` | Never bump by hand. Each site is written by `sed` and then verified by `grep`, so an unmatched substitution aborts the release. |
| `CHANGELOG.md` | **You, by hand** | The script does not touch it. This is the only prepared-by-hand step, so it is the one that gets forgotten — see the gate below. |
| Tag, GitHub Release, npm publish | `.github/workflows/release.yml` | The normal path. `scripts/release.sh` directly is for local recovery. |

The six version sites: `package.json`, `package-lock.json`, the JUCE module
declaration `version:`, the `WEB_AGENT_BRIDGE_VERSION` macro that the `hello`
reply reports, `tests/CMakeLists.txt`, and the README `GIT_TAG` pin. The last two
of those live in the same file as each other's neighbours, so a release commit
touching only 5 files is normal.

## 1. Agree the exact version

Get explicit approval for the exact target version and the release action. Never
infer it from a request to prepare files.

Pick the bump by what actually changed, not by how big the diff feels:

- **patch** — bug fixes and wording only. No new public API, no new protocol field.
- **minor** — anything additive: a new export, a new `Page` member, a new field in
  the `hello` reply, a new op.
- **major** — a breaking change. A breaking wire change also bumps `protocolVersion`.

Adding exports and shipping it as a patch misleads everyone pinned to `~x.y.z`.

## 2. Prepare the changelog — the step that gets skipped

This is manual and nothing else does it for you:

1. Move the `[Unreleased]` entries under a new `## [X.Y.Z] - YYYY-MM-DD`.
   **Move**, do not copy.
2. Leave a new, empty `[Unreleased]` section above it.
3. Update the bottom links: add
   `[X.Y.Z]: <repo>/releases/tag/vX.Y.Z`, and repoint
   `[Unreleased]: <repo>/compare/vX.Y.Z...HEAD`.

Write entries from the user's perspective — behaviour and compatibility, not
commit subjects, internal recovery steps, or marketing copy.

### The gate

`scripts/release.sh` refuses to release unless all four of the above hold, and it
checks this **before mutating anything**, so a failure leaves the tree untouched
and you can simply fix the changelog and re-run. `tests/release.test.mjs` proves
the gate fires, and also asserts that the repo's own changelog has a section and
link for whatever version `package.json` currently claims — so a released-but-
undocumented state fails CI rather than sitting there unnoticed.

This gate exists because v0.5.0 shipped with its entries still under
`[Unreleased]`, no `[0.5.0]` section, and links still pointing at v0.4.0. The
procedure was already written down and was still missed; a check that fails loudly
is the only thing that reliably prevents it.

## 3. Verify locally before triggering anything

```bash
npm run build && npm test && npm run test:types
npm pack --dry-run
cmake --build build/test && ctest --test-dir build/test --output-on-failure
```

Do not release with a failing or skipped required suite.

## 4. Run the release

Use the manual `release.yml` workflow and choose `patch` / `minor` / `major`:

```bash
gh workflow run release.yml -f bump=minor
gh run watch <run-id> --exit-status
```

**Do not push anything else to `main` while it runs.** The publish job
deliberately refuses to release if `main` moved after the tests ran.

## 5. Verify the result — do not trust the exit code alone

```bash
gh run view <run-id> --json status,conclusion
gh release view vX.Y.Z --json tagName,name,isDraft,isPrerelease
npm view juce-webview-agent-bridge version dist-tags engines license
npm audit signatures                       # provenance attestation (OIDC, no tokens)
git fetch origin --tags && git merge --ff-only origin/main
git status --short                         # must be clean
```

Also open the GitHub Release: the title must be exactly `vX.Y.Z`, and the body
should mirror the released changelog section in shorter form, ending with the full
comparison link. Avoid slogans and generic descriptions.

## If something fails midway

- **GitHub/tag succeeded, npm failed** — re-run the workflow with `retry_version`
  set to that existing version. **Never** create a replacement tag or bump again
  merely to retry npm.
- **Failure before the push** — the repo is left inspectable and retryable. Worst
  case is a local annotated tag that was never pushed: push that tag, never re-run
  the bump.
- Never use `git push --follow-tags`; it can publish other reachable tags.
