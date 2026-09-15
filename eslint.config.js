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
        // --- App-level layers ---
        { type: 'protocol', pattern: 'src/app/protocol' },
        { type: 'shared', pattern: 'src/app/shared' },
        { type: 'core', pattern: 'src/app/core' },

        // --- process/ internal layers (more specific than the page pattern) ---
        // Files directly under process/ (the ProcessComponent page root, e.g.
        // process.component.ts) are the process feature's presentation tier and
        // are tagged proc-components — they compose ui-state/selectors/event/
        // workspace exactly like the nested presentation components do (ADR-015
        // §7 "components/ (presentation)"). The nested process/components/ folder
        // shares the same element type.
        //
        // The four non-presentation tiers now live under `features/process/`,
        // where `components/` holds only components. The TYPES are unchanged and
        // so is every rule below — this is where the tier is, not what it is
        // allowed to import. Keeping the type names is deliberate: renaming them
        // alongside the move would have made a pure relocation look like a
        // change to the DAG.
        { type: 'proc-components', pattern: 'src/app/components/process/components' },
        { type: 'proc-components', pattern: 'src/app/components/process' },
        { type: 'proc-event', pattern: 'src/app/features/process/event' },
        { type: 'proc-selectors', pattern: 'src/app/features/process/selectors' },
        { type: 'proc-ui-state', pattern: 'src/app/features/process/ui-state' },
        { type: 'proc-workspace', pattern: 'src/app/features/process/workspace' },
        { type: 'proc-models', pattern: 'src/app/features/process/models' },

        // --- The console shell (Epic 56) ---
        // Rail, conversation header and inspector: the chrome the redesign put
        // around the routed views. Its own element type rather than a page,
        // because it is neither routed nor a leaf — `AppComponent` mounts the
        // shell and `ProcessComponent` mounts the header and the inspector, so
        // it is a presentation tier with two hosts.
        //
        // Without this entry the whole subtree matches no pattern, is tagged
        // "unknown", and is therefore completely UNGATED: the inspector panels
        // reach into `proc-selectors` and `proc-models`, and nothing would have
        // checked the direction. That is the largest new folder in the tree, so
        // leaving it unknown would have opted the redesign out of ADR-015 §7.
        { type: 'console', pattern: 'src/app/components/console' },
        //
        // ITS OWN TYPE, not a second pattern on `console`. Two patterns sharing
        // one type would make every edge between them legal in BOTH directions,
        // because `boundaries` cannot express direction within a type — and the
        // whole point of the views and the logic being in two trees is that one
        // of those directions is wrong. A separate type is what lets the rule
        // below say `console -> console-logic` and stay silent on the reverse.
        //
        // Before the split these edges were not merely unchecked, they were
        // invisible: both sides were inside one element, and `boundaries` does
        // not examine dependencies within an element at all.
        { type: 'console-logic', pattern: 'src/app/features/console' },

        // --- catalog is a REUSABLE feature, not a leaf page ---
        // Its namespace-panel dialog is intentionally embedded by other pages
        // (the home page hosts the namespace editor — Epic 11/12 reuse), so
        // catalog gets its own element type that pages are allowed to depend on.
        // This is NOT a general page->page edge: feature-catalog is the only
        // page-level element other pages may import (ADR-015 §7).
        { type: 'feature-catalog', pattern: 'src/app/components/catalog' },
        { type: 'feature-catalog-logic', pattern: 'src/app/features/catalog' },

        // --- team creation is a REUSABLE feature, not a home-page leaf ---
        // Same carve-out as feature-catalog above, and for the same reason: R2
        // moved team creation out of the home page and into a console wizard
        // that reuses BOTH the creation gate (`TeamCreationService` — the one
        // place the "does this namespace ask for metadata" question is decided)
        // and the metadata dialog verbatim. Home still embeds both for its
        // auto-create path, so there are now two hosts on opposite sides of the
        // page/console line.
        //
        // These two entries MUST precede `page-home` below: boundaries matches
        // patterns in order, so the broader `src/app/components/home` pattern
        // would otherwise swallow them and re-tag them as page-home.
        //
        // The honest alternative — copying either symbol into console/ — is a
        // SECOND creation gate, which is exactly the duplication
        // `TeamCreationService` was extracted to remove.
        {
          type: 'feature-team-creation',
          pattern: 'src/app/features/home/team-creation',
        },
        {
          type: 'feature-team-creation',
          pattern: 'src/app/components/home/team-metadata-modal',
        },

        // --- Pages: one element type per page; each captures its page folder ---
        // Listing distinct types (page-home, page-login, ...) means page->page
        // edges are simply absent from the allow list and therefore forbidden.
        { type: 'page-home', pattern: 'src/app/components/home' },
        { type: 'page-home-logic', pattern: 'src/app/features/home' },
        { type: 'page-login', pattern: 'src/app/components/login' },
      ],
    },
    rules: {
      // The single enforced rule: the import DAG. Everything not listed below is
      // forbidden (default: disallow). Uses the v6 object-based selector syntax.
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            // protocol imports nothing app-internal.
            { from: { type: 'protocol' }, disallow: { to: { type: '*' } } },

            // shared -> protocol
            { from: { type: 'shared' }, allow: { to: { type: ['protocol'] } } },

            // core -> protocol, shared
            { from: { type: 'core' }, allow: { to: { type: ['protocol', 'shared'] } } },

            // Pages -> core, shared, protocol; NO sibling-page imports — EXCEPT
            // the reusable feature-catalog dialog, which pages may embed.
            {
              from: { type: ['page-home', 'page-login'] },
              allow: {
                to: {
                  type: [
                    'core',
                    'shared',
                    'protocol',
                    'feature-catalog',
                    'feature-team-creation',
                    'page-home-logic',
                  ],
                },
              },
            },

            // The two reusable features -> core, shared, protocol. Neither may
            // import a page or the console, which is what keeps the carve-outs
            // above from becoming page<->page edges by the back door.
            {
              from: { type: ['feature-catalog', 'feature-team-creation'] },
              allow: {
                to: { type: ['core', 'shared', 'protocol', 'feature-catalog-logic'] },
              },
            },

            // The logic tiers: core, shared, protocol and nothing else. NOT the
            // views they belong to — that is the edge the split exists to
            // forbid, and it stays forbidden by omission rather than by anyone
            // remembering it. `console-logic` additionally reads the two process
            // layers the inspector's own selectors resolve against, exactly as
            // `console` does.
            {
              from: { type: ['feature-catalog-logic', 'page-home-logic'] },
              allow: { to: { type: ['core', 'shared', 'protocol'] } },
            },
            {
              from: { type: 'console-logic' },
              allow: {
                to: {
                  type: [
                    'core',
                    'shared',
                    'protocol',
                    'proc-selectors',
                    'proc-models',
                  ],
                },
              },
            },

            // console -> core, shared, protocol, the reusable
            // `feature-team-creation` pair (R2: the rail's wizard reuses the
            // creation gate and the metadata dialog rather than growing a
            // second copy of either), plus the two process layers
            // the inspector genuinely reads: `proc-selectors` (the Team panel
            // injects the component-scoped `GraphDataService`, which is the
            // whole reason the inspector is mounted from inside the process
            // view rather than beside it) and `proc-models` for the node type
            // that service emits.
            //
            // NOT `proc-components`, `proc-event`, `proc-ui-state` or
            // `proc-workspace`. The edge that exists runs the other way —
            // `proc-components` mounts the header and the inspector, below —
            // and permitting the return edge is what would turn this into a
            // cycle. The default being `disallow` means that stays true by
            // omission rather than by anyone remembering it.
            {
              from: { type: 'console' },
              allow: {
                to: {
                  type: [
                    'core',
                    'shared',
                    'protocol',
                    'feature-team-creation',
                    'console-logic',
                    'proc-selectors',
                    'proc-models',
                  ],
                },
              },
            },

            // process/components (presentation) -> all process peers it consumes
            // plus the app-level leaves it may read.
            {
              from: { type: 'proc-components' },
              allow: {
                to: {
                  type: [
                    // intra-tier: the ProcessComponent page root composes its
                    // child presentation components, and sibling presentation
                    // components compose each other (e.g. team-tabs -> graph).
                    'proc-components',
                    // Epic 56: the process view mounts the conversation header
                    // and the inspector frame. They have to be mounted from in
                    // here — both sit either side of, or read, this view's
                    // component-scoped providers, which resolve nowhere else.
                    'console',
                    // And the tab SET it hands that frame, which is data rather
                    // than a component: `ProcessComponent` builds the inspector's
                    // list of tabs from `inspector-tabs.registry`. The same
                    // relationship as the line above — this view composes the
                    // console chrome — reaching the chrome's logic tier instead
                    // of its views.
                    'console-logic',
                    'proc-ui-state',
                    'proc-selectors',
                    'proc-event',
                    'proc-workspace',
                    'proc-models',
                    'core',
                    'shared',
                    'protocol',
                  ],
                },
              },
            },

            // ui-state -> selectors, event, core (+ models, protocol)
            {
              from: { type: 'proc-ui-state' },
              allow: {
                to: { type: ['proc-selectors', 'proc-event', 'proc-models', 'core', 'protocol'] },
              },
            },

            // selectors -> event, core, protocol (+ models, shared);
            // MUST NOT import ui-state or process/components.
            {
              from: { type: 'proc-selectors' },
              allow: {
                to: { type: ['proc-event', 'proc-models', 'core', 'shared', 'protocol'] },
              },
            },

            // workspace -> core, protocol
            {
              from: { type: 'proc-workspace' },
              allow: { to: { type: ['core', 'protocol'] } },
            },

            // event -> core, protocol (+ models);
            // MUST NOT import selectors, ui-state, or process/components.
            {
              from: { type: 'proc-event' },
              allow: { to: { type: ['proc-models', 'core', 'protocol'] } },
            },

            // process/models -> protocol only.
            {
              from: { type: 'proc-models' },
              allow: { to: { type: ['protocol'] } },
            },
          ],
        },
      ],
    },
  },
);
