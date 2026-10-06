import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MemberCardComponent } from './member-card.component';
import { InspectorMember } from '../../../../services/console/inspector/team-panel/team-members.selector';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../../testing/i18n-testing';

function member(overrides: Partial<InspectorMember> = {}): InspectorMember {
  return {
    id: 'agent-1',
    label: 'Researcher [Analyst]',
    initial: 'R',
    roleKey: 'inspector.role.worker',
    kind: 'worker',
    depth: 0,
    active: true,
    colour: null,
    ...overrides,
  };
}

/**
 * The member row.
 *
 * The assertions worth having here are the ones the prototype got wrong: that
 * the row is reachable and reports what was clicked (its cards are inert divs),
 * that supervisor and worker are visually distinguishable (they share one
 * avatar style in the mock), and that the indent tracks the derived depth
 * rather than a flat two-level guess.
 *
 * A card opens that agent in the Member tab, and nothing else: the trailing
 * speech-bubble action and the reader it once opened are gone (Epic 55).
 */
describe('MemberCardComponent', () => {
  let fixture: ComponentFixture<MemberCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MemberCardComponent],
      providers: [provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(MemberCardComponent);
  });

  function render(m: InspectorMember): void {
    fixture.componentRef.setInput('member', m);
    fixture.detectChanges();
  }

  function card(): HTMLElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector(
      '.member-card',
    );
    if (el === null) {
      throw new Error('the card did not render');
    }
    return el as HTMLElement;
  }

  it('renders the row as a button, so it is reachable by keyboard', () => {
    render(member());

    // The mock's cards are `<div (click)>`: mouse-only, and invisible to a
    // screen reader as anything actionable.
    expect(card().tagName).toBe('BUTTON');
    expect(card().getAttribute('type')).toBe('button');
  });

  it('a click on the card emits selected with the agent_id', () => {
    render(member({ id: 'agent-42' }));
    const selected: string[] = [];
    fixture.componentInstance.selected.subscribe((id) => selected.push(id));

    card().click();

    expect(selected).toEqual(['agent-42']);
  });

  /**
   * THE KEYBOARD, through the native button. A focused `<button>` turns Enter
   * and Space into a click dispatched AT THE BUTTON, which a handler on an inner
   * element would never see — so the handler must sit on the card itself.
   */
  it('Enter or Space on the focused card does the same, as a native button', () => {
    render(member({ id: 'agent-42' }));
    const selected: string[] = [];
    fixture.componentInstance.selected.subscribe((id) => selected.push(id));

    document.body.appendChild(fixture.nativeElement);
    card().focus();
    expect(document.activeElement).toBe(card());
    // The activation the browser performs for Enter / Space on a button.
    card().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (fixture.nativeElement as HTMLElement).remove();

    expect(selected).toEqual(['agent-42']);
  });

  /** A card names what pressing it does, and whose details it opens. */
  it('labels the card with openMemberDetails and the agent', () => {
    setTestTranslations({
      inspector: { openMemberDetails: '<<details:{{agent}}>>' },
    });
    render(member({ label: '@Expert' }));

    expect(card().getAttribute('aria-label')).toBe('<<details:@Expert>>');
    // It opens a tab, not a dialog.
    expect(card().hasAttribute('aria-haspopup')).toBeFalse();
  });

  it('gives a supervisor and a worker different avatar treatments', () => {
    render(member({ kind: 'supervisor' }));
    expect(card().classList).toContain('supervisor');
    expect(card().classList).not.toContain('worker');

    render(member({ kind: 'worker' }));
    expect(card().classList).toContain('worker');
    expect(card().classList).not.toContain('supervisor');
  });

  it('publishes its DEPTH and lets the stylesheet own the step size', () => {
    // The card used to bind computed pixels, multiplying by a TypeScript
    // constant — which made `--akg-member-indent` a dead token that a
    // deployment could re-point with no effect. The seam is the depth.
    render(member({ depth: 0 }));
    expect(card().style.getPropertyValue('--akg-depth')).toBe('0');
    // And nothing writes the offset directly any more, which is what would
    // reintroduce the second owner.
    expect(card().style.marginLeft).toBe('');

    render(member({ depth: 2 }));
    expect(card().style.getPropertyValue('--akg-depth')).toBe('2');
  });

  it('multiplies the depth by whatever the indent token says', () => {
    // The other half, proven rather than assumed: `--akg-member-indent` is
    // declared in `_conversation-tokens.scss`, which TestBed does not compile
    // (only component `styleUrl`s are), so the token is supplied on the host
    // here. That is enough to exercise the `calc()` the stylesheet performs —
    // and re-pointing it is exactly the operation a rebranding deployment does.
    render(member({ depth: 3 }));
    (fixture.nativeElement as HTMLElement).style.setProperty(
      '--akg-member-indent',
      '10px',
    );

    expect(getComputedStyle(card()).marginLeft).toBe('30px');
  });

  it('renders the monogram the selector derived', () => {
    render(member({ initial: 'Q' }));

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.member-avatar')
        ?.textContent?.trim(),
    ).toBe('Q');
  });

  it('renders the role KEY through the translation layer', () => {
    // Asserting the key, not "Supervisor": the copy is free to change and this
    // spec should not be what stops it.
    render(member({ roleKey: 'inspector.role.supervisor' }));

    expect(
      (fixture.nativeElement as HTMLElement)
        .querySelector('.member-role')
        ?.textContent?.trim(),
    ).toBe('inspector.role.supervisor');
  });

  it('titles the status dot with the matching state, and marks an idle one', () => {
    setTestTranslations({
      inspector: { memberActive: '<<active>>', memberIdle: '<<idle>>' },
    });

    render(member({ active: true }));
    const live = (fixture.nativeElement as HTMLElement).querySelector(
      '.member-dot',
    );
    expect(live?.getAttribute('title')).toBe('<<active>>');
    expect(live?.classList).not.toContain('idle');

    render(member({ active: false }));
    const idle = (fixture.nativeElement as HTMLElement).querySelector(
      '.member-dot',
    );
    expect(idle?.getAttribute('title')).toBe('<<idle>>');
    expect(idle?.classList).toContain('idle');
  });

  it('has no trailing icon button: the card is the only control', () => {
    render(member());

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('app-icon-button')).toBeNull();
    expect(host.querySelectorAll('button').length).toBe(1);
  });
});

/**
 * THE AGENT'S COLOUR ON THE TILE.
 *
 * The monogram tile carries the same colour the agent's node wears on the
 * hierarchy graph and its speaker mark wears in the transcript; these assert the
 * two halves of that — the fill, and the `.tinted` class that fixes the ink on
 * top of it, without which the monogram keeps a grey chosen for the flat fill
 * and vanishes on the darker stops.
 */
describe('MemberCardComponent — agent colour', () => {
  let fixture: ComponentFixture<MemberCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MemberCardComponent],
      providers: [provideTranslateTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(MemberCardComponent);
  });

  function avatar(m: InspectorMember): HTMLElement {
    // `setInput`, not a field write: the card is OnPush, and assigning the
    // property directly leaves the view unmarked and the assertion reading the
    // previous render.
    fixture.componentRef.setInput('member', m);
    fixture.detectChanges();
    const el = (fixture.nativeElement as HTMLElement).querySelector(
      '.member-avatar',
    );
    if (el === null) {
      throw new Error('the avatar did not render');
    }
    return el as HTMLElement;
  }

  it('fills the tile with the member colour and fixes the ink', () => {
    const el = avatar(member({ colour: 'rgb(170, 0, 0)' }));

    expect(el.style.backgroundColor).toBe('rgb(170, 0, 0)');
    expect(el.classList).toContain('tinted');
  });

  it('leaves the flat worker fill alone when the roster gave no colour', () => {
    // A tile is never blank: with no colour it keeps `--akg-avatar-worker-bg`
    // from the stylesheet, which means writing no inline background at all.
    const el = avatar(member({ colour: null }));

    expect(el.style.backgroundColor).toBe('');
    expect(el.classList).not.toContain('tinted');
  });

  it('a tinted supervisor gets the same ink as a tinted worker, not its accent ink', () => {
    // The supervisor's resting ink is accent-bright, chosen for the accent
    // fill; on its own ramp stop it must step to the ramp's ink like a worker
    // does, or @Manager's monogram reads green on green.
    const plainSupervisor = getComputedStyle(
      avatar(member({ kind: 'supervisor', colour: null })),
    ).color;
    const tintedWorker = getComputedStyle(
      avatar(member({ kind: 'worker', colour: 'rgb(0, 93, 70)' })),
    ).color;
    const tintedSupervisor = getComputedStyle(
      avatar(member({ kind: 'supervisor', colour: 'rgb(0, 93, 70)' })),
    ).color;

    // `--akg-agent-mark-fg`: the white every other agent monogram wears.
    expect(tintedSupervisor).toBe('rgb(255, 255, 255)');
    expect(tintedSupervisor).toBe(tintedWorker);
    expect(tintedSupervisor).not.toBe(plainSupervisor);
  });
});
