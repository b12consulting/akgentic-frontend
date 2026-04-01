import { Component, DestroyRef, inject } from '@angular/core';
import { Router, RouterModule, RouterOutlet } from '@angular/router';

import { CommonModule } from '@angular/common';
import { MenuItem } from 'primeng/api';
import { MenubarModule } from 'primeng/menubar';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { Subject, takeUntil } from 'rxjs';
import { environment } from '../environments/environment';
import { emptyableCombineLatest } from './lib/util';
import { AkgentService } from './services/akgent.service';
import { ApiService } from './services/api.service';
import { AuthService } from './services/auth.service';
import { ContextService } from './services/context.service';
import { FaviconService } from './services/favicon.service';
import { ViewService } from './view.service';

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
  logo: string = environment.logo;
  hideLogin: boolean = environment.hideLogin;
  processType: string = '';
  processConfigName: string = '';
  processRunning: boolean = false;

  akgentService: AkgentService = inject(AkgentService);
  authService: AuthService = inject(AuthService);
  contextService: ContextService = inject(ContextService);
  viewService: ViewService = inject(ViewService);
  destroyRef = inject(DestroyRef);
  faviconService = inject(FaviconService);
  apiService = inject(ApiService);
  router = inject(Router);

  ngOnInit() {
    this.faviconService.setFavicon(environment.favicon);
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
      .subscribe(async ([processId, currentUser, isRightColumnCollapsed]) => {
        // Update process type when process changes
        if (processId) {
          try {
            const process =
              await this.contextService.getCurrentProcess(processId);
            this.processType = process?.name || '';
            this.processConfigName = process?.config_name || '';
            this.processRunning = process?.running || false;
          } catch (error) {
            console.error('Error fetching process:', error);
            this.processType = '';
            this.processRunning = false;
          }
        } else {
          this.processType = '';
          this.processRunning = false;
        }

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
          environment.hideHome ? item.label != 'Home' : true,
        );
      });
  }

  // Clear the current process and create a new one of the same type
  async clear() {
    const processId = this.contextService.currentProcessId$.value;
    this.contextService.clear(processId);
  }

  // Navigate to home page and clear current process context
  navigateToHome() {
    this.contextService.currentProcessId$.next('');
    this.router.navigate(['/']);
  }
}
