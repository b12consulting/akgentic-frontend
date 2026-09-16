// Minimal, boundary-only ESLint flat config (ESLint 9).
//
// SCOPE: this config enforces EXACTLY ONE
// rule — the one-way import DAG between the frontend's architectural layers. It
// deliberately does NOT adopt @angular-eslint, @typescript-eslint recommended,
// stylistic, formatting, or type-aware rules; those would flag the pre-existing,
// untouched codebase, which is out of scope for this story.
//
// Mechanism: eslint-plugin-boundaries tags each file by its folder ("element
// type") and enforces allow/deny edges BETWEEN element types regardless of the
// relative-import depth. This is the robust encoding for this codebase, which
// uses relative imports with no tsconfig path aliases.
//
// THE ALLOW LIST IS BELOW, not here. It used to be transcribed into this header
// as well, and the copy went stale the moment the layers were reorganised: it
// named eleven element types that no longer exist and asserted two rules the
// live config contradicts. A linter never warns about a permission it grants,
// so a false RESTRICTION written in a comment is the one class of belief this
// gate structurally cannot correct — which is why the transcription is gone
// rather than updated.
//
// For the layers and what each may import, read `README.md` "## Layout"; for
// what is enforced, read `boundaries/elements` and `boundaries/dependencies`
// below, which are the only authority.
//
// Verification is behavioural (story AC #4/#5): `npm run lint` exits 0 on the
// migrated tree and non-zero on a planted cross-layer import. There are NO
// string-presence assertions on ADR numbers, file paths, or folder names
// (CLAUDE.md Golden Rule #8).

const tseslint = require('typescript-eslint');
const boundaries = require('eslint-plugin-boundaries');

module.exports = tseslint.config(
  // Only application source is gated; spec files and everything outside src/ are
  // exempt (tests routinely reach across layers to construct fixtures).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Boundaries works off the module graph only; no type-aware program needed.
        project: false,
      },
    },
    plugins: {
      boundaries,
    },
    settings: {
      // Resolve extension-less relative imports (e.g. '../selectors/chat.selector')
      // to their .ts files so the boundaries plugin can tag each dependency by
      // element type. Without .ts in the resolver extensions, every cross-layer
      // import resolves to "unknown" and the DAG rule silently never fires.
      'import/resolver': {
        node: { extensions: ['.ts', '.js', '.json'] },
      },
      // Order matters: the most specific process/* patterns MUST precede the
      // generic page pattern so a process leaf is not mis-tagged as a page.
      // Files matching no pattern (e.g. the app.*.ts composition root) are
      // "unknown" and intentionally unrestricted — app.routes.ts is the router
      // that legitimately wires every page together.
      'boundaries/elements': [
        // --- The three layers, and the two that were always there ------------
        //
        // `ui/` assembles, `components/` renders, `services/` supplies. The
        // split is by DIRECTORY rather than by naming convention so it cannot
        // erode quietly, and the types below are what stop it eroding loudly:
        // a shared type between two folders would make every edge between them
        // legal in both directions, because `boundaries` cannot express
        // direction within a type.
        //
        // Order matters — the most specific pattern must precede the generic
        // one, or a leaf is tagged as its own parent.
        // There is deliberately NO generic `src/app/core` entry. `core/` is a
        // namespace holding four separate tiers, not a tier; a pattern matching
        // the namespace would match every file under it, and since `boundaries`
        // takes the FIRST match it would collapse all of them into one element
        // type — where every edge inside `core/` is legal in both directions and
        // `npm run lint` still exits 0. Every tier names itself or does not exist.
        { type: 'protocol', pattern: 'src/app/core/protocol' },
        { type: 'shared', pattern: 'src/app/core/shared' },
        { type: 'platform', pattern: 'src/app/core/platform' },

        // --- The data layer --------------------------------------------------
        // The process feature's internal tiers keep their own types. That DAG
        // (models <- event <- selectors <- ui-state) predates this split, is
        // the one part of the tree with a real layering argument behind it, and
        // collapsing it into one `services` type would have thrown it away as a
        // side effect of a folder rename.
        { type: 'svc-models', pattern: 'src/app/core/services/process/models' },
        { type: 'svc-event', pattern: 'src/app/core/services/process/event' },
        { type: 'svc-selectors', pattern: 'src/app/core/services/process/selectors' },
        { type: 'svc-ui-state', pattern: 'src/app/core/services/process/ui-state' },
        { type: 'svc-workspace', pattern: 'src/app/core/services/process/workspace' },
        // The team's open/close ritual. Its own type because it is the one unit
        // in the data layer that composes the others — it drives the ingestion
        // pipeline — and folding it into the generic `services` type would
        // either deny it that edge or hand it to every other feature's services.
        { type: 'svc-session', pattern: 'src/app/core/services/process/session' },
        { type: 'services', pattern: 'src/app/core/services' },

        // --- The primitives tier ---------------------------------------------
        // Domain-free controls: an icon and a click, a string copied, a
        // percentage dragged. The tier's rule is that it may NOT import
        // `services` — type imports included, since `boundaries` cannot tell a
        // type import from an injection, which is exactly what makes the rule
        // enforceable here and only a review rule in `components`.
        { type: 'primitives', pattern: 'src/app/core/components/primitives' },

        // --- The two view layers ---------------------------------------------
        { type: 'components', pattern: 'src/app/components' },
        { type: 'ui', pattern: 'src/app/ui' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            // protocol imports nothing app-internal.
            { from: { type: 'protocol' }, disallow: { to: { type: '*' } } },

            { from: { type: 'shared' }, allow: { to: { type: ['protocol'] } } },

            {
              from: { type: 'platform' },
              allow: { to: { type: ['protocol', 'shared'] } },
            },

            // --- the data layer's own DAG, unchanged by the move -------------
            { from: { type: 'svc-models' }, allow: { to: { type: ['protocol'] } } },
            {
              from: { type: 'svc-event' },
              allow: { to: { type: ['svc-models', 'platform', 'protocol'] } },
            },
            {
              // MUST NOT reach ui-state: a selector that read the selection
              // would make "what is derived" depend on "what is open".
              from: { type: 'svc-selectors' },
              allow: {
                to: {
                  type: ['svc-event', 'svc-models', 'platform', 'shared', 'protocol', 'services'],
                },
              },
            },
            {
              from: { type: 'svc-ui-state' },
              allow: {
                to: {
                  type: ['svc-selectors', 'svc-event', 'svc-models', 'platform', 'protocol', 'services'],
                },
              },
            },
            {
              // It composes the pipeline and reads the app's team context; it
              // must NOT reach a view, which is what keeps `open a team` a
              // mechanism rather than one console's behaviour.
              from: { type: 'svc-session' },
              allow: {
                to: {
                  type: [
                    'svc-event',
                    'svc-selectors',
                    'svc-models',
                    'platform',
                    'shared',
                    'protocol',
                    'services',
                  ],
                },
              },
            },
            {
              from: { type: 'svc-workspace' },
              allow: { to: { type: ['platform', 'protocol'] } },
            },
            {
              // The other features' services. They may read the process feature's
              // selectors and node type — the inspector's member selector does,
              // and that is the whole reason the inspector is mounted from inside
              // the process view rather than beside it.
              from: { type: 'services' },
              allow: {
                to: {
                  type: [
                    'platform',
                    'shared',
                    'protocol',
                    'svc-selectors',
                    'svc-models',
                    'services',
                  ],
                },
              },
            },

            // --- primitives: may reach platform, shared, protocol and each
            // other. NOT services, and not a view layer.
            {
              from: { type: 'primitives' },
              allow: { to: { type: ['primitives', 'platform', 'shared', 'protocol'] } },
            },

            // --- components: render, never fetch -----------------------------
            //
            // WHAT THIS RULE DOES AND DOES NOT CATCH, because the difference
            // matters. It forbids a dumb component from importing `ui/`, which
            // is the edge that would turn the layer inside out. It does NOT
            // forbid importing `services`, and cannot: a component's `@Input`
            // is typed by the selector that produces it — `member-card` takes an
            // `InspectorMember` — and `boundaries` sees a type import and a
            // service injection as the same edge.
            //
            // The rule that actually keeps this layer dumb is the one used to
            // populate it: a component belongs here when it injects no service
            // that carries DATA. That is a review rule, not a lint rule, and
            // saying so here is better than implying the linter checks it.
            {
              from: { type: 'components' },
              allow: {
                to: {
                  type: [
                    'components',
                    // TEMPORARY, and load-bearing: `member-card` is the one file
                    // left in this tier importing a primitive. Epic 53's next
                    // story moves it into `features/` and this entry goes with it.
                    'primitives',
                    'platform',
                    'shared',
                    'protocol',
                    'services',
                    'svc-models',
                    'svc-selectors',
                  ],
                },
              },
            },

            // --- ui: the only layer allowed to assemble ----------------------
            // It may reach everything below it, including other assemblies —
            // the console shell mounts the inspector, the process view mounts
            // the header. Nothing may reach BACK into it, which is what makes a
            // second UI possible: `ui/` is the layer you replace.
            {
              from: { type: 'ui' },
              allow: {
                to: {
                  type: [
                    'ui',
                    'components',
                    'primitives',
                    'services',
                    'svc-models',
                    'svc-event',
                    'svc-selectors',
                    'svc-session',
                    'svc-ui-state',
                    'svc-workspace',
                    'platform',
                    'shared',
                    'protocol',
                  ],
                },
              },
            },
          ],
        },
      ],
    },
  },
);
