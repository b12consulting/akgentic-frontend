import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { BehaviorSubject, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { AuthService } from '../../core/auth/auth.service';
import { AdminShellComponent } from './admin-shell.component';

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

  beforeEach(async () => {
    currentUser$ = new BehaviorSubject<any>({ user_id: 'anonymous' });

    await TestBed.configureTestingModule({
      imports: [AdminShellComponent, RouterTestingModule],
      providers: [
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

    fixture = TestBed.createComponent(AdminShellComponent);
  });

  function rail(): HTMLElement | null {
    return fixture.nativeElement.querySelector('nav.admin-rail');
  }

  function railLabels(): string[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('nav.admin-rail a'),
    ).map((a) => (a as HTMLElement).textContent!.trim());
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
});
