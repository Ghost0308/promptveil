# Releasing

Releases go to npm through trusted publishing. GitHub Actions proves to npm which workflow is running, so there's no npm token to store or leak, and npm attaches provenance to every version it publishes this way. The workflow is [release.yml](../.github/workflows/release.yml).

## Once, on GitHub

Go to Settings, then Environments, and create `npm`. Add yourself as a required reviewer, and under deployment branches and tags allow only tags matching `v*`. Then nothing gets published without a click from you.

## The first release

npm sets up trusted publishing from a package's own settings page, so the package has to exist before it can be used. The first version goes up by hand, using the exact tarball CI built and tested:

1. Do steps 1 to 3 from "Each release" below.
2. When the Release workflow asks for approval of the `npm` environment, reject it. The build job has already uploaded the tarball as the `package` artifact of that run.
3. Download the artifact from the run page, unzip it, and publish the tarball from your own machine:

   ```
   npm login
   npm publish promptveil-0.1.0.tgz
   ```

4. On npmjs.com, open the package, go to Settings, and add a trusted publisher for GitHub Actions:
   - Organization or user: `Ghost0308`
   - Repository: `promptveil`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
   - Allowed actions: tick `npm publish`

5. In the same settings, under Publishing access, choose "Require two-factor authentication and disallow tokens". Trusted publishing keeps working, since it doesn't use tokens.

The trusted publisher has to complete a publish within 2 days of being added, or it expires and has to be added again. So add it when the next release is close, or right after the first one and then ship a small release.

## Each release

1. On a branch, set `version` in `package.json` (run `npm version 0.1.0 --no-git-tag-version` so the lockfile follows) and turn the top of `CHANGELOG.md` into a heading for that version.
2. Open a PR, wait for CI, and merge it with "Rebase and merge".
3. Tag the merged commit on main and push the tag:

   ```
   git switch main
   git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. The Release workflow type-checks, runs the tests, builds and packs, checks the tag matches the version, then waits for you to approve the `npm` environment. Approve it and the package goes up with provenance.

If the tag and the version don't match, the build stops before anything is published. Delete the tag, fix the version and tag again.
