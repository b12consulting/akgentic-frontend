import { NgZone } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { ContextService } from '../../../core/context/context.service';
import { ApiService } from '../../../core/http/api.service';
import { TeamCreationLauncher } from '../team-creation-launcher.service';
import { TeamCreationService } from '../../../services/home/team-creation/team-creation.service';
import {
  NamespaceSummary,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';
import { provideTranslateTesting, setTestTranslations } from '../../../../testing/i18n-testing';
import { TeamCreationDialogComponent } from './team-creation-dialog.component';

function contract(keys: string[]): TeamMetadataContract {
  return {
    type: 'acme.contracts.CaseMetadata',
    fields: keys.map((key) => ({
      key,
      description: `${key} field`,
      index: false,
      mandatory: false,
    })),
  };
}

function ns(
  namespace: string,
  overrides: Partial<NamespaceSummary> = {},
): NamespaceSummary {
  return {
    namespace,
    name: `${namespace} team`,
    description: '',
    team: true,
    shareable: false,
    public: false,
    owner: null,
    counts: { team: { total: 1 } },
    team_metadata: null,
    ...overrides,
  };
}

/**
 * A LIBRARY namespace — prompts, tools or knowledge, with no team to
 * instantiate. The two the catalog ships everywhere ("Global Library",
 * "Global Tools") are exactly this, and `ns` above cannot express it: its
 * `team: true` is what every other spec in this file needs.
 */
function libNs(namespace: string): NamespaceSummary {
  return ns(namespace, { team: false });
}

describe('TeamCreationDialogComponent', () => {
  let fixture: ComponentFixture<TeamCreationDialogComponent>;
  let component: TeamCreationDialogComponent;

  let apiSpy: jasmine.SpyObj<ApiService>;
  let contextSpy: jasmine.SpyObj<ContextService>;
  let routerStub: { navigate: jasmine.Spy };
  let launcher: TeamCreationLauncher;
  /**
   * The signed-in account, as `/auth/me` reports it.
   *
   * A subject rather than a fixed value because `isAdmin` is derived from the
   * STREAM on purpose: `/auth/me` resolves after first render, and a one-shot
   * read would hide the admin toggle from an admin whose roles land late. That
   * late arrival is a case worth being able to reproduce here.
   */
  let user$: BehaviorSubject<{ roles?: string[] } | null>;

  beforeEach(() => {
    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', ['getNamespaces']);
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([]));

    contextSpy = jasmine.createSpyObj<ContextService>('ContextService', ['createTeam']);
    contextSpy.createTeam.and.returnValue(Promise.resolve('team-new'));

    routerStub = { navigate: jasmine.createSpy('navigate') };
    // A non-admin by default, which is what every spec that says nothing about
    // roles should see: the firehose toggle is not part of the ordinary flow.
    user$ = new BehaviorSubject<{ roles?: string[] } | null>({ roles: [] });

    TestBed.configureTestingModule({
      imports: [TeamCreationDialogComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        { provide: ApiService, useValue: apiSpy },
        { provide: ContextService, useValue: contextSpy },
        { provide: Router, useValue: routerStub },
        { provide: AuthService, useValue: { currentUser$: user$ } },
      ],
    });

    // T3: the metadata modal's two parameterised strings come back as bare keys
    // under the no-op loader, so anything asserted about them would be reading
    // the key rather than the component. Deliberately synthetic, never the
    // shipped copy.
    setTestTranslations({
      home: {
        metadata: {
          patternMismatch: '<<pattern={{pattern}}>>',
          required: '<<fields={{fields}}>>',
        },
      },
    });

    launcher = TestBed.inject(TeamCreationLauncher);
  });

  /** Mount the wizard and let the namespace fetch settle. */
  async function render(list: NamespaceSummary[] = []): Promise<void> {
    apiSpy.getNamespaces.and.returnValue(Promise.resolve(list));
    fixture = TestBed.createComponent(TeamCreationDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** PrimeNG teleports dialog bodies out of the host, so query the document. */
  function el(dataTest: string): HTMLElement | null {
    return document.querySelector(`[data-test="${dataTest}"]`) as HTMLElement | null;
  }

  function typeRadio(namespace: string): HTMLInputElement {
    return el(`creation-type-${namespace}`) as unknown as HTMLInputElement;
  }

  function primary(): HTMLButtonElement {
    return el('team-creation-primary') as unknown as HTMLButtonElement;
  }

  /** Choose a type the way a user does — by clicking its radio. */
  function choose(namespace: string): void {
    typeRadio(namespace).click();
    fixture.detectChanges();
  }

  /** Press the primary button and let the gate's promise settle. */
  async function pressPrimary(): Promise<void> {
    primary().click();
    await settle();
  }

  /**
   * Is a dialog ON SCREEN?
   *
   * Asked of the dialog's HEADER, never of the `<p-dialog>` element itself:
   * PrimeNG leaves its host in the DOM permanently and mounts only the mask and
   * its contents behind an `*ngIf`, so a `[data-test]` on the component tag
   * answers "is it declared", which is always yes, rather than "is it open".
   * A mutual-exclusivity assertion written against the tag would pass on a
   * component that showed both dialogs at once.
   */
  function metadataDialogOpen(): boolean {
    return el('metadata-dialog-header') !== null;
  }

  function typeDialogOpen(): boolean {
    return el('team-creation-header') !== null;
  }

  // -------------------------------------------------------------------------
  // Step 1 — the type list
  // -------------------------------------------------------------------------

  it('renders one choice per fetched namespace', async () => {
    await render([ns('alpha'), ns('beta')]);

    expect(typeRadio('alpha')).toBeTruthy();
    expect(typeRadio('beta')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // W19a — a LIBRARY namespace is not a team type.
  //
  // `GET /admin/catalog/namespaces` lists every namespace the account can see,
  // and only some declare a team: the catalog ships "Global Library" and
  // "Global Tools" to every deployment with `team: false`. This dialog rendered
  // that list verbatim, so both appeared under "choose the type of team to
  // create", selectable, with Create live behind them.
  //
  // These fail on a dialog that fetches through `ApiService` and renders what
  // it gets; they pass on one that asks `TeamTypeCatalog` for team types.
  // -------------------------------------------------------------------------

  it('does NOT offer a library namespace as a type of team to create', async () => {
    await render([libNs('global-library'), ns('agent-team-v1'), libNs('global-tools')]);

    expect(typeRadio('agent-team-v1')).toBeTruthy();
    expect(typeRadio('global-library')).toBeNull();
    expect(typeRadio('global-tools')).toBeNull();
  });

  it('never PRESELECTS a library namespace, however the endpoint ordered the list', async () => {
    // The preselection is what the primary button acts on before the user has
    // touched anything, so `[0]` landing on a library row is the shortest path
    // from this defect to a created-into-nothing team.
    await render([libNs('global-library'), ns('agent-team-v1')]);

    expect(component.selected()?.namespace).toBe('agent-team-v1');
  });

  it('says there is nothing to create when the catalog holds ONLY libraries', async () => {
    // Honest, and the state the user can act on: a settled, empty type list.
    // The alternative is what shipped — two uncreatable rows and a live button.
    await render([libNs('global-library'), libNs('global-tools')]);

    expect(component.typesState()).toBe('empty');
    expect(el('team-creation-empty')).toBeTruthy();
    expect(primary().disabled).toBe(true);
  });

  it('names a type by its catalog name, falling back to the namespace id', async () => {
    await render([ns('alpha', { name: 'Payroll cases' }), ns('beta', { name: '' })]);

    const rows = Array.from(
      document.querySelectorAll('.team-creation__type-name'),
    ).map((node) => (node.textContent ?? '').trim());

    expect(rows).toEqual(['Payroll cases', 'beta']);
  });

  it('fetches the OWNER-SCOPED list — never the admin `all=true` firehose', async () => {
    // ADR-028: the "show all namespaces" toggle exists so an admin can INSPECT
    // foreign-owned namespaces. Creating into one is not what it is for.
    await render([ns('alpha')]);

    expect(apiSpy.getNamespaces).toHaveBeenCalledTimes(1);
    expect(apiSpy.getNamespaces).toHaveBeenCalledWith();
  });

  it('preselects the first type, so the primary button means something on arrival', async () => {
    await render([ns('alpha'), ns('beta')]);

    expect(component.selected()?.namespace).toBe('alpha');
    expect(typeRadio('alpha').checked).toBe(true);
    expect(typeRadio('beta').checked).toBe(false);
  });

  it('shows the empty state only once the fetch has SETTLED, never while it is in flight', async () => {
    // "You have no team types" is a claim about the account; making it mid-fetch
    // tells a user on a slow link that they cannot create anything.
    let resolve!: (list: NamespaceSummary[]) => void;
    apiSpy.getNamespaces.and.returnValue(
      new Promise<NamespaceSummary[]>((r) => (resolve = r)),
    );
    fixture = TestBed.createComponent(TeamCreationDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.typesState()).toBe('loading');
    expect(el('team-creation-empty')).toBeNull();

    resolve([]);
    await settle();

    expect(component.typesState()).toBe('empty');
    expect(el('team-creation-empty')).toBeTruthy();
  });

  it('disables the primary button when there is nothing to create', async () => {
    await render([]);

    expect(primary().disabled).toBe(true);
  });

  it('survives a failed namespace fetch with an empty list rather than a crash', async () => {
    spyOn(console, 'error');
    apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));
    fixture = TestBed.createComponent(TeamCreationDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await settle();

    expect(component.typesState()).toBe('empty');
    expect(component.selected()).toBeNull();
  });

  it('holds the step\'s first line off the dialog header rather than against it', async () => {
    // W9b. Aura ships `dialog.content.padding` with a top of ZERO, so the body
    // begins flush against the header's hairline rule — which put the uppercase
    // group label ("CHOOSE THE TYPE OF TEAM TO CREATE") hard under the title and
    // made it read as the title's second line.
    //
    // Asserted on the COMPUTED value rather than by matching the stylesheet
    // text: the rule is written as `var(--p-dialog-header-padding, 1.25rem)`, so
    // a source-level assertion would pin the expression while saying nothing
    // about whether it resolves to anything. Greater-than-zero rather than an
    // exact px, because the resolved value legitimately differs between a theme
    // that defines that token and a TestBed that does not — the defect is the
    // ZERO, and zero is what this catches.
    await render([ns('alpha')]);

    const content = document.querySelector(
      '.team-creation-dialog .p-dialog-content',
    ) as HTMLElement | null;

    expect(content).withContext('dialog content element').toBeTruthy();
    expect(parseFloat(getComputedStyle(content!).paddingTop)).toBeGreaterThan(0);
  });

  it('puts that room on the CONTENT, so every possible first child gets it', async () => {
    // Three different elements take the first position — the admin toggle, the
    // empty state and the fieldset — and a margin on one of them would be a
    // margin the other two do not have. The empty case is the cheapest one to
    // catch that with, because it renders none of the other two.
    await render([]);

    const content = document.querySelector(
      '.team-creation-dialog .p-dialog-content',
    ) as HTMLElement | null;

    expect(el('team-creation-empty')).withContext('the empty state').toBeTruthy();
    expect(parseFloat(getComputedStyle(content!).paddingTop)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // The primary button's label — the gate's answer, not a second derivation
  // -------------------------------------------------------------------------

  it('labels the primary button "next" for a type that asks something', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);

    expect(component.primaryLabelKey()).toBe('common.next');
  });

  it('labels it "create" for a type that asks nothing', async () => {
    await render([ns('alpha')]);

    expect(component.primaryLabelKey()).toBe('common.create');
  });

  it('labels it "create" for a contract declaring NO FIELDS — falsiness, not `!== null`', async () => {
    // Gating on `=== null` is the documented bug `contractOf` exists to have
    // fixed once: an empty `fields` list asks nothing, so a second step would
    // be a dialog with no questions in it.
    await render([ns('alpha', { team_metadata: contract([]) })]);

    expect(component.primaryLabelKey()).toBe('common.create');
  });

  it('labels it "create" for a server that omits the field entirely', async () => {
    await render([ns('alpha', { team_metadata: undefined })]);

    expect(component.primaryLabelKey()).toBe('common.create');
  });

  it('re-labels the button when the chosen type changes', async () => {
    await render([ns('alpha'), ns('beta', { team_metadata: contract(['case_id']) })]);
    expect(component.primaryLabelKey()).toBe('common.create');

    choose('beta');

    expect(component.primaryLabelKey()).toBe('common.next');
  });

  // -------------------------------------------------------------------------
  // The transition
  // -------------------------------------------------------------------------

  it('advances a contract-bearing type to step 2 and POSTs nothing on the way', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);

    await pressPrimary();

    expect(component.step()).toBe('metadata');
    expect(contextSpy.createTeam).not.toHaveBeenCalled();
  });

  it('never has both dialogs on screen at once', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);

    expect(typeDialogOpen()).toBe(true);
    expect(metadataDialogOpen()).toBe(false);

    await pressPrimary();

    expect(typeDialogOpen()).toBe(false);
    expect(metadataDialogOpen()).toBe(true);
  });

  it('carries the chosen type\'s label into step 2, not the first row\'s', async () => {
    await render([
      ns('alpha'),
      ns('beta', { name: 'Case team', team_metadata: contract(['case_id']) }),
    ]);

    choose('beta');
    await pressPrimary();

    expect(component.creation.namespaceLabel).toBe('Case team');
  });

  it('creates a contract-free type immediately and navigates to it', async () => {
    await render([ns('alpha')]);
    launcher.open();

    await pressPrimary();

    expect(contextSpy.createTeam).toHaveBeenCalledOnceWith('alpha', undefined);
    expect(routerStub.navigate).toHaveBeenCalledOnceWith(['/process', 'team-new']);
    expect(component.step()).toBe('type');
    expect(launcher.isOpen()).toBe(false);
  });

  it('leaves step 1 open, with the type still chosen, when the create fails', async () => {
    spyOn(console, 'error');
    contextSpy.createTeam.and.returnValue(Promise.reject(new Error('nope')));
    await render([ns('alpha'), ns('beta')]);
    launcher.open();

    choose('beta');
    await pressPrimary();

    expect(component.step()).toBe('type');
    expect(component.selected()?.namespace).toBe('beta');
    expect(typeDialogOpen()).toBe(true);
    expect(routerStub.navigate).not.toHaveBeenCalled();
    expect(launcher.isOpen()).toBe(true);
  });

  it('re-arms the primary button after a failed create', async () => {
    spyOn(console, 'error');
    contextSpy.createTeam.and.returnValue(Promise.reject(new Error('nope')));
    await render([ns('alpha')]);

    await pressPrimary();

    expect(component.creation.creatingByGesture).toBe(false);
    expect(primary().disabled).toBe(false);
  });

  it('ignores a second press while a create is already in flight', async () => {
    // The gate's spinner doubles as the double-submit guard; this pins that the
    // wizard honours it rather than issuing a second POST.
    let resolve!: (id: string) => void;
    contextSpy.createTeam.and.returnValue(new Promise<string>((r) => (resolve = r)));
    await render([ns('alpha')]);

    primary().click();
    fixture.detectChanges();
    void component.onPrimary();
    await settle();

    expect(contextSpy.createTeam).toHaveBeenCalledTimes(1);

    resolve('team-new');
    await settle();
  });

  // -------------------------------------------------------------------------
  // Step 2 — the reused metadata modal
  // -------------------------------------------------------------------------

  it('creates with the answered metadata when step 2 is confirmed', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);
    await pressPrimary();

    component.onMetadataConfirmed({ case_id: 'C-1' });
    await settle();

    expect(contextSpy.createTeam).toHaveBeenCalledOnceWith('alpha', { case_id: 'C-1' });
    expect(routerStub.navigate).toHaveBeenCalledOnceWith(['/process', 'team-new']);
  });

  it('treats step 2\'s cancel as BACK: step 1 returns with the type still chosen', async () => {
    await render([
      ns('alpha'),
      ns('beta', { team_metadata: contract(['case_id']) }),
    ]);
    choose('beta');
    await pressPrimary();
    expect(component.step()).toBe('metadata');

    component.onMetadataCancelled();
    await settle();

    expect(component.step()).toBe('type');
    expect(component.selected()?.namespace).toBe('beta');
    expect(typeRadio('beta').checked).toBe(true);
    expect(contextSpy.createTeam).not.toHaveBeenCalled();
  });

  it('releases the gate\'s captured namespace on the way back', async () => {
    // Back is not abandon for the USER's choice, but the gate's capture must
    // still go: a stale contract would render step 2 for the wrong type if the
    // user then picked another one.
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);
    await pressPrimary();

    component.onMetadataCancelled();
    await settle();

    expect(component.creation.contract).toBeNull();
    expect(component.creation.namespaceLabel).toBe('');
  });

  it('a second dismissal — now on step 1 — closes the whole wizard', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);
    launcher.open();
    await pressPrimary();

    component.onMetadataCancelled();
    await settle();
    expect(launcher.isOpen()).toBe(true);

    component.onTypeDialogVisibleChange(false);

    expect(launcher.isOpen()).toBe(false);
  });

  it('lets a user who went back pick a different type and create it', async () => {
    // The whole point of BACK: the type choice survives, and the flow still
    // reaches a create afterwards.
    await render([
      ns('alpha'),
      ns('beta', { team_metadata: contract(['case_id']) }),
    ]);
    choose('beta');
    await pressPrimary();
    component.onMetadataCancelled();
    await settle();

    choose('alpha');
    await pressPrimary();

    expect(contextSpy.createTeam).toHaveBeenCalledOnceWith('alpha', undefined);
  });

  // -------------------------------------------------------------------------
  // Dismissal and the destination
  // -------------------------------------------------------------------------

  it('closes the wizard from Cancel on step 1, creating nothing', async () => {
    await render([ns('alpha')]);
    launcher.open();

    (el('team-creation-cancel') as unknown as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(launcher.isOpen()).toBe(false);
    expect(contextSpy.createTeam).not.toHaveBeenCalled();
  });

  it('ignores a visibility report that does not mean "step 1 was dismissed"', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);
    launcher.open();
    await pressPrimary();

    // A `false` arriving while step 2 is up must not close the flow — that
    // would dismiss the wizard on the way INTO its second half.
    component.onTypeDialogVisibleChange(false);
    expect(launcher.isOpen()).toBe(true);

    // And a `true` is never a dismissal.
    component.step.set('type');
    component.onTypeDialogVisibleChange(true);
    expect(launcher.isOpen()).toBe(true);
  });

  it('navigates EXACTLY ONCE per creation', async () => {
    await render([ns('alpha')]);

    await pressPrimary();

    expect(routerStub.navigate).toHaveBeenCalledTimes(1);
  });

  it('stops navigating once destroyed — a create that lands late reaches nobody', async () => {
    // `takeUntilDestroyed`, asserted through the gate's PUBLIC path: a creation
    // that resolves after the wizard is gone must not route a user who has
    // moved on somewhere else entirely.
    await render([ns('alpha')]);
    const gate = component.creation;
    const chosen = component.selected()!;

    fixture.destroy();
    await gate.request(chosen, 'gesture');

    expect(contextSpy.createTeam).toHaveBeenCalledTimes(1);
    expect(routerStub.navigate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // OnPush — the state this dialog renders does not announce itself
  // -------------------------------------------------------------------------

  /**
   * THE FROZEN-DIALOG BUG, AND THE ONLY WAY TO SEE IT.
   *
   * Everything this dialog renders from `TeamCreationService` is a plain field
   * behind a getter — deliberately, so the teams page could bind it without a
   * change-detection idiom swap — and a getter marks nothing dirty. The click
   * that starts the create marks the view; the state changes one turn later,
   * when the POST settles, and on an OnPush host nothing marks it again. The
   * dialog sits in its in-flight state with the error it captured invisible.
   *
   * `autoDetectChanges()` AND NEVER `fixture.detectChanges()`. The latter
   * refreshes this component's own view whatever its dirty flag says, which is
   * exactly the state the bug lives underneath: a spec written with it passes
   * against the broken code and proves nothing. Auto-detect drives change
   * detection from `ApplicationRef.tick()` on zone stabilisation — it walks
   * from the root and SKIPS clean OnPush views, which is what a browser does.
   */
  it('paints the 422 the gate captured, without being told to look', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);
    await pressPrimary();
    expect(metadataDialogOpen()).toBe(true);

    contextSpy.createTeam.and.returnValue(
      Promise.reject({ status: 422, body: { detail: 'case_id is required' } }),
    );

    fixture.autoDetectChanges();
    // Through the binding, exactly as the modal's `(confirmed)` reaches it —
    // and INSIDE `NgZone`, which is where a template event handler runs. Called
    // from the bare test zone the gate's promise continuations never reach
    // `onMicrotaskEmpty`, so no tick happens at all and the spec would fail
    // against correct code for a reason that has nothing to do with OnPush.
    TestBed.inject(NgZone).run(() => component.onMetadataConfirmed({ case_id: '' }));
    await fixture.whenStable();

    expect(component.creation.errorMessage).toBe('case_id is required');
    expect(el('metadata-error')?.textContent).toContain('case_id is required');
  });

  /**
   * The same defect on the other failure path: an ungated create that rejects
   * leaves `creatingByGesture` false and the button re-armed, and an OnPush
   * host that was never marked keeps showing a spinner on a request that has
   * already finished.
   */
  it('re-arms the primary button after a failed ungated create', async () => {
    spyOn(console, 'error');
    await render([ns('alpha')]);
    // Rejected on a MACROTASK, not a microtask. The click is a listener on this
    // component's own template, so it marks the view dirty by itself; a
    // rejection that lands in the same turn is repainted by that mark and the
    // defect is invisible. A real POST takes many turns, and this is the
    // shortest way to be one.
    // `callFake`, so the timer is scheduled INSIDE `NgZone` when the click
    // handler calls it. A promise built here, in the test zone, would leave
    // `NgZone` stable immediately and `whenStable()` would resolve before the
    // rejection had happened at all.
    contextSpy.createTeam.and.callFake(
      () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('boom')), 0)),
    );

    fixture.autoDetectChanges();
    primary().click();
    await fixture.whenStable();

    expect(component.creation.creatingByGesture).toBe(false);
    expect(primary().disabled).toBe(false);
    expect(component.step()).toBe('type');
  });

  // -------------------------------------------------------------------------
  // ADR-028 — the admin's widened list, which the page used to own
  // -------------------------------------------------------------------------

  /**
   * The capability R2 would otherwise have removed in silence. Before the
   * wizard, an admin turned the management page's "show all namespaces" switch
   * on and the team-type select — and its Create button — read the widened
   * list. Taking creation off that page took this with it.
   */
  it('hides the firehose from a non-admin entirely', async () => {
    await render([ns('alpha')]);

    expect(el('creation-show-all')).toBeNull();
  });

  it('offers it to an admin, off, and asks for the owner-scoped list first', async () => {
    user$.next({ roles: ['admin'] });
    await render([ns('alpha')]);

    const toggle = el('creation-show-all') as unknown as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);
    expect(apiSpy.getNamespaces).toHaveBeenCalledOnceWith();
  });

  it('appears for an admin whose roles land AFTER the first render', async () => {
    // `/auth/me` resolves after first paint. A one-shot `currentUserValue` read
    // would leave the toggle permanently hidden for a real admin.
    await render([ns('alpha')]);
    expect(el('creation-show-all')).toBeNull();

    user$.next({ roles: ['admin'] });
    fixture.detectChanges();

    expect(el('creation-show-all')).toBeTruthy();
  });

  it('widens the list on opt-in, and marks the rows the opt-in ADDED', async () => {
    user$.next({ roles: ['admin'] });
    await render([ns('mine')]);
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([ns('mine'), ns('theirs', { owner: 'someone-else' })]),
    );

    await component.onToggleShowAll(true);
    await settle();

    expect(apiSpy.getNamespaces).toHaveBeenCalledWith({ all: true });
    expect(typeRadio('theirs')).toBeTruthy();
    // "Foreign" is the set difference, which is the definition the client can
    // answer: a row the owner-scoped list did not contain.
    expect(el('creation-foreign-theirs')).toBeTruthy();
    expect(el('creation-foreign-mine')).toBeNull();
  });

  it('filters the WIDENED list too — the firehose is wider, not looser', async () => {
    // The admin toggle widens WHOSE namespaces are listed. It does not change
    // what a team can be created from, and a rule applied to one fetch and not
    // the other is the same defect with an extra step in front of it.
    user$.next({ roles: ['admin'] });
    await render([ns('mine')]);
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([ns('mine'), ns('theirs'), libNs('their-library')]),
    );

    await component.onToggleShowAll(true);
    await settle();

    expect(typeRadio('theirs')).toBeTruthy();
    expect(typeRadio('their-library')).toBeNull();
  });

  it('fetches the widened list once, however often the switch is flipped', async () => {
    user$.next({ roles: ['admin'] });
    await render([ns('mine')]);
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([ns('mine'), ns('theirs')]));

    await component.onToggleShowAll(true);
    await component.onToggleShowAll(false);
    await component.onToggleShowAll(true);
    await settle();

    expect(
      apiSpy.getNamespaces.calls.allArgs().filter((args) => args.length > 0).length,
    ).toBe(1);
  });

  it('re-seeds the selection when switching off would leave it off screen', async () => {
    user$.next({ roles: ['admin'] });
    await render([ns('mine')]);
    apiSpy.getNamespaces.and.returnValue(Promise.resolve([ns('mine'), ns('theirs')]));

    await component.onToggleShowAll(true);
    await settle();
    choose('theirs');
    expect(component.selected()?.namespace).toBe('theirs');

    await component.onToggleShowAll(false);
    await settle();

    // Left alone, the primary button would still be pointing at a namespace the
    // dialog had stopped showing.
    expect(component.selected()?.namespace).toBe('mine');
    expect(typeRadio('theirs')).toBeNull();
  });

  it('keeps the selection when it survives the switch', async () => {
    user$.next({ roles: ['admin'] });
    await render([ns('mine'), ns('other')]);
    apiSpy.getNamespaces.and.returnValue(
      Promise.resolve([ns('mine'), ns('other'), ns('theirs')]),
    );
    choose('other');

    await component.onToggleShowAll(true);
    await settle();

    expect(component.selected()?.namespace).toBe('other');
  });

  it('survives a failed widened fetch without re-issuing it on every flip', async () => {
    spyOn(console, 'error');
    user$.next({ roles: ['admin'] });
    await render([ns('mine')]);
    apiSpy.getNamespaces.and.returnValue(Promise.reject(new Error('boom')));

    await component.onToggleShowAll(true);
    await settle();
    await component.onToggleShowAll(false);
    await component.onToggleShowAll(true);
    await settle();

    expect(
      apiSpy.getNamespaces.calls.allArgs().filter((args) => args.length > 0).length,
    ).toBe(1);
    expect(component.typesState()).toBe('empty');
  });

  // -------------------------------------------------------------------------
  // Scoping — the reason this component exists rather than a root service
  // -------------------------------------------------------------------------

  it('provides the creation gate on ITSELF, so it dies with the dialog', async () => {
    await render([ns('alpha')]);
    const own = fixture.debugElement.injector.get(TeamCreationService);

    expect(own).toBe(component.creation);
    // Root must not be able to answer for it: a root-scoped gate would carry a
    // captured namespace across a navigation away and back.
    expect(() => TestBed.inject(TeamCreationService)).toThrow();
  });

  it('gives a second mount a FRESH gate, with no state carried over', async () => {
    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);
    await pressPrimary();
    expect(component.creation.contract).not.toBeNull();
    const first = component.creation;
    fixture.destroy();

    await render([ns('alpha', { team_metadata: contract(['case_id']) })]);

    expect(component.creation).not.toBe(first);
    expect(component.creation.contract).toBeNull();
    expect(component.step()).toBe('type');
  });
});
