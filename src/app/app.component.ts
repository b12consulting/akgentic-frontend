import { Component, DestroyRef, inject, ViewChild } from '@angular/core';
import { Router, RouterModule, RouterOutlet } from '@angular/router';

import { CommonModule } from '@angular/common';
import { MenuItem } from 'primeng/api';
import { MenubarModule } from 'primeng/menubar';
import { TagModule } from 'primeng/tag';
import { Toast, ToastModule } from 'primeng/toast';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Subject, takeUntil } from 'rxjs';
import { emptyableCombineLatest } from './shared/util/util';
import { AkgentService } from './core/ui/akgent.service';
import { ApiService } from './core/http/api.service';
import { AuthService } from './core/auth/auth.service';
import { ConfigService } from './core/config/config.service';
import { ContextService } from './core/context/context.service';
import { FaviconService } from './core/config/favicon.service';
import { NotificationToastService } from './core/ui/notification-toast.service';
import { ViewService } from './core/ui/view.service';
import {
  TeamMetadataPipe,
  trackMetadataEntry,
} from './core/context/team-metadata.pipe';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterModule,
    MenubarModule,
    ToastModule,
    TagModule,
    CommonModule,
    TeamMetadataPipe,
    TranslatePipe,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  /** `trackBy` for the header's metadata chips. See the pipe. */
  trackMetadataEntry = trackMetadataEntry;

  title = 'akgent-app';
  items: MenuItem[] | undefined;
  private configService = inject(ConfigService);
  logo: string = '';
  hideLogin: boolean = true;

  akgentService: AkgentService = inject(AkgentService);
  authService: AuthService = inject(AuthService);
  contextService: ContextService = inject(ContextService);
  viewService: ViewService = inject(ViewService);
  destroyRef = inject(DestroyRef);
  faviconService = inject(FaviconService);
  apiService = inject(ApiService);
  router = inject(Router);
  private translate = inject(TranslateService);

  /**
   * Story 31-5: the app's one and only toast container. Handed to
   * `NotificationToastService` so a `ClosedNotification` arriving over the wire
   * can remove the toast it dismisses — see that service for why PrimeNG leaves
   * no other route to a single-toast removal.
   */
  @ViewChild(Toast) private toast?: Toast;
  private notificationToast = inject(NotificationToastService);

  ngAfterViewInit() {
    this.notificationToast.register(this.toast ?? null);
    this.destroyRef.onDestroy(() => this.notificationToast.register(null));
  }

  ngOnInit() {
    this.logo = this.configService.logo;
    this.hideLogin = this.configService.hideLogin;
    this.faviconService.setFavicon(this.configService.favicon);

    // Fetch the authenticated user from the backend session
    this.authService.checkAuth().subscribe();
    const destroyed = new Subject();

    this.destroyRef.onDestroy(() => {
      destroyed.next(null);
      destroyed.complete();
    });

    emptyableCombineLatest([
      this.contextService.currentProcessId$.asObservable(),
      this.authService.currentUser$,
      this.viewService.isRightColumnCollapsed$,
    ])
      .pipe(takeUntil(destroyed))
      .subscribe(([processId, currentUser, isRightColumnCollapsed]) => {
        this.menuInputs = { processId, currentUser, isRightColumnCollapsed };
        this.items = this.buildMenu();
      });

    // PrimeNG's menubar takes resolved strings, not keys, so the menu is built
    // with `instant()` — which means it is a SNAPSHOT of one language. Rebuild
    // it when the language moves, or a switch after boot leaves the whole
    // navigation in the previous one while the rest of the page changes.
    this.translate.onLangChange.pipe(takeUntil(destroyed)).subscribe(() => {
      if (this.menuInputs) {
        this.items = this.buildMenu();
      }
    });
  }

  /** The last values the menu was built from, so a language change can rebuild it. */
  private menuInputs: {
    processId: string;
    currentUser: { name?: string } | null;
    isRightColumnCollapsed: boolean;
  } | null = null;

  /**
   * The menubar's items for the current inputs and the current language.
   *
   * `id` carries the identity, `label` only the words. The Home entry used to be
   * hidden by comparing `item.label != 'Home'` — a filter that reads the COPY to
   * decide what a control is, and therefore one that stops hiding anything the
   * first time Home is translated. Nothing here matches on a rendered string.
   */
  private buildMenu(): MenuItem[] {
    const { processId, currentUser, isRightColumnCollapsed } = this.menuInputs!;
    return [
      {
        id: 'home',
        icon: 'pi pi-home',
        label: this.translate.instant('chrome.home'),
        route: ['/'],
        // Epic 52 (trap T3): NO `currentProcessId$.next('')` here.
        // `ProcessComponent` is the single owner of that subject and retracts
        // its own value on destroy, which this navigation causes. Writing it
        // from here too was harmless only while leaving the process view was
        // always a route change; now that the view can be HOSTED on the page
        // being navigated to, a write from here blanks the header's team name
        // while that team is still on screen.
        //
        // Epic 56 branched before 52 and carried the old `command` forward into
        // this refactor, so it is removed again here rather than at the merge
        // by accident.
      },
      {
        id: 'clear',
        icon: 'pi pi-eraser',
        label: this.translate.instant('chrome.clear'),
        command: () => {
          this.clear();
        },
        disabled: processId === '',
      },
      {
        id: 'details',
        icon: isRightColumnCollapsed ? 'pi pi-arrow-left' : 'pi pi-arrow-right',
        label: this.translate.instant(
          isRightColumnCollapsed ? 'chrome.showDetails' : 'chrome.hideDetails',
        ),
        command: () => {
          this.viewService.toggleRightColumn();
        },
        visible: processId !== '',
      },
      // Username dropdown menu at end (only when authenticated). The user's own
      // name is NOT translated — it is not copy.
      ...(currentUser && currentUser.name
        ? [
            {
              id: 'user',
              label: currentUser.name,
              icon: 'pi pi-user',
              styleClass: 'username-menu',
              items: [
                {
                  id: 'logout',
                  label: this.translate.instant('chrome.logout'),
                  icon: 'pi pi-power-off',
                  command: () => {
                    this.authService.logout();
                  },
                },
              ],
            },
          ]
        : []),
    ].filter((item) => (this.configService.hideHome ? item.id !== 'home' : true));
  }

  // Clear the current process and create a new one of the same type
  async clear() {
    const processId = this.contextService.currentProcessId$.value;
    this.contextService.clear(processId);
  }

  /**
   * Story 31-4: record a dismissed notification toast on the team's event
   * stream, so it stays dismissed across reloads.
   *
   * This handler lives on `AppComponent` and not in `IngestionService` because
   * the close hook only exists on the `<p-toast>` element: PrimeNG's
   * `MessageService` has no close observer, and `app.component.html` mounts the
   * app's only toast. Everything `showNotificationToast` put in `data` is
   * re-emitted verbatim by `Toast.onMessageClose`, which is the only reason the
   * ids survive to here.
   *
   * Every other toast in the app (disconnect, errors, save confirmations)
   * carries no `data.messageId` and must issue no POST at all — hence the early
   * return rather than a best-effort fallback to the current route's team.
   *
   * The POST is fire-and-forget with a terminal `.catch`: the handler is a
   * `void` DOM callback so it cannot `await`, and a failure here is already
   * surfaced by `FetchService`'s own error toast. Logging a second time is the
   * whole error policy — see the story's route table for the 400/404/409 cases.
   */
  onToastClose(event: {
    message?: { data?: { messageId?: string; teamId?: string } };
  }): void {
    const data = event?.message?.data;
    const messageId = data?.messageId;
    const teamId = data?.teamId;
    if (!messageId || !teamId) return;

    this.apiService
      .emitClosedNotification(teamId, messageId)
      .catch((err: unknown) => {
        console.error('Failed to record notification dismissal:', err);
      });
  }

  // Navigate to the home page, as the user left it.
  //
  // Epic 52 (trap T3): the `currentProcessId$.next('')` that used to open this
  // method is gone, for the reason recorded on the Home menu item above — the
  // teams list can now be hosting the open team, and "as the user left it"
  // includes it.
  navigateToHome() {
    // Through the service, so the teams list comes back filtered as the user
    // left it. A bare `navigate(['/'])` lands on an unfiltered list, because
    // the home page's filter, page and open team live in its query string.
    void this.contextService.navigateHome();
  }
}
