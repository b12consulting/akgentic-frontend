# `ui/` — the pages and the shell

This is the layer you replace. Nothing may import into it: the `boundaries` rule set defaults to
`disallow` and no rule grants an edge to `ui`, so a second console is a new `ui/` written against the
same `core/components/` and `core/services/`. Everything here is *this* console's answer to how those
parts are arranged — not part of the library.

## The shape

```
app.component.html
└── <app-console-shell>          ← always mounted, survives navigation
    ├── <app-console-rail>       ← the left rail (team list, new team, footer)
    ├── <app-split-divider>      ← rail ↔ main boundary
    └── <ng-content>
        └── <router-outlet>      ← the page changes here
            ├── '' ............. HomeComponent      (ui/home/)
            └── 'process/:id' .. ProcessComponent   (ui/process/)
```

**The console is the shell; home and process are pages inside it.** They are not siblings of the
console — they are alternative contents of one outlet that the console wraps.

The outlet is **projected into** the shell rather than placed beside it, so the routed view inherits
the shell's height chain. Both scroll regions on `/process/:id` measure off it.

## Why the rail is here and the inspector is not

Both are console furniture and both live under `ui/console/`, but they have opposite lifetimes:

- **The rail survives navigation.** It is mounted by the shell, outside the outlet, so moving between
  the teams list and a team does not rebuild it.
- **The inspector dies with the route.** It is mounted by `ProcessComponent`, inside that component's
  injector, because the panels it shows read services that are scoped to the `process/:id` route.

That single seam also explains the two split dividers, which is the part most likely to look like
duplication.

### The three columns, and the two dividers between them

What you see on `/process/:id` is three columns:

```
│  rail  ║        conversation pane        ║   inspector   │
│        ║  process-header + chat-panel    ║  "Team details"│
         ↑                                 ↑
   divider #1                        divider #2
   console-shell.component.html      process.component.html
```

Both are the **same component** — `core/components/primitives/split-divider/` — configured
differently. It is a drag handle that reports one number: the width of the pane on its left, as a
percentage of a *track*.

That track is the reason the two bindings cannot be merged. `[track]` is a **required input** —
"the element the percentage is OF" — and each divider measures against a different element:

| divider | declared in | `[track]` | resizes |
|---|---|---|---|
| rail ↔ main | `console-shell.component.html` | `hostEl`, the shell's own host | the rail, against the whole window |
| conversation ↔ inspector | `process.component.html` | `#paneTrack`, the `.console-panes` row | the conversation pane, against that row only |

Neither component holds a reference to the other's track, so neither binding can be hoisted. The
rail's divider also has to outlive navigation for the same reason the rail does, while the
inspector's disappears entirely when the pane is collapsed (`*ngIf="!inspectorCollapsed()"`).

The **conversation pane** is the middle column — `class="conversation-pane"`, holding
`app-process-header` above `app-chat-panel`.

## The folders

| folder | what it is |
|---|---|
| `console/` | the shell itself, the rail, the inspector frame, the team-creation dialog, and the console's own state (`pane-layout`, `view.service`, the toast handle) |
| `process/` | the `process/:id` page — the conversation pane and the inspector, plus `process-header`. The rail beside them is the shell's, not this page's |
| `home/` | the `''` page: the teams list, its filter and the greeting |
| `login/` | the login page |

## The inspector is a frame, not content

`inspector.component.*` draws chrome only: title ("Team details"), close ✕, a side-swap control, and
the tab strip. The panels are **projected** through `<ng-content>` from `process.component.html`,
which is also what decides *which* tabs exist (`visualizationOptions$`) and which is active.
`core/services/console/inspector/inspector-tabs.registry.ts` holds only the shape of an entry and its
label key — it lives in its own module to break an import cycle, not because it owns the tabs.

Two things there are load-bearing and neither is visible from the strip:

- **The panels are never unmounted.** Inactive ones get `.moved-offscreen`, not `*ngIf` — a
  structural gate would remount `app-team-graph` (echarts) and `app-knowledge-graph` on every tab
  change, and their init/dispose paths have never been exercised that way.
- **`inert` is the accessibility half of that.** Off-screen is not hidden: without it a keyboard user
  would tab into four invisible panels and a screen reader would announce five open tabpanels.
  `pointer-events: none` only covers the mouse.

And `id="console-inspector"` is a **contract**: the process header's Details button points its
`aria-controls` at that exact id. Renaming it breaks the link silently — nothing errors when
`aria-controls` names an element that does not exist.

## The catalog namespace panel

The panel is a library feature (`core/components/features/namespace-panel/`). Nothing for it lives
in `ui/`: it has one host, and that host is the home page.

Select a namespace, then press **Configuration** (`home.component.html:152`,
`data-test="edit-namespace-yaml-btn"`). The button is disabled until a namespace is selected. It sets
`namespacePanelVisible = true`, and a `@defer (when …)` block mounts the panel inside a dialog —
which is what keeps Monaco out of the initial home chunk.

## Adding a page

1. A component under `ui/<page>/`.
2. A route in `app.routes.ts`. It will be inside the shell automatically — the outlet is projected,
   so there is nothing to wire.
3. If it needs route-scoped services, provide them on the **route**, not on the component
   (`Route.providers`). A component that silently requires a particular ancestor is not a component
   anyone can place, and that coupling is what `PROCESS_PROVIDERS` exists to avoid.

The shell's chrome hides itself on `/login` via `chromeVisible$`, so a bare page needs no special
casing here.
