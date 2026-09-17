# akgentic-frontend

Angular 19 web client for the
[Akgentic](https://github.com/b12consulting/akgentic-framework) multi-agent framework
(open-source bundle).

It talks to `akgentic-infra` over **HTTP + WebSocket** and holds no framework code of its own. That
boundary is deliberate: the frontend is the one Akgentic package that is *not* part of the Python UV
workspace and has no Python import relationship with any other package — the contract between them is
a network protocol, not a module dependency. It is distributed as an npm/container artifact, not on
PyPI, so it is absent from the `akgentic-framework` bundle distribution.

## The surface

![The console on /process/:id — the rail on the left, the conversation pane in the middle, and the
inspector's Team tab on the right showing the roster, the team's tools and its token
spend](screenshot.png)

Two pages, inside one persistent shell. Everything on them is derived from a single append-only
event log fed by one WebSocket — there is no second source of truth and no polling.

**`/` — the teams list.** The teams you own, server-paginated, each row carrying the business
metadata its team type declares. Filter by any searchable metadata field and by team type; the filter
and page live in the URL, so a view can be shared, bookmarked, and survives a refresh or a trip into
a team and back. The namespace editor opens from here, over the selected namespace.

**`/process/:id` — a running team.** Two panes beside the shell's rail:

- **The conversation pane** — the multi-party transcript, with per-agent thinking bubbles and
  tool-call history. A message an agent absorbs **mid-run** — read out of its own inbox rather than
  waiting for a turn — gets its own bubble under the message it answers, instead of disappearing into
  the turn that absorbed it.
- **The inspector** ("Team details"), a tab strip over six panels:

| Tab | Shows |
|---|---|
| Team | the roster — members, their tools, and what the team has spent |
| Hierarchy | agent topology as a force-directed graph and a tree, built from `StartMessage` / `StopMessage` and message edges |
| Member | one member's LLM context: pick an agent, read the system prompt and the trace of what it was sent |
| Workspaces | the files a team's agents can read and write |
| Knowledge graph | present **only when a knowledge-graph tool is**, driven by `ToolStateEvent` |
| Messages | the raw protocol log, including the error / warning / notification family |

The Knowledge-graph tab is the one that appears and disappears: `ToolPresenceService.hasKnowledgeGraph$`
adds it when the team actually carries that tool, so the strip reflects the team rather than a fixed
menu.

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
`hideLogin`, `initRightPanelCollapsed`, `userInputEnterKeySubmit`, `loginProviders`, `production`,
`languages`, `defaultLanguage`.

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

## Layout

`src/app/` is **two top-level folders over seven ordered tiers**, split by DIRECTORY rather than by
naming convention so the split cannot erode quietly. `core/` is the framework-maintained part;
`ui/` is the part you replace.

```
src/app/
├── app.config.ts  app.routes.ts  app.component.ts     composition root
│      the ONLY place that names a `ui/` symbol
│
├── core/                                framework-maintained
│   ├── protocol/        the wire contract with akgentic-infra
│   ├── shared/          pure functions, pipes
│   ├── platform/        http · auth · i18n · config · context
│   ├── services/        ingestion · selectors · reactors · session ·
│   │                    ui-state · workspace
│   └── components/      THE LIBRARY
│       ├── primitives/  domain-free controls
│       └── features/    self-contained widgets, wired to services
│
└── ui/                  pages and shell. Nothing may import this.
```

`src/app/ui/README.md` covers the other half of this: how the shell, the two pages and the inspector
fit together at runtime, and why the rail survives navigation while the inspector does not. This
section is the import rules; that one is the arrangement.

**`core/` is a namespace, not a tier.** Each tier below names itself; there is deliberately no
element type covering `core/` as a whole, because one would make every edge inside it legal in both
directions while the lint still passed.

This is the normative table. It is not a description of intent: each row is an
`eslint-plugin-boundaries` element type and each **May import** cell is that type's allow list. The
rule set's default is `disallow`, so **any edge not in this table is refused**.

| Element type | Folder | May import | May NOT import |
|---|---|---|---|
| `protocol` | `core/protocol/` | *nothing* | everything |
| `shared` | `core/shared/` | `protocol` | `platform` `services` `primitives` `features` `ui` |
| `platform` | `core/platform/` | `shared` `protocol` | `services` `primitives` `features` `ui` |
| `services` | `core/services/` | `platform` `shared` `protocol`, and the `svc-*` sub-tiers below | **`primitives` `features`** `ui` |
| `primitives` | `core/components/primitives/` | `platform` `shared` `protocol`, and each other | **`services`** `features` `ui` |
| `features` | `core/components/features/` | `primitives` `services` `platform` `shared` `protocol`, and each other | `ui` |
| `ui` | `ui/` | everything below, and each other | — |

**`core/services/` has its own ordered taxonomy inside it**, and `svc-` is simply the element-type
prefix for those sub-tiers — short for *service*. They are not extra folders: each name is the
`boundaries` type covering one directory under `core/services/process/`, so the order *within* the
data layer is enforced rather than flattened by the one folder name above it.

| Element type | Directory | Holds |
|---|---|---|
| `svc-models` | `process/models/` | the shapes the rest of the tier folds into |
| `svc-event` | `process/event/` | ingestion — the socket, the append-only log, replay, the per-agent stores, and the reactors that turn log entries into toasts and status changes |
| `svc-selectors` | `process/selectors/` | pure folds of the log: chat, graphs, token usage, workspace registry |
| `svc-ui-state` | `process/ui-state/` | selection and feedback — state a view reads, but not a view |
| `svc-workspace` | `process/workspace/` | REST file contents and directory listings |
| `svc-session` | `process/session/` | `TeamSessionService` — composes the others into "open a team" |

The order runs `svc-models ← svc-event ← svc-selectors ← svc-ui-state`, with `svc-session`
composing them. A selector may read events; an event unit may not read a selector.

Three cells carry the design and a future reader will be tempted by each:

- **`services` may not import `primitives` or `features`.** A selector reaching into a widget is the
  inversion the whole tree exists to prevent.
- **`primitives` may not import `services`.** This is what makes "primitive" decidable — see below.
  It covers **type imports as well as injections**.
- **Nothing may import `ui`.** That is the property that makes a second UI possible: a second console
  is built by writing a new `ui/` against the same `core/components/` and `core/services/`.

**Which outside packages a tier may draw on is enforced too**, by the same rule set and the same
`disallow` default. The lower tiers carry exhaustive, measured allow lists — `core/shared/` may name
`@angular/core`, `lodash` and `js-yaml` and nothing else — while `features/` and `ui/` are
deliberately unrestricted, because drawing on the outside world is what they are for. The lists match
the **whole specifier**, not the package name, which is how `core/services/` can use
`@angular/cdk/clipboard` (headless) while `@angular/cdk/dialog` stays refused.

### Which tier does a component belong to?

A component is a **primitive** if it **names no domain concept**. It knows nothing of teams, agents,
messages, workspaces, namespaces or the event log; its inputs are strings, numbers, booleans and
i18n keys. Two tests, applied in order:

1. **Mechanical, and lint-enforced:** does it import anything from `core/services/`? If yes it is not
   a primitive. Type imports count.
2. **Editorial, and settled by review:** is it meaningful outside one feature? If it belongs to one
   capability, it lives in that capability's folder under `features/` — whether or not it injects
   anything.

Test 1 alone is not sufficient, and that is the substance of the rule. A team table might import
nothing from `core/services/` and still be a table of *teams*; putting it in `primitives` would give
the domain-free tier a teams list. Test 2 is what prevents that, and it is why the primitives tier is
deliberately **small** — five components today. A primitives folder that grows a `TeamCard` has
stopped being one, and only test 2 will catch it.

Everything else in the library is a **feature**: a self-contained widget that may inject the data
layer, nested by composition, so a component appearing only ever inside one other component is a
subfolder of it. A **page or shell** — anything that assembles features into a route or into the
chrome around one — is `ui/`.

Two rules cover the team's services and are worth knowing before adding one:

- They are provided on the **`process/:id` route**, not on `ProcessComponent`. A component that
  silently requires a particular ancestor is not a component you can place, and that ancestor
  requirement was the thing standing between these panels and being reusable.
- Never `providedIn: 'root'`. The route injector dies when you leave the route; a root one would
  carry one team's socket, log and per-agent stores into the next.

### What the lint gate does and does not catch

`eslint.config.js` enforces the direction with `boundaries`, and each layer is its own element
**type** — a shared type would make every edge legal in both directions, because the plugin cannot
express direction within a type.

It catches a component importing `ui/`, a selector importing `ui-state`, a service importing a view.
It does **not** catch a dumb component injecting a data service, and cannot: an `@Input` is typed by
the selector that produces it, so a type import and a service injection are the same edge to the
linter. That half is a review rule, and the classification above is how it is applied.

`docs/message-display-flow.md` traces one boundary end to end: how a frame on the socket becomes a
row in the transcript, and which file owns each stage.

## Language

The UI is translated through a key lookup, not through per-deployment template edits. English is
**compiled into the bundle**, so a deployment that configures nothing renders exactly as it always
did and makes no extra request before first paint. Every other language is a static asset.

Two configuration keys, both `config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `languages` | `["en"]` | The languages this deployment offers. A language not listed here cannot be selected, however it is asked for. |
| `defaultLanguage` | `"en"` | The language a key falls back to when the active one does not define it — **per key**, not per file. |

### Adding a language

1. Copy `src/app/core/platform/i18n/locales/en.json` — the canonical key list, also published at
   `<app-url>/i18n/en.json` so you can fetch it off a running deployment — and translate the values.
2. Drop it in the web root as `i18n/<lang>.json`, the same way you place `config.json`.
3. Add the tag to `languages`.

No rebuild. A key you leave untranslated falls back to `defaultLanguage`; a key that exists in no
locale at all renders as the key itself, which is deliberately ugly so it shows up in review.

The repository ships `fr.json` as a worked example. It is **not** offered by default — widening
`languages` is what makes a language reachable, so a half-finished locale cannot be selected by
accident.

### Which language a visitor gets

First match wins, and every candidate must appear in `languages`:

```
?language=  /  ?lang=   →   the last choice made here   →   the browser's language   →   defaultLanguage
```

A region-qualified tag resolves to its base, so a browser reporting `fr-BE` gets `fr`.

### What is translated

The screens a user reads: the teams list (page controls, filters, the table and the create dialog),
the conversation (the transcript, the composer, the human-input and sub-agent-reader dialogs, the
message log) and the process chrome (the menubar, the status tags, the visualisation switcher and the
team / agent / workspace panels).

**Not yet:** the catalog admin, the login page, the workspace explorer and its upload dialog, the
knowledge-graph panel, and the agent chat/state panels. They still carry English literals and are
each a file drop away from the layer — the layer does not need to change for them.

### What is not translated

Text the **backend** produced — an agent's answer, a tool name, an agent's own name, an error
`detail`, a notification's `content_type`. It arrives in whatever language the backend generated it
in; it has no key, and putting a key lookup in front of it would only produce a miss — while making
every one of those strings a candidate for accidental translation the day one happens to collide with
a key.

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
