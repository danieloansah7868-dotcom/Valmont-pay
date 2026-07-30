# CI workflow (needs one manual step)

`github-workflow-ci.yml` is the CI definition for this repo. It could not be
committed to `.github/workflows/` automatically because the GitHub App that
opened the PR does not hold the `workflows` permission, so GitHub rejects the
push.

**To activate it**, a maintainer runs:

```bash
mkdir -p .github/workflows
git mv ci/github-workflow-ci.yml .github/workflows/ci.yml
git commit -m "Enable CI"
git push
```

## What it does

It runs `npm run verify:modules` as its own step, before the tests, so a module
that is missing, untracked or empty shows up as an obvious red X instead of a
confusing failure buried in test output.

## Until then, the guard still runs

`npm run verify:modules` is the **first** command in `npm test`, so the check is
enforced by any CI that runs the test suite, by Vercel if you set the build
command to `npm test`, and locally. Moving the workflow file only adds a
dedicated, clearly-labelled CI step.

## Recommended: also make it a pre-push hook

```bash
git config core.hooksPath .githooks
mkdir -p .githooks
cat > .githooks/pre-push <<'HOOK'
#!/bin/sh
npm run verify:modules || exit 1
HOOK
chmod +x .githooks/pre-push
```

This catches an uncommitted module before it ever reaches a deployment.
