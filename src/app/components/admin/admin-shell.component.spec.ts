import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { BehaviorSubject, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { AuthService } from '../../core/auth/auth.service';
import { AdminSectionCounts } from './admin-section-counts.service';
import { AdminShellComponent } from './admin-shell.component';

/**
 * A destination for the three admin URLs, so `routerLinkActive` has a real
 * navigation to react to. Empty on purpose: the specs below are about which
 * rail anchor is marked, not about what the pane renders.
 */
@Component({ standalone: true, template: '' })
class BlankPaneComponent {}

/** The admin URLs the rail points at, plus the deep link nested under one. */
const RAIL_ROUTES = [
  { path: 'admin/catalog/namespace/:namespace', component: BlankPaneComponent },
  { path: 'admin/catalog', component: BlankPaneComponent },
  { path: 'admin/api-keys', component: BlankPaneComponent },
];

/**
 * Story 36-1 (AC #8) — the one-section rail is not rendered.
 *
 * Unlike the menubar specs in `app.component.spec.ts`, this fixture mounts the
 * component normally (no `CUSTOM_ELEMENTS_SCHEMA` stub set), so a
 * `querySelector` returning `null` is a real assertion about the DOM.
 */
describe('AdminShellComponent (Story 36-1)', () => {
  let fixture: ComponentFixture<AdminShellComponent>;
  let currentUser$: BehaviorSubject<any>;
  let counts: AdminSectionCounts;

  beforeEach(async () => {
    currentUser$ = new BehaviorSubject<any>({ user_id: 'anonymous' });

    await TestBed.configureTestingModule({
      imports: [AdminShellComponent, RouterTestingModule.withRoutes(RAIL_ROUTES)],
      providers: [
        // The REAL holder, not a double. In production it is registered on the
        // shell's route `providers` (Story 36-9); here the TestBed injector
        // stands in for that environment injector, so the shell resolves the
        // same instance a pane would publish into.
        AdminSectionCounts,
        {
          provide: AuthService,
          useValue: {
            currentUser$,
            isAdmin$: currentUser$.pipe(
              map((u) => u?.roles?.includes('admin') === true),
            ),
            checkAuth: jasmine.createSpy('checkAuth').and.returnValue(of(true)),
            logout: jasmine.createSpy('logout'),
          },
        },
      ],
    }).compileComponents();

    counts = TestBed.inject(AdminSectionCounts);
    fixture = TestBed.createComponent(AdminShellComponent);
  });

  function rail(): HTMLElement | null {
    return fixture.nativeElement.querySelector('nav.admin-rail');
  }

  /**
   * Story 36-9 narrowed this from the whole anchor to `.admin-rail-label`: the
   * anchor now also carries a count badge, whose digits would otherwise land in
   * the label text and redden the assertions below for a reason that has
   * nothing to do with the labels.
   */
  function railLabels(): string[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('nav.admin-rail a .admin-rail-label'),
    ).map((a) => (a as HTMLElement).textContent!.trim());
  }

  function byTest(value: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-test="${value}"]`);
  }

  async function render(user: any): Promise<void> {
    currentUser$.next(user);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('(AC8) an admin sees a rail with both sections', async () => {
    await render({ user_id: 'u-1', roles: ['admin'] });

    expect(rail()).not.toBeNull();
    expect(railLabels()).toEqual(['Catalog', 'API Keys']);
  });

  it('(AC8) a non-admin gets NO rail element at all', async () => {
    await render({ user_id: 'u-2', roles: ['user'] });

    // Absent, not present-and-empty: with one reachable section a rail is
    // navigational noise. An `*ngFor` over zero items would leave the <nav>
    // standing and redden this for the wrong reason.
    expect(rail()).toBeNull();
  });

  it('(AC8) the anonymous user gets NO rail element either', async () => {
    await render({ user_id: 'anonymous' });

    expect(rail()).toBeNull();
  });

  it('(AC8) the rail appears reactively when a LATE admin resolution lands', async () => {
    await render({ user_id: 'anonymous' });
    expect(rail()).toBeNull();

    await render({ user_id: 'u-1', roles: ['admin'] });

    expect(rail()).not.toBeNull();
  });

  it('(AC6) the shell always renders a router-outlet, rail or no rail', async () => {
    await render({ user_id: 'u-2', roles: ['user'] });
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();

    await render({ user_id: 'u-1', roles: ['admin'] });
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });

  it('(AC8) rail links target the admin child routes', async () => {
    await render({ user_id: 'u-1', roles: ['admin'] });

    const hrefs = Array.from(
      fixture.nativeElement.querySelectorAll('nav.admin-rail a'),
    ).map((a) => (a as HTMLAnchorElement).getAttribute('href'));
    expect(hrefs).toEqual(['/admin/catalog', '/admin/api-keys']);
  });

  // =========================================================================
  // Story 36-9 — the eyebrow, the counts, and an active item you can see
  // =========================================================================

  const ADMIN = { user_id: 'u-1', roles: ['admin'] };

  it('(36-9 AC1) the rail carries an ADMINISTRATION eyebrow, above the items', async () => {
    await render(ADMIN);

    const eyebrow = byTest('admin-rail-eyebrow');
    expect(eyebrow).not.toBeNull();
    expect(eyebrow!.textContent!.trim()).toBe('ADMINISTRATION');
    // A heading, not a destination — an anchor here would be a third rail item
    // that goes nowhere.
    expect(eyebrow!.tagName).not.toBe('A');
    // Ordered first: the rail's own first element child.
    expect(rail()!.firstElementChild).toBe(eyebrow);
  });

  it('(36-9 AC1) a caller with no rail gets no eyebrow either', async () => {
    // The eyebrow belongs to the rail, so it cannot outlive it: a non-admin
    // reaches one section and gets neither.
    await render({ user_id: 'u-2', roles: ['user'] });

    expect(rail()).toBeNull();
    expect(byTest('admin-rail-eyebrow')).toBeNull();
  });

  it('(36-9 AC2) an UNKNOWN count renders no element at all — not a zero', async () => {
    // The first paint: neither pane has been visited, so neither has published.
    await render(ADMIN);

    expect(byTest('admin-rail-count-catalog')).toBeNull();
    expect(byTest('admin-rail-count-api-keys')).toBeNull();
  });

  it('(36-9 AC2) a published count renders as its number, per section', async () => {
    await render(ADMIN);

    counts.setCatalog(5);
    counts.setApiKeys(2);
    fixture.detectChanges();

    expect(byTest('admin-rail-count-catalog')!.textContent!.trim()).toBe('5');
    expect(byTest('admin-rail-count-api-keys')!.textContent!.trim()).toBe('2');
  });

  it('(36-9 AC2) a known ZERO renders 0 — unknown and zero never render alike', async () => {
    // The spec that separates the two facts. `*ngIf` on truthiness rather than
    // on `!== null` collapses them, and this is the only assertion that sees it.
    await render(ADMIN);

    counts.setCatalog(0);
    fixture.detectChanges();

    expect(byTest('admin-rail-count-catalog')).not.toBeNull();
    expect(byTest('admin-rail-count-catalog')!.textContent!.trim()).toBe('0');
    // ...while the pane nobody published for is still absent, in the same DOM.
    expect(byTest('admin-rail-count-api-keys')).toBeNull();
  });

  it('(36-9 AC2) a count that goes back to UNKNOWN removes the badge again', async () => {
    // The catalog's failed-load path publishes `null`. A badge that survived it
    // would keep asserting the previous load's number about a load that failed.
    await render(ADMIN);
    counts.setCatalog(5);
    fixture.detectChanges();
    expect(byTest('admin-rail-count-catalog')).not.toBeNull();

    counts.setCatalog(null);
    fixture.detectChanges();

    expect(byTest('admin-rail-count-catalog')).toBeNull();
  });

  it('(36-9 AC2) the count does not leak into the rail label', async () => {
    await render(ADMIN);
    counts.setCatalog(5);
    counts.setApiKeys(2);
    fixture.detectChanges();

    expect(railLabels()).toEqual(['Catalog', 'API Keys']);
  });

  it('(36-9 AC3) the counts cost the shell no request', async () => {
    // The shell injects no data client at all: `ApiService` is not provided in
    // this TestBed, so a fetch added to the shell would fail to inject rather
    // than pass unnoticed. Rendering with both counts published proves the rail
    // is fed entirely by the holder.
    counts.setCatalog(5);
    counts.setApiKeys(2);
    await render(ADMIN);

    expect(byTest('admin-rail-count-catalog')!.textContent!.trim()).toBe('5');
    expect(byTest('admin-rail-count-api-keys')!.textContent!.trim()).toBe('2');
  });

  it('(36-9 AC5) the active item is marked, and it is the only one', async () => {
    // Asserted on WHICH anchor carries `active`, never on a colour: a spec
    // pinned to a colour makes the theme unchangeable.
    await render(ADMIN);
    const router = TestBed.inject(Router);
    await fixture.ngZone!.run(() => router.navigateByUrl('/admin/api-keys'));
    fixture.detectChanges();

    const anchors = Array.from(
      fixture.nativeElement.querySelectorAll('nav.admin-rail a'),
    ) as HTMLAnchorElement[];
    const active = anchors.filter((a) => a.classList.contains('active'));
    expect(active.length).toBe(1);
    expect(active[0].getAttribute('href')).toBe('/admin/api-keys');
  });

  it('(36-9 AC5) the namespace deep link keeps Catalog active', async () => {
    // `/admin/catalog/namespace/:namespace` is a child of the catalog section,
    // so the rail must not go blank on it. `routerLinkActive` matches on the
    // prefix, and this is the spec that says so.
    await render(ADMIN);
    const router = TestBed.inject(Router);
    await fixture.ngZone!.run(() =>
      router.navigateByUrl('/admin/catalog/namespace/acme-team'),
    );
    fixture.detectChanges();

    const anchors = Array.from(
      fixture.nativeElement.querySelectorAll('nav.admin-rail a'),
    ) as HTMLAnchorElement[];
    const active = anchors.filter((a) => a.classList.contains('active'));
    expect(active.length).toBe(1);
    expect(active[0].getAttribute('href')).toBe('/admin/catalog');
  });

  // =========================================================================
  // Story 36-11 — the card surface, and the honest limit of asserting it here
  //
  // WHAT THESE TWO SPECS ESTABLISH: the surface container exists, carries its
  // hook, and contains the outlet — so every routed pane, present and future,
  // is mounted inside it rather than beside it.
  //
  // WHAT THEY CANNOT ESTABLISH, and this is not a choice: that the container is
  // PAINTED at all, that its tint matches Home's, that the radius is visible,
  // that the padding is right, or that the panes' loading / empty / no-match /
  // unavailable states stay legible on it. Karma sees the DOM tree, not the box
  // model — during 36-9 a `display: flex` on a `<td>` dropped a whole column out
  // of the table's grid and 1760 green specs did not see it. A
  // `getComputedStyle` assertion added here would pin the theme and STILL not
  // prove legibility, so the visual half is discharged by looking at the running
  // app, not by these.
  //
  // The stated limit: moving the hook up to `.admin-shell` leaves both specs
  // green, because the shell also contains the outlet. They prove the outlet is
  // inside the HOOKED element, not that the hooked element is the painted one.
  // =========================================================================

  function adminContent(): HTMLElement | null {
    return byTest('admin-content');
  }

  it('(36-11 AC5) the surface container wraps the outlet', async () => {
    await render(ADMIN);

    const content = adminContent();
    expect(content).not.toBeNull();
    // Scoped to the container, not to the fixture: an outlet that had drifted
    // OUT of the surface would still answer a fixture-wide query, and every
    // routed pane would then render off the card.
    expect(content!.querySelector('router-outlet')).not.toBeNull();
  });

  it('(36-11 AC5) both admin destinations mount INSIDE the surface', async () => {
    await render(ADMIN);
    const router = TestBed.inject(Router);

    for (const url of ['/admin/catalog', '/admin/api-keys']) {
      await fixture.ngZone!.run(() => router.navigateByUrl(url));
      fixture.detectChanges();

      // The routed component's own host element — Angular inserts it as a
      // sibling of the `<router-outlet>`, so containment is the assertion that
      // says "this pane renders on the card". `BlankPaneComponent` renders an
      // empty template but still has a host, which is why the existing harness
      // is enough and the real panes are not mounted here.
      const routed = fixture.debugElement.query(By.directive(BlankPaneComponent));
      expect(routed).withContext(url).not.toBeNull();
      expect(adminContent()!.contains(routed.nativeElement))
        .withContext(url)
        .toBe(true);
    }
  });
});
