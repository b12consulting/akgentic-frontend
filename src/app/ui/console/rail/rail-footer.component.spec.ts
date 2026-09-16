import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject } from 'rxjs';

import { AuthService } from '../../../core/platform/auth/auth.service';
import { ConfigService } from '../../../core/platform/config/config.service';
import { ContextService } from '../../../core/platform/context/context.service';
import { IconButtonComponent } from '../../../components/common/icon-button/icon-button.component';
import { provideTranslateTesting } from '../../../../testing/i18n-testing';
import { RailFooterComponent } from './rail-footer.component';

describe('RailFooterComponent', () => {
  let fixture: ComponentFixture<RailFooterComponent>;
  let component: RailFooterComponent;
  let currentUser$: BehaviorSubject<unknown>;
  let authSpy: jasmine.SpyObj<AuthService>;
  let contextSpy: jasmine.SpyObj<ContextService>;
  let config: { hideHome: boolean };

  const text = (selector: string): string | null => {
    const found = fixture.debugElement.query(By.css(selector));
    return found ? (found.nativeElement.textContent as string).trim() : null;
  };

  async function render(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [RailFooterComponent, NoopAnimationsModule],
      providers: [
        provideTranslateTesting(),
        { provide: AuthService, useValue: authSpy },
        { provide: ConfigService, useValue: config },
        { provide: ContextService, useValue: contextSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RailFooterComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    currentUser$ = new BehaviorSubject<unknown>({
      user_id: 'u-1',
      name: 'nadia okonkwo',
    });
    authSpy = jasmine.createSpyObj('AuthService', ['logout'], {
      currentUser$,
    }) as jasmine.SpyObj<AuthService>;
    contextSpy = jasmine.createSpyObj<ContextService>('ContextService', [
      'navigateHome',
    ]);
    contextSpy.navigateHome.and.returnValue(Promise.resolve(true));
    config = { hideHome: false };
  });

  it('prints the name verbatim — a person\'s name is not copy', async () => {
    await render();
    expect(text('.rail-footer__name')).toBe('nadia okonkwo');
  });

  it('uses the uppercased first character as the avatar glyph', async () => {
    await render();
    expect(text('.rail-footer__avatar')).toBe('N');
  });

  it('hides the avatar glyph from assistive technology', async () => {
    // The name beside it says the same thing; announcing the letter repeats it.
    await render();
    const avatar = fixture.debugElement.query(By.css('.rail-footer__avatar'));
    expect(avatar.nativeElement.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to a TRANSLATED anonymous label, not the service\'s English placeholder', async () => {
    // AuthService's sentinel carries the untranslated name "Anonymous";
    // matching the id is what keeps that string off the screen.
    currentUser$.next({ user_id: 'anonymous', name: 'Anonymous' });
    await render();

    expect(text('.rail-footer__name')).toBe('rail.anonymous');
    expect(text('.rail-footer__avatar')).toBe('A');
  });

  it('falls back when the user has no usable name at all', async () => {
    currentUser$.next({ user_id: 'u-2', name: '   ' });
    await render();
    expect(text('.rail-footer__name')).toBe('rail.anonymous');
  });

  // THE WAY BACK MOVED TO THE RAIL ITSELF and its assertions moved with it —
  // see console-rail.component.spec.ts ("the way back to the teams list"). Two
  // tests lived here: that the control is a real <button>, and that a
  // `hideHome` deployment does not get one. Both still hold; neither is this
  // component's responsibility any more. They are not deleted, they are
  // relocated, and the footer no longer injects ContextService at all.

  it('gives the account control an accessible name — the prototype ships an inert glyph', async () => {
    await render();
    const account = fixture.debugElement.query(By.css('.rail-footer__account'));
    expect(account).not.toBeNull();

    // Asserted on the shared button's INPUT rather than on the rendered
    // attribute: `label` is the contract this build depends on, and how the
    // shared component turns it into an accessible name is its own business.
    const button = fixture.debugElement.query(By.directive(IconButtonComponent));
    expect(button.componentInstance.label).toBe('rail.account');
  });

  it('builds a logout menu that calls AuthService.logout', async () => {
    await render();
    const items = component.buildMenuItems();

    expect(items.map((i) => i.id)).toEqual(['logout']);
    expect(items[0].label).toBe('chrome.logout');

    items[0].command!({});
    expect(authSpy.logout).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the menu model on every open, so a language switch cannot strand it', async () => {
    await render();
    // Clicked rather than called, so the popup aligns against a real element.
    const anchor = fixture.debugElement.query(By.css('.rail-footer__account'))
      .nativeElement as HTMLElement;
    anchor.click();
    const first = component.menuItems;

    anchor.click();
    expect(component.menuItems).not.toBe(first);
  });
});
