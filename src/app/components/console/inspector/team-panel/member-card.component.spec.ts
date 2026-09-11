import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MemberCardComponent } from './member-card.component';
import { InspectorMember } from './team-members.selector';
import {
  provideTranslateTesting,
  setTestTranslations,
} from '../../../../../testing/i18n-testing';

function member(overrides: Partial<InspectorMember> = {}): InspectorMember {
  return {
    id: 'agent-1',
    label: 'Researcher [Analyst]',
    actorName: 'researcher-analyst-batch-1',
    initial: 'R',
    roleKey: 'inspector.role.worker',
    kind: 'worker',
    depth: 0,
    active: true,
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
 * The block at the bottom covers the trailing "read the conversation" action
 * (W5a). Its assertions are mostly about SEPARATION — the two controls must not
 * become one — because that is the failure that would strand a user on a tab
 * they never chose.
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

  it('emits the agent_id when the row is activated', () => {
    render(member({ id: 'agent-42' }));
    const seen: string[] = [];
    fixture.componentInstance.selected.subscribe((id) => seen.push(id));

    card().click();

    expect(seen).toEqual(['agent-42']);
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

  // =========================================================================
  // W5a — the trailing "read this member's conversation" action.
  // =========================================================================

  function readButton(): HTMLButtonElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector(
      '.member-read button',
    );
    if (el === null) {
      throw new Error('the read action did not render');
    }
    return el as HTMLButtonElement;
  }

  it('renders the read action at rest, not only on hover', () => {
    // A control revealed on hover is invisible to the user hunting for it and
    // unreachable by touch. Asserted through the rendered element rather than
    // the stylesheet: whatever hides it, the consequence is the same.
    render(member());

    expect(readButton()).not.toBeNull();
    expect(readButton().tagName).toBe('BUTTON');
  });

  it('emits readRequested with the agent_id, on its OWN output', () => {
    render(member({ id: 'agent-42' }));
    const read: string[] = [];
    fixture.componentInstance.readRequested.subscribe((id) => read.push(id));

    readButton().click();

    expect(read).toEqual(['agent-42']);
  });

  it('does NOT also select the member — two destinations, not one click', () => {
    // Firing both would switch the Member tab behind the dialog the reader
    // opens, so dismissing the dialog would leave the user on a tab they never
    // asked for.
    render(member({ id: 'agent-42' }));
    const selected: string[] = [];
    fixture.componentInstance.selected.subscribe((id) => selected.push(id));

    readButton().click();

    expect(selected).toEqual([]);
  });

  it('activating the ROW still selects and does not open the reader', () => {
    // The other direction, and the one that matters for "nothing the user can
    // do today may become impossible": the Epic-56 behaviour is untouched.
    render(member({ id: 'agent-7' }));
    const selected: string[] = [];
    const read: string[] = [];
    fixture.componentInstance.selected.subscribe((id) => selected.push(id));
    fixture.componentInstance.readRequested.subscribe((id) => read.push(id));

    card().click();

    expect(selected).toEqual(['agent-7']);
    expect(read).toEqual([]);
  });

  it('keeps the two controls as SIBLINGS, never one nested in the other', () => {
    // A <button> inside a <button> is invalid, and the browsers that tolerate
    // it disagree about which one a click reaches — for a control that opens a
    // dialog, that is the difference between a reader and a tab switch.
    render(member());

    expect(card().contains(readButton())).toBeFalse();
    expect(readButton().contains(card())).toBeFalse();
  });

  it('gives the read action an accessible name from the translation layer', () => {
    // An icon-only control with no name is unusable by a screen reader, and
    // hardcoded copy here would never be translated.
    //
    // Its OWN key: this used to borrow `chat.reader.header` ("Agent
    // conversation"), a dialog HEADING pressed into service as a button label.
    // A control's name should say what pressing it does.
    setTestTranslations({ inspector: { readConversation: '<<read>>' } });
    render(member());

    expect(readButton().getAttribute('aria-label')).toBe('<<read>>');
    expect(readButton().getAttribute('title')).toBe('<<read>>');
  });
});
