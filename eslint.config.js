// Minimal, boundary-only ESLint flat config (ESLint 9).
//
// SCOPE (Epic 18 / ADR-015 §7 — story 18-6): this config enforces EXACTLY ONE
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
// The allow list below mirrors ADR-015 §7 verbatim:
//
//   App level:
//     protocol        -> nothing app-internal
//     shared          -> protocol
//     core            -> protocol, shared
//     page-*          -> core, shared, protocol, feature-catalog,
//                        feature-team-creation
//                       (NO sibling-page imports, EXCEPT the two reusable
//                        dialogs — the catalog's namespace panel and the team
//                        creation gate + metadata modal — which pages embed)
//     feature-*       -> core, shared, protocol
//     console         -> core, shared, protocol, feature-team-creation,
//                        proc-selectors, proc-models
//
//   Within process/ (top consumes down):
//     proc-components -> proc-ui-state, proc-selectors, proc-event,
//                        proc-workspace, proc-models, core, shared, protocol
//     proc-ui-state   -> proc-selectors, proc-event, proc-models, core, protocol
//     proc-selectors  -> proc-event, proc-models, core, shared, protocol
//     proc-workspace  -> core, protocol
//     proc-event      -> proc-models, core, protocol
//     proc-models     -> protocol
//
//   Acyclic chain:
//     components -> ui-state -> selectors -> event -> core -> { shared, protocol }
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
        { type: 'protocol', pattern: 'src/app/protocol' },
        { type: 'shared', pattern: 'src/app/shared' },
        { type: 'core', pattern: 'src/app/core' },

        // --- The data layer --------------------------------------------------
        // The process feature's internal tiers keep their own types. That DAG
        // (models <- event <- selectors <- ui-state) predates this split, is
        // the one part of the tree with a real layering argument behind it, and
        // collapsing it into one `services` type would have thrown it away as a
        // side effect of a folder rename.
        { type: 'svc-models', pattern: 'src/app/services/process/models' },
        { type: 'svc-event', pattern: 'src/app/services/process/event' },
        { type: 'svc-selectors', pattern: 'src/app/services/process/selectors' },
        { type: 'svc-ui-state', pattern: 'src/app/services/process/ui-state' },
        { type: 'svc-workspace', pattern: 'src/app/services/process/workspace' },
        { type: 'services', pattern: 'src/app/services' },

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
              from: { type: 'core' },
              allow: { to: { type: ['protocol', 'shared'] } },
            },

            // --- the data layer's own DAG, unchanged by the move -------------
            { from: { type: 'svc-models' }, allow: { to: { type: ['protocol'] } } },
            {
              from: { type: 'svc-event' },
              allow: { to: { type: ['svc-models', 'core', 'protocol'] } },
            },
            {
              // MUST NOT reach ui-state: a selector that read the selection
              // would make "what is derived" depend on "what is open".
              from: { type: 'svc-selectors' },
              allow: {
                to: {
                  type: ['svc-event', 'svc-models', 'core', 'shared', 'protocol'],
                },
              },
            },
            {
              from: { type: 'svc-ui-state' },
              allow: {
                to: {
                  type: ['svc-selectors', 'svc-event', 'svc-models', 'core', 'protocol'],
                },
              },
            },
            {
              from: { type: 'svc-workspace' },
              allow: { to: { type: ['core', 'protocol'] } },
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
                    'core',
                    'shared',
                    'protocol',
                    'svc-selectors',
                    'svc-models',
                    'services',
                  ],
                },
              },
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
                    'core',
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
                    'services',
                    'svc-models',
                    'svc-event',
                    'svc-selectors',
                    'svc-ui-state',
                    'svc-workspace',
                    'core',
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
