import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslationObject } from '@ngx-translate/core';
import { BehaviorSubject, of } from 'rxjs';

import { TeamPanelComponent } from './team-panel.component';
import { IngestionService } from '../../../services/process/event/ingestion.service';
import { NodeInterface } from '../../../services/process/models/types';
import { GraphDataService } from '../../../services/process/selectors/graph.selector';
import {
  TeamTokenTotals,
  TokenUsageSelector,
} from '../../../services/process/selectors/token-usage.selector';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';

const HUMAN_ROLE = 'Human';

function node(
  overrides: Partial<NodeInterface> & { name: string },
): NodeInterface {
  return {
    role: 'Assistant',
    actorName: overrides.name,
    parentId: '',
    squadId: 's1',
    symbol: 'roundRect',
    category: 0,
    userMessage: false,
    ...overrides,
  };
}

const EMPTY_TOTALS: TeamTokenTotals = {
  totalSent: 0,
  totalReceived: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalCostUsd: 0,
};

/**
 * The Team panel.
 *
 * Both scoped services are faked at the TestBed root, which is what the
 * panel's (and the nested usage card's) bare `inject` resolves — mirroring
 * production, where both live on `ProcessComponent.providers`. Driving
 * `nodes$` as a subject is what makes the live cases — a member joining, a
 * team emptying out — assertable rather than a matter of construction order.
 */
describe('TeamPanelComponent', () => {
  let fixture: ComponentFixture<TeamPanelComponent>;
  let nodes$: BehaviorSubject<NodeInterface[]>;

  /** `translations` are registered BEFORE the first render: the pipe resolves a
   *  key once at bind time, and registering afterwards makes the assertion
   *  depend on change-detection timing rather than on the component. */
  async function setup(
    initial: NodeInterface[] = [],
    translations?: TranslationObject,
  ): Promise<void> {
    nodes$ = new BehaviorSubject<NodeInterface[]>(initial);

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [TeamPanelComponent],
      providers: [
        {
          provide: GraphDataService,
          useValue: {
            nodes$: nodes$.asObservable(),
            edges$: of([]),
            categories$: of([]),
          },
        },
        {
          provide: TokenUsageSelector,
          useValue: {
            teamTotals$: of(EMPTY_TOTALS),
            teamByModel$: of([]),
            perAgent$: (_id: string) => of(undefined),
          },
        },
        // The task board reads the per-agent state store; no plan here.
        { provide: IngestionService, useValue: { state: { all$: of(new Map()) } } },
        provideTranslateTesting(),
      ],
    }).compileComponents();

    if (translations !== undefined) {
      setTestTranslations(translations);
    }

    fixture = TestBed.createComponent(TeamPanelComponent);
    fixture.detectChanges();
  }

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function memberNames(): string[] {
    return Array.from(host().querySelectorAll('.member-name')).map((el) =>
      (el.textContent ?? '').trim(),
    );
  }

  describe('the empty team', () => {
    it('renders the shared empty state when there is neither a human nor a member', async () => {
      await setup([]);

      expect(host().querySelector('app-empty-state')).not.toBeNull();
    });

    it('renders nothing else beside it — no usage card standing on its own', async () => {
      // "and nothing else": a zeroed meter under an empty-state sentence says
      // the pane is both empty and reporting, which is one message too many.
      await setup([]);

      expect(host().querySelector('.team-panel')).toBeNull();
      expect(host().querySelector('app-token-usage-panel')).toBeNull();
      expect(host().querySelector('app-tool-chips')).toBeNull();
    });

    it('stays empty when the only nodes are tools, which are not members', async () => {
      await setup([node({ name: 't', actorName: '#KnowledgeGraphTool' })]);

      expect(host().querySelector('app-empty-state')).not.toBeNull();
    });
  });

  describe('the populated team', () => {
    const team = [
      node({ name: 'me', actorName: 'Human-Proxy-0', role: HUMAN_ROLE, category: 3 }),
      node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
      node({ name: 'w1', actorName: 'Alpha-Worker-0', parentId: 'boss' }),
      node({ name: 't', actorName: '#KnowledgeGraphTool' }),
    ];

    it('puts the human card first and keeps it out of the member list', async () => {
      await setup(team);

      expect(host().querySelector('.human-card')).not.toBeNull();
      expect(memberNames()).toEqual(['Manager [Supervisor]', 'Alpha [Worker]']);
    });

    it('threads the squad index into the human sub-line', async () => {
      // A parameterised key, not a concatenation: the no-op loader would echo
      // the key whether or not the parameter reached the template, so this
      // registers a synthetic template to make the assertion mean something.
      await setup(team, {
        inspector: { human: '<<you>>', humanSub: '<<team:{{team}}>>' },
      });

      expect(host().querySelector('.human-sub')?.textContent?.trim()).toBe(
        '<<team:3>>',
      );
    });

    it('renders the tool chips and the usage card below the members', async () => {
      await setup(team);

      expect(host().querySelector('app-tool-chips')).not.toBeNull();
      expect(host().querySelector('app-token-usage-panel')).not.toBeNull();
    });

    it('does not render the human as a member card', async () => {
      await setup(team);

      // The human proxy is an actor in the graph like any other; showing it in
      // the list would offer a "chat with yourself" row.
      expect(memberNames()).not.toContain('Human [Proxy]');
    });

    it('has no member cards, but still a human card, for a team of one person', async () => {
      await setup([
        node({ name: 'me', actorName: 'Human-Proxy-0', role: HUMAN_ROLE }),
      ]);

      expect(host().querySelector('.human-card')).not.toBeNull();
      expect(memberNames()).toEqual([]);
      expect(host().querySelector('app-empty-state')).toBeNull();
    });
  });

  describe('liveness', () => {
    it('adds a card when a member joins, despite OnPush', async () => {
      await setup([node({ name: 'boss', actorName: 'Manager-Supervisor-0' })]);
      expect(memberNames().length).toBe(1);

      nodes$.next([
        node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
        node({ name: 'w1', actorName: 'Alpha-Worker-0', parentId: 'boss' }),
      ]);
      fixture.detectChanges();

      expect(memberNames()).toEqual(['Manager [Supervisor]', 'Alpha [Worker]']);
    });

    it('drops a card when a stopped agent is spliced out of the graph', async () => {
      // This is why the panel reads `nodes$` and not `agentsById$`: a stopped
      // agent leaves the roster but stays resolvable for old messages.
      await setup([
        node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
        node({ name: 'w1', actorName: 'Alpha-Worker-0', parentId: 'boss' }),
      ]);

      nodes$.next([node({ name: 'boss', actorName: 'Manager-Supervisor-0' })]);
      fixture.detectChanges();

      expect(memberNames()).toEqual(['Manager [Supervisor]']);
    });

    it('falls back to the empty state when the last member leaves', async () => {
      await setup([node({ name: 'boss', actorName: 'Manager-Supervisor-0' })]);

      nodes$.next([]);
      fixture.detectChanges();

      expect(host().querySelector('app-empty-state')).not.toBeNull();
    });

    it('does not re-emit the view when a frame changes nothing structural', async () => {
      // `nodes$` re-emits per message frame and the derivation returns a fresh
      // object every time, so without the structural comparator this OnPush
      // panel would rebuild its whole card list on every message.
      await setup([node({ name: 'boss', actorName: 'Manager-Supervisor-0' })]);
      let emissions = 0;
      fixture.componentInstance.view$.subscribe(() => emissions++);

      nodes$.next([node({ name: 'boss', actorName: 'Manager-Supervisor-0' })]);

      expect(emissions).toBe(1);
    });
  });

  describe('member selection', () => {
    it('reports the clicked member by agent_id', async () => {
      await setup([node({ name: 'boss', actorName: 'Manager-Supervisor-0' })]);
      const seen: string[] = [];
      fixture.componentInstance.memberSelected.subscribe((id) => seen.push(id));

      // The whole card is the control; it opens the Member tab.
      host().querySelector<HTMLButtonElement>('.member-card')?.click();

      expect(seen).toEqual(['boss']);
    });

    it('reports the card that was activated, not the first one on the pane', async () => {
      await setup([
        node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
        node({ name: 'w1', actorName: 'Alpha-Worker-0', parentId: 'boss' }),
      ]);
      const seen: string[] = [];
      fixture.componentInstance.memberSelected.subscribe((id) => seen.push(id));

      const cards = host().querySelectorAll<HTMLButtonElement>('.member-card');
      expect(cards.length).toBe(2);
      cards[1].click();

      expect(seen).toEqual(['w1']);
    });

    /** The Member tab lists agents only, so the human card has nothing to open. */
    it('leaves the human card a plain card that emits nothing', async () => {
      await setup([
        node({ name: 'me', actorName: 'Human-Proxy-0', role: HUMAN_ROLE }),
        node({ name: 'boss', actorName: 'Manager-Supervisor-0' }),
      ]);
      const seen: string[] = [];
      fixture.componentInstance.memberSelected.subscribe((id) => seen.push(id));

      const human = host().querySelector<HTMLElement>('.human-card')!;
      expect(human.tagName).toBe('DIV');
      expect(human.querySelector('button')).toBeNull();
      human.click();

      expect(seen).toEqual([]);
    });
  });
});
