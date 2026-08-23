# akgentic-frontend

Angular 19 web client for the
[Akgentic](https://github.com/b12consulting/akgentic-framework) multi-agent framework
(open-source bundle).

It talks to `akgentic-infra` over **HTTP + WebSocket** and holds no framework code of its own. That
boundary is deliberate: the frontend is the one Akgentic package that is *not* part of the Python UV
workspace and has no Python import relationship with any other package — the contract between them is
a network protocol, not a module dependency. It is distributed as an npm/container artifact, not on
PyPI, so it is absent from the `akgentic-framework` bundle distribution.

## What it renders

A running team, from a single append-only event log fed by one WebSocket:

- **Chat panel** — the multi-party conversation, with per-agent thinking bubbles and tool-call
  history. A message an agent absorbs **mid-run** — read out of its own inbox rather than waiting for
  a turn — gets its own bubble, under the message it answers, instead of disappearing into the turn
  that absorbed it
- **Graph / tree** — live agent topology, built from `StartMessage`/`StopMessage` and message edges
- **Messages tab** — the raw protocol log, including the error / warning / notification family
- **Per-agent tabs** — state, LLM context, system prompt, token usage, workspace files
- **Knowledge-graph panel** — reconnected through `ToolStateEvent`
- **Catalog admin** — templates, tools, agents, teams

Architecture documentation lives in the parent
[akgentic-framework](https://github.com/b12consulting/akgentic-framework) bundle at
`_bmad-output/akgentic-frontend/architecture/` (sharded; start at `index.md`). Decision records are in
`_bmad-output/akgentic-frontend/decisions/`.

## Prerequisites

- Node 20+ and npm
- A running `akgentic-infra` backend — by default on `http://localhost:8000`

## Running against a local backend

Start the backend first, from the root of the `akgentic-framework` bundle checkout:

```bash
python src/infra_server.py          # serves on :8000, no auto-reload — restart to load code changes
```

Then the frontend:

```bash
npm install
npm start                            # ng serve on http://localhost:4200, hot-reloads on save
```

## Configuration

Configuration is resolved in two layers, so one build can be deployed to several environments:

1. **Build-time defaults** — `src/environments/environment.ts`, swapped per build configuration via
   `fileReplacements` (`dep`, `local`, `production`).
2. **Runtime overrides** — `public/config.json`, fetched relative to the document base href by
   `ConfigService` under `APP_INITIALIZER` and merged *over* the build-time defaults. Absent or
   unreadable (the local-dev case), the defaults stand.

Inject `ConfigService` to read configuration. Do **not** import `environment` directly — that bypasses
the runtime layer and silently ignores whatever the deployment set.

Recognised keys: `api`, `logo`, `favicon`, `welcomeMessage`, `autoRedirectContext`, `hideHome`,
`hideLogin`, `initRightPanelCollapsed`, `userInputEnterKeySubmit`, `loginProviders`, `production`.

### Using config.json

`config.json` lives **next to `index.html` in the deployed web root** and contains only the keys you
want to override — anything absent falls back to the build-time default. The repository ships an
empty `public/config.json` (`{}`), so a plain build behaves exactly like `environment.ts`.

Example — point a deployed bundle at another backend and trim the login options:

```json
{
  "api": "https://akgentic.example.com",
  "hideHome": true,
  "loginProviders": ["apikey"]
}
```

To configure a deployment, **replace the file after (or outside) the build** — never rebuild:

- **Static hosting / nginx**: drop your `config.json` into the web root, overwriting the shipped one.
- **Docker**: mount it over the baked-in copy:

  ```bash
  docker run -v ./config.json:/usr/share/nginx/html/config.json:ro <image>
  ```

- **Kubernetes**: project a ConfigMap onto `/usr/share/nginx/html/config.json`.

The file is fetched once, before the app renders, relative to the document base href — it honours a
non-root `--base-href` deployment. A malformed or missing file is not an error: the build-time
defaults stand. Verify what a running deployment resolved by fetching `<app-url>/config.json`
directly in a browser.

## Building

```bash
npm run build                        # default (development)
npm run build -- --configuration production
npm run build -- --configuration dep
npm run build -- --configuration local
```

Artifacts land in `dist/akgent-app/browser` — that folder is the deployable web root.
`frontend.Dockerfile` + `nginx.conf` build the container image, which serves the static bundle and
expects `config.json` to be mounted or baked in per environment (see *Using config.json* above).

## CI and releasing

`.github/workflows/ci.yml` runs on every push and on PRs to `master`: `npm ci`, lint, the headless
Karma suite (with coverage), and a production build. A story is not done until this pipeline is
green.

`.github/workflows/release.yml` is a **manual** workflow (Actions tab → Release → *Run workflow*),
mirroring the Python packages' release flow:

1. Merge a `chore: bump version to X.Y.Z` PR updating `version` in `package.json`.
2. Trigger the workflow, picking the branch (default `master`). It tags `vX.Y.Z`, builds the
   production bundle, and publishes a GitHub Release with `akgentic-frontend-vX.Y.Z.tar.gz`
   attached — the tarball is the web root, ready to extract behind any static file server.

The released bundle is **environment-agnostic**: deploy the same tarball everywhere and configure
each environment with its own `config.json`.

## Tests

Karma + Jasmine. Use the headless invocation — plain `ng test` opens a browser and is not what CI or
the workspace tooling runs:

```bash
npm run test -- --watch=false --karma-config=karma.conf.js --browsers=ChromeHeadlessNoSandbox
```

`CHROME_BIN` is set ambiently by the workspace tooling; do not prepend it manually.

There is **no** end-to-end suite. The same lint + headless-Karma + production-build sequence runs in
CI (see *CI and releasing*).

```bash
npm run lint                         # eslint over src/**/*.ts
```

## Working in this repository

This package is a git submodule of the
[akgentic-framework](https://github.com/b12consulting/akgentic-framework) bundle. Clone that
repository and run `git submodule update --init` to get a checkout with the frontend in place, then
read its `CLAUDE.md` before contributing — it carries the Golden Rules (branch/issue conventions,
commit standards, module boundaries) that apply to every change here.

Every branch is linked to a GitHub issue and named `<type>/<issue-number>-<short-description>`.
Commits are signed (`git commit -s`) and follow Conventional Commits. Never push directly to `master`.

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](https://github.com/b12consulting/akgentic-frontend/blob/master/LICENSE).

> **Dual licensing & CLA** — Akgentic is available under the AGPL-3.0 open-source license. A commercial license is also planned for organizations that require alternative terms. Contact [Yuma](https://www.weareyuma.com/en/contact) for more information. External contributions will be accepted once a Contributor License Agreement (CLA) is in place. Until then, please hold off on submitting pull requests.
