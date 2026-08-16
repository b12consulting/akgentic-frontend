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

- **Chat panel** — the multi-party conversation, with per-agent thinking bubbles and tool-call history
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

## Building

```bash
npm run build                        # default (development)
npm run build -- --configuration production
npm run build -- --configuration dep
npm run build -- --configuration local
```

Artifacts land in `dist/`. `frontend.Dockerfile` + `nginx.conf` build the container image, which
serves the static bundle and expects `config.json` to be mounted or baked in per environment.

## Tests

Karma + Jasmine. Use the headless invocation — plain `ng test` opens a browser and is not what CI or
the workspace tooling runs:

```bash
npm run test -- --watch=false --karma-config=karma.conf.js --browsers=ChromeHeadlessNoSandbox
```

`CHROME_BIN` is set ambiently by the workspace tooling; do not prepend it manually.

There is **no** end-to-end suite and no GitHub Actions pipeline in this repository — the local Karma
run is the completion gate for a story.

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
