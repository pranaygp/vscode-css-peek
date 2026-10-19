# Releasing CSS Peek

Release the VSIX produced by a successful CI run. Publish that same archive to each registry and attach it to the GitHub release.

## One-time publishing access

- **GitHub:** authenticate `gh` with repository write access and configure Git signing. All commits and version tags must be signed.
- **Visual Studio Marketplace:** create an Azure DevOps personal access token for the `pranaygp` publisher with **Marketplace → Manage** scope. Store it in 1Password as **VS Code Marketplace Token**, in the `password` field. Supply it as `VSCE_PAT` when publishing. See the [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
- **Open VSX:** use a personal access token authorized for the `pranaygp` namespace. Supply it as `OVSX_PAT`. See the [Open VSX publishing guide](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions).

Keep credentials out of command arguments, Git, and logs. A local environment file for `op run` can contain secret references, for example:

```dotenv
VSCE_PAT=op://YOUR_VAULT/VS Code Marketplace Token/password
OVSX_PAT=op://YOUR_VAULT/YOUR_OPEN_VSX_ITEM/YOUR_TOKEN_FIELD
```

Use only the variables needed for the selected registry. The environment file contains references, not token values; keep it outside the checkout. `op run` resolves the references into the publishing process environment.

## 1. Prepare and verify the changes

Update `package.json`'s version and add dated release notes to `CHANGELOG.md`. Use Node.js 24 and Yarn 1.22.22:

```sh
yarn install --frozen-lockfile
yarn build
yarn lint
yarn prettier
yarn test                    # Linux: xvfb-run -a yarn test
yarn test:web                # first: yarn playwright install chromium
yarn audit:dependencies
yarn package
yarn verify:package
```

Create signed commits and open a PR titled `[OpenAI Codex] ...` when working through Codex. Include a real screenshot for UI changes. CI must pass all jobs: stable VS Code on Linux/macOS/Windows, minimum supported VS Code, each completion-extension compatibility combination, Chromium integration, dependency auditing, and VSIX verification.

## 2. Merge and obtain the release archive

Merge after the PR checks pass. Wait for the `CI` workflow on the resulting `master` commit to pass too. Select that run, not an older build:

```sh
git fetch origin
git switch master
git merge --ff-only origin/master
gh run list --workflow ci.yml --branch master --limit 5

releaseRun=THE_SUCCESSFUL_MASTER_RUN_ID
gh run watch "$releaseRun" --exit-status
releaseVersion=$(node -p 'require("./package.json").version')
artifactDir=$(mktemp -d)
gh run download "$releaseRun" --name extension-vsix --dir "$artifactDir"
releaseVsix="$artifactDir/vscode-css-peek-$releaseVersion.vsix"
yarn verify:package "$releaseVsix"
```

Confirm the selected run's commit is `git rev-parse HEAD` and the archive's version matches the intended release. Keep this archive for both registries; do not rebuild between publishing steps.

## 3. Tag and create the GitHub release

```sh
git tag -s "v$releaseVersion" -m "CSS Peek $releaseVersion"
git push origin "v$releaseVersion"
gh release create "v$releaseVersion" "$releaseVsix" \
  --verify-tag --title "CSS Peek $releaseVersion" \
  --notes-file /path/to/release-notes.md
```

Release notes should describe behavior changes, the minimum VS Code version, and material limitations. Use the corresponding changelog section as the starting point.

## 4. Publish the verified archive

```sh
# Both registries, with both credential references configured:
op run --env-file /path/to/release.env -- ./publish.sh all "$releaseVsix"

# Or publish each registry separately:
op run --env-file /path/to/release.env -- ./publish.sh open-vsx "$releaseVsix"
op run --env-file /path/to/release.env -- ./publish.sh marketplace "$releaseVsix"
```

The script validates the archive, uses environment credentials, and publishes without repackaging. If one registry succeeds and another fails, retry only the failed registry. To prepare Marketplace without publishing there, complete the GitHub release and retain the verified VSIX; run the Marketplace command later when authorized and credentials are ready.

Verify the public version and download/install the published archive from [Marketplace](https://marketplace.visualstudio.com/items?itemName=pranaygp.vscode-css-peek) and/or [Open VSX](https://open-vsx.org/extension/pranaygp/vscode-css-peek). Registry indexing can take time. Run `yarn verify:package` against the downloaded VSIX too.

## 5. Close issues with evidence

Link the merged PR and published release in each resolved issue, explain the verified behavior, and close it as completed. Distinguish an actual fix from a current non-reproduction. Close stale reports that lack requested details as not planned, with an invitation to provide a minimal reproduction. Leave unsupported feature requests open and state their remaining scope.

Close obsolete dependency PRs only after confirming their dependency was upgraded or removed by the release. Re-fetch issue/PR states to verify that the intended closures succeeded.
