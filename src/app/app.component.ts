import { Component, DestroyRef, inject, ViewChild } from '@angular/core';
import { Router, RouterModule, RouterOutlet } from '@angular/router';

import { CommonModule } from '@angular/common';
import { MenuItem } from 'primeng/api';
import { MenubarModule } from 'primeng/menubar';
import { TagModule } from 'primeng/tag';
import { Toast, ToastModule } from 'primeng/toast';
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

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterModule,
    MenubarModule,
    ToastModule,
    TagModule,
    CommonModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
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
      this.authService.isAdmin$,
    ])
      .pipe(takeUntil(destroyed))
      .subscribe(([processId, currentUser, isRightColumnCollapsed, isAdmin]) => {
        this.items = [
          {
            icon: 'pi pi-home',
            label: 'Home',
            route: ['/'],
            command: () => {
              this.contextService.currentProcessId$.next('');
            },
          },
          {
            icon: 'pi pi-eraser',
            label: 'Clear',
            command: () => {
              this.clear();
            },
            disabled: processId === '',
          },
          {
            icon: isRightColumnCollapsed
              ? 'pi pi-arrow-left'
              : 'pi pi-arrow-right',
            label: isRightColumnCollapsed ? 'Show details' : 'Hide details',
            command: () => {
              this.viewService.toggleRightColumn();
            },
            visible: processId !== '',
          },
          ...this.adminMenuItems(isAdmin),
          // Username dropdown menu at end (only when authenticated)
          ...(currentUser && currentUser.name
            ? [
                {
                  label: currentUser.name,
                  icon: 'pi pi-user',
                  styleClass: 'username-menu',
                  items: [
                    {
                      label: 'Logout',
                      icon: 'pi pi-power-off',
                      command: () => {
                        this.authService.logout();
                      },
                    },
                  ],
                },
              ]
            : []),
        ].filter((item) =>
          this.configService.hideHome ? item.label != 'Home' : true,
        );
      });
  }

  /**
   * The admin area's single menubar entry (Story 36-1).
   *
   * ONE entry, ONE target — the label and icon are the only things the caller's
   * role changes. An admin lands on the same `/admin/catalog` route as everyone
   * else; the panes beyond it are what differ, and `adminGuard` handles that.
   *
   * `route` (not PrimeNG's own `routerLink`) is what carries the target: the
   * `#item` template in `app.component.html` overrides PrimeNG's rendering and
   * binds `[routerLink]="item.route"`, so an entry using `routerLink` renders
   * an inert link.
   *
   * The `hideHome` suppression is applied HERE, by not producing the entry at
   * all, rather than in the `.filter(...)` below: that filter matches the
   * literal label `'Home'`, which an entry labelled `Admin`/`Catalog` sails
   * straight through. A deployment that hides the home page hides this too.
   */
  private adminMenuItems(isAdmin: boolean): MenuItem[] {
    if (this.configService.hideHome) return [];
    return [
      {
        icon: isAdmin ? 'pi pi-cog' : 'pi pi-list',
        label: isAdmin ? 'Admin' : 'Catalog',
        route: ['/admin/catalog'],
      },
    ];
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

  // Navigate to home page and clear current process context
  navigateToHome() {
    this.contextService.currentProcessId$.next('');
    this.router.navigate(['/']);
  }
}
