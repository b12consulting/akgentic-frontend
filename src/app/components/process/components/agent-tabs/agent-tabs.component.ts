import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject,
  NgZone,
  OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { BehaviorSubject, combineLatest, Subject } from 'rxjs';
import { map, takeUntil } from 'rxjs/operators';

import { DropdownModule } from 'primeng/dropdown';

import { AkgentService } from '../../../../core/ui/akgent.service';
import {
  GraphDataService,
  HUMAN_ROLE as HUMAN_PROXY_ROLE,
} from '../../selectors/graph.selector';

import { IngestionService } from '../../event/ingestion.service';

import { AkgentChatComponent } from './akgent-chat/akgent-chat.component';
import { InspectorEmptyStateComponent } from '../../../console/inspector/inspector-empty-state.component';
import { TranslatePipe } from '@ngx-translate/core';

/** One selectable member in the picker. */
interface AgentOption {
  readonly label: string;
  readonly value: string;
  readonly agent: GraphAgent;
}

/** A squad's worth of members, under the squad's own name. */
interface AgentGroup {
  readonly label: string;
  readonly items: AgentOption[];
}

/**
 * The fields this pane reads off a graph node. The stream is still typed `any[]`
 * upstream (`GraphDataService.nodes$`); naming what is actually consumed here is
 * what stops the next reader guessing.
 */
interface GraphAgent {
  readonly name?: string;
  readonly actorName?: string;
  readonly role?: string;
  readonly agent_id?: string;
  readonly category?: number;
}

/** A squad, as the graph fold builds it — carrying the name the legend shows. */
interface GraphSquad {
  readonly name?: string;
}

/**
 * The inspector's Member pane.
 *
 * The name is a leftover: there are no tabs here any more. The template was a
 * `<p-tabs>` holding ONE tab whose caption repeated the agent already named in
 * the picker beside it — a row of library chrome that could not be operated and
 * said nothing. Renaming the component is a cross-cutting change (the element
 * is addressed by `process.component.html` and its specs), so the class keeps
 * its name and the template no longer pretends.
 */
@Component({
  selector: 'app-agent-tabs',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DropdownModule,
    AkgentChatComponent,
    InspectorEmptyStateComponent,
    TranslatePipe,
  ],
  templateUrl: './agent-tabs.component.html',
  styleUrl: './agent-tabs.component.scss',
})
export class AgentTabsComponent implements OnInit {
  akgentService: AkgentService = inject(AkgentService);
  graphDataService: GraphDataService = inject(GraphDataService);
  ingestionService: IngestionService = inject(IngestionService);
  private readonly zone: NgZone = inject(NgZone);
  private readonly cdr: ChangeDetectorRef = inject(ChangeDetectorRef);
  private destroyRef = inject(DestroyRef);

  akgentId: string = '';
  akgentName: string = '';
  agentsByCategory: AgentGroup[] = [];
  selectedAgent: AgentOption | null = null;

  /**
   * WHAT IS BOUND TO `[options]`, which is not the same object as
   * `agentsByCategory`.
   *
   * PrimeNG reads the bound array THROUGH `[group]`:
   * `getAllVisibleAndNonVisibleOptions()` is
   * `this.group ? this.flatOptions(this.options) : this.options || []`. So the
   * grouped shape (`[{ label, items }]`) is only ever unwrapped when `group` is
   * true; hand it that shape with `group="false"` and the WRAPPER objects
   * become the options — one row, `optionLabel="label"` resolving to `''`, and
   * the members unreachable. `label()` resolves the model against the same
   * list, so the closed control also falls back to its placeholder while an
   * agent is in fact selected, and picking the row passes the wrapper to
   * `onAgentSelect`, where `option.agent` is undefined and the selection is
   * cleared.
   *
   * `agentsByCategory` stays the pane's own model — the empty-state gate counts
   * it and the picker's headers come from it. This field is that model
   * PROJECTED into the one shape the current `grouped` value makes PrimeNG read
   * correctly, derived in the one place `grouped` is decided.
   */
  pickerOptions: AgentOption[] | AgentGroup[] = [];

  /**
   * Whether the picker draws GROUP HEADERS at all.
   *
   * `group="true"` was hardcoded, so a team with one squad got a header reading
   * "Agents" over a list of agents, inside a control already placeheld "Select
   * agent" — the same word three times and no choice being expressed. A header
   * is worth a row when it separates two things; with one group it separates
   * nothing.
   */
  grouped = false;

  context$: BehaviorSubject<any[]> = new BehaviorSubject<any[]>([]);
  state$: BehaviorSubject<any> = new BehaviorSubject<any>(null);

  // akgentic-agent ADR-007 §4: a NEVER-RUN agent has NO `LlmSystemPromptEvent` (the backend
  // emits no creation event). Its backstory is already on the client as the
  // serialized `AgentState.backstory`, folded by the `state` PerAgentStore
  // (value shape `{ schema, state }`). Project the trimmed backstory string so
  // the chat component can render it as the head-block fallback and so chat-tab
  // visibility can account for it. Emits `''` when there is no backstory.
  backstory$ = this.state$.pipe(map((state) => this.readBackstory(state)));

  // The chat tab is shown when the agent has conversation context OR a non-empty
  // `state.backstory` to display (akgentic-agent ADR-007 §4 never-run case — an empty/whitespace
  // backstory must NOT force the tab open). A running agent always has context;
  // a never-run agent shows `state.backstory`. When visible it occupies slot "0"
  // and the State tab moves to "1".
  chatTabVisible$ = combineLatest([this.context$, this.state$]).pipe(
    map(
      ([context, state]) =>
        (context?.length ?? 0) > 0 || this.readBackstory(state).length > 0,
    ),
  );

  /**
   * akgentic-agent ADR-007 §4 — read the agent's backstory from the `state` PerAgentStore
   * value (`{ schema, state }`, where `state` is the serialized `AgentState`
   * carrying `backstory: str`). Returns the TRIMMED backstory, or `''` when the
   * state, raw state, or backstory is absent/blank. Defensive: never throws on
   * `null`/`undefined`/non-string.
   */
  private readBackstory(stateValue: any): string {
    const raw = stateValue?.state?.backstory;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  // Subject to unsubscribe from agent-specific subscriptions when agent changes
  private agentSubscriptions$ = new Subject<void>();

  ngOnInit(): void {
    this.akgentService.selectedAkgent$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((akgent) => {
        // Unsubscribe from previous agent's subscriptions
        this.agentSubscriptions$.next();

        this.akgentId = akgent?.agentId || '';
        this.akgentName = akgent?.name || '';
        if (akgent) {
          // Epic 17 (ADR-014): source `context` / `state` from the
          // PerAgentStore instances instead of the deleted dicts. `forAgent`'s
          // `shareReplay(1)` delivers the current value on subscribe, so the
          // explicit immediate `.value` push is no longer needed. Map
          // `undefined` → the existing defaults (`[]` / `null`) so the template
          // guards (`(context$ | async)?.length`, `state$ | async`) behave
          // identically.
          this.ingestionService.context
            .forAgent(akgent.agentId)
            .pipe(
              map((context) => context ?? []),
              takeUntil(this.agentSubscriptions$),
            )
            .subscribe((context) => {
              this.context$.next(context);
            });
          this.ingestionService.state
            .forAgent(akgent.agentId)
            .pipe(
              map((state) => state ?? null),
              takeUntil(this.agentSubscriptions$),
            )
            .subscribe((state) => {
              this.state$.next(state);
            });
          // Select the agent in the dropdown
          this.set_dropdown_selected_agent(akgent.agentId);
        } else {
          this.context$.next([]);
          this.state$.next(null);
        }
      });

    combineLatest([
      this.graphDataService.nodes$,
      this.graphDataService.categories$,
    ])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([agents, categories]: [GraphAgent[], GraphSquad[]]) => {
        // INSIDE THE ZONE, AND MARKED DIRTY — the same two moves
        // `GraphComponent` needed, for the same reason and on the same feed.
        //
        // These emissions originate on the websocket, outside the Angular zone,
        // and everything this subscriber touches is a plain field read by a
        // template gate (`@if (agentsByCategory.length > 0)`) whose @else is
        // the "No agents available" empty state. Without a tick the roster
        // arrives and the empty state stays on screen.
        //
        // This pane renders today only by accident: `<app-team-tabs>` is
        // mounted beside it and ITS `zone.run` produces a pass that happens to
        // re-check this view. Nothing declares that dependency, and hiding the
        // hierarchy panel per deployment would remove it.
        this.zone.run(() => {
          this.applyRoster(agents ?? [], categories ?? []);
          this.cdr.markForCheck();
        });
      });
  }

  /** Rebuild the picker from a graph emission. Split out of the subscriber so
   *  the zone/change-detection wrapper above reads as the one thing it is. */
  private applyRoster(agents: GraphAgent[], categories: GraphSquad[]): void {
    if (!agents.length) {
      this.agentsByCategory = [];
      this.pickerOptions = [];
      this.selectedAgent = null;
      return;
    }
    // Remove human-proxy agents, and tool actors (their actorName starts
    // with '#', e.g. #VectorStore / #KnowledgeGraphTool) — the Member
    // dropdown lists real agents only.
    const filteredAgents = agents.filter(
      (a) =>
        (a.role || '') !== HUMAN_PROXY_ROLE &&
        !String(a.actorName ?? '').startsWith('#'),
    );

    const toOption = (a: GraphAgent): AgentOption => ({
      label: a.actorName ?? '',
      value: a.agent_id || a.name || '', // agent_id is the primary value
      agent: a,
    });

    let dropdownItems: AgentOption[] = [];
    if (categories.length <= 1) {
      // One squad: no header. See `grouped`.
      dropdownItems = filteredAgents.map(toOption);
      this.agentsByCategory = [{ label: '', items: dropdownItems }];
      this.grouped = false;
      // FLAT, because `grouped` is false. See `pickerOptions`.
      this.pickerOptions = dropdownItems;
    } else {
      // THE SQUAD'S OWN NAME, read off the category the graph fold built.
      // This used to compose `\`Team ${idx}\`` locally — the same string
      // the fold already puts on the squad — so the picker's headers and
      // the graph's legend derived the same label twice and could disagree
      // the moment either side learned a real squad name.
      this.agentsByCategory = categories.map((cat, idx) => ({
        label: cat?.name ?? '',
        items: filteredAgents.filter((a) => a.category === idx).map(toOption),
      }));
      this.grouped = true;
      this.pickerOptions = this.agentsByCategory;
      dropdownItems = this.agentsByCategory.flatMap((g) => g.items);
    }

    // Set selectedAgent to the dropdown item matching the selectedAkgent$ (or first Manager, or first agent)
    const selectedAkgent = this.akgentService.selectedAkgent$.value;
    if (selectedAkgent) {
      this.set_dropdown_selected_agent(selectedAkgent.agentId);
    } else {
      // Try to select first agent with role 'Manager' (case-insensitive)
      const managerItem = dropdownItems.find(
        (item) => (item.label || '') === '@Manager',
      );
      this.selectedAgent = managerItem || dropdownItems[0] || null;
      if (this.selectedAgent && this.selectedAgent.agent) {
        this.akgentService.select(
          this.selectedAgent.value,
          this.selectedAgent.label,
        );
      }
    }
  }

  set_dropdown_selected_agent(agent_id: string): void {
    const dropdownItems = this.agentsByCategory.flatMap((g) => g.items);
    this.selectedAgent =
      dropdownItems.find((item) => item.value === agent_id) || null;
  }

  onAgentSelect(event: { value?: AgentOption | null }): void {
    const option = event.value;
    if (option?.agent) {
      // `?? ''` rather than a non-null assertion: a node with no name is a
      // wire shape this pane cannot rule out, and asserting it away would move
      // the failure from a typed default to a runtime `undefined` in the
      // selection service.
      this.akgentService.select(
        option.agent.name ?? '',
        option.agent.actorName ?? ''
      );
    } else {
      this.akgentService.unselect();
    }
  }
}
