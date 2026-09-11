import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  ViewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MenuItem } from 'primeng/api';
import { Menu, MenuModule } from 'primeng/menu';
import { map, Observable } from 'rxjs';

import { AuthService } from '../../../core/auth/auth.service';
import { ConfigService } from '../../../core/config/config.service';
import { ContextService } from '../../../core/context/context.service';
import { IconButtonComponent } from '../../../shared/components/icon-button/icon-button.component';

/** What the footer needs to know about the signed-in user, and nothing else. */
export interface RailFooterUser {
  /** The name to print, or `null` when there is nobody to name. */
  readonly displayName: string | null;
  /** The avatar's single glyph. */
  readonly initial: string;
}

/**
 * The rail's account footer — where the deleted menubar's user menu went.
 *
 * A CIRCLE, not a rounded square. The transcript's agent avatar is a 9px-radius
 * SQUARE, and that shape difference is the entire human/agent distinction in
 * this design language; rounding one or squaring the other erases it. The warm
 * `--akg-avatar-human-bg` is the only warm tone in the palette and carries the
 * same single job.
 *
 * TWO THINGS THE PROTOTYPE SHOWS ARE NOT HERE.
 *
 * "Tenant · test", the second line under the name, is dropped: there is no
 * tenant on the user, on the config or on the team, and a grep for it across
 * `src` hits test fixtures only. Its place is taken by the way back to the
 * management view, which is where `chrome.home` went when the menubar was
 * deleted — a real destination rather than an invented field.
 *
 * The trailing gear is an inert `<svg>` in the prototype: no button, no hover,
 * no handler. A glyph that looks like a control and is not one is worse than no
 * glyph, so it is a real `<app-icon-button>` with an accessible name, opening
 * the logout menu.
 */
@Component({
  selector: 'app-rail-footer',
  imports: [AsyncPipe, MenuModule, TranslatePipe, IconButtonComponent],
  templateUrl: './rail-footer.component.html',
  styleUrl: './rail-footer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RailFooterComponent {
  private readonly authService = inject(AuthService);
  private readonly configService = inject(ConfigService);
  private readonly contextService = inject(ContextService);
  private readonly translate = inject(TranslateService);

  @ViewChild(Menu) private menu?: Menu;

  /** The account menu's model, rebuilt at every open. See `openMenu`. */
  menuItems: MenuItem[] = [];

  /**
   * The user, reduced to the two things this footer renders.
   *
   * `AuthService.currentUser$` is `Observable<any>`; the annotation on the
   * `map` callback is where that stops. Everything downstream — including the
   * template — sees `RailFooterUser`.
   *
   * The ANONYMOUS SENTINEL is matched on `user_id`, not on the name: the
   * service's placeholder name is the untranslated English string
   * `'Anonymous'`, and printing it would put bare copy on screen through the
   * back door. Matching the id lets the footer say `rail.anonymous` in the
   * user's own language instead.
   */
  readonly user$: Observable<RailFooterUser> = this.authService.currentUser$.pipe(
    map((user: { name?: string; user_id?: string } | null) => {
      const anonymous = !user || user.user_id === 'anonymous';
      const name = anonymous ? '' : (user?.name ?? '').trim();
      return {
        displayName: name === '' ? null : name,
        // `A` for anonymous — the same letter the placeholder name starts
        // with, so the avatar does not change shape when a name arrives late.
        initial: name === '' ? 'A' : name.charAt(0).toUpperCase(),
      };
    }),
  );

  /**
   * Whether the way back to the teams list is offered.
   *
   * `hideHome` deployments have no management view to go back to, and the
   * menubar's Home entry was filtered out on exactly this flag.
   */
  get showAllTeams(): boolean {
    return !this.configService.hideHome;
  }

  /** Back to the list as the user left it — filter, page and all. */
  goToAllTeams(): void {
    void this.contextService.navigateHome();
  }

  /**
   * Open the account menu, rebuilding its model first.
   *
   * `MenuItem.label` is a resolved string, so a model built once is a snapshot
   * of one language. Building at open keeps it in step with the language
   * switcher without an `onLangChange` subscription to leak.
   */
  openMenu(event: Event): void {
    this.menuItems = this.buildMenuItems();
    this.menu?.toggle(event);
  }

  /** The account menu's model. Separate from `openMenu` so it can be asserted
   *  without a PrimeNG overlay. */
  buildMenuItems(): MenuItem[] {
    return [
      {
        id: 'logout',
        label: this.translate.instant('chrome.logout'),
        icon: 'pi pi-power-off',
        command: () => this.authService.logout(),
      },
    ];
  }
}
