import { Component, inject, ViewChildren, QueryList, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

import { ApiService } from '../services/api.service';
import { ProcessContextArray } from '../models/process.interface';

import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';

import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { ContextService } from '../services/context.service';
import { TeamsService } from '../services/teams.service';
import { ConfigEditorComponent } from './config-editor/config-editor.component';

@Component({
  selector: 'app-home',
  imports: [
    FormsModule,
    TableModule,
    SelectModule,
    ButtonModule,
    TagModule,
    CommonModule,
    ConfigEditorComponent,
    DialogModule,
    InputTextModule,
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  apiService: ApiService = inject(ApiService);
  contextService: ContextService = inject(ContextService);
  router: Router = inject(Router);
  teamsService: TeamsService = inject(TeamsService);
  authService: AuthService = inject(AuthService);

  processTypes$ = new BehaviorSubject<string[]>([]);
  processType$ = new BehaviorSubject<string>('');
  isCreatingProcess = false;
  isRefreshing = false;
  archivingProcesses = new Set<string>();
  restoringProcesses = new Set<string>();
  editingDescriptionFor: string | null = null;
  descriptionDrafts = new Map<string, string>();

  @ViewChildren('descriptionInput') descriptionInputs!: QueryList<ElementRef>;

  configs$ = new BehaviorSubject<string[]>([]);
  config$ = new BehaviorSubject<string>('');
  context: ProcessContextArray = [];

  async ngOnInit() {
    this.processType$.subscribe(async (processType) => {
      if (!processType) {
        console.warn('No process type selected, skipping config load.');
        return;
      }
      const config_list = await this.apiService.getConfig(processType, false);
      this.configs$.next(config_list);
      this.config$.next(config_list[0] || '');
    });

    this.teamsService
      .getTeamConfigs()
      .subscribe((teams) => this.processTypes$.next(Object.keys(teams)));
    // Load the current context.
    this.context = await this.contextService.getContext();
    // Get last process type from the list.
    this.processType$.next(this.processTypes$.value[0]);

    if (environment.hideHome) {
      this.processType$.next(environment.autoRedirectContext);
      // If no process exists, create one.
      if (!this.context || this.context.length === 0) {
        await this.contextService.createProcessAndNavigate(
          this.processType$.value
        );
      }
      // If a process exists, navigate to its process page.
      if (this.context && this.context.length > 0) {
        const processId = this.context[0].id;
        this.router.navigate(['/process', processId]);
      }
    }

    this.authService.checkAuth().subscribe();
  }

  async createProcess() {
    this.isCreatingProcess = true;
    try {
      await this.apiService.createProcess(
        this.processType$.value,
        this.config$.value
      );
      this.context = await this.contextService.getContext();
    } finally {
      this.isCreatingProcess = false;
    }
  }

  async deleteProcess(team_id: string) {
    await this.apiService.deleteProcess(team_id);
    this.context = await this.contextService.getContext();
  }

  async restoreProcess(team_id: string) {
    this.restoringProcesses.add(team_id);
    await this.apiService.restoreProcess(team_id);
    this.context = await this.contextService.getContext();
    this.restoringProcesses.delete(team_id);
  }

  isRestoring(team_id: string): boolean {
    return this.restoringProcesses.has(team_id);
  }

  async archiveProcess(team_id: string) {
    this.archivingProcesses.add(team_id);
    try {
      await this.apiService.archiveProcess(team_id);

      // Boucle de vérification pour s'assurer que le processus est bien archivé
      let attempts = 0;
      const maxAttempts = 5;
      let isStopped = false;

      while (attempts < maxAttempts && !isStopped) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.context = await this.contextService.getContext();
        const process = this.context.find((ctx: any) => ctx.id === team_id);
        if (process && !process.running) {
          isStopped = true;
        }
        attempts++;
      }

      if (!isStopped) {
        this.context = await this.contextService.getContext();
      }
    } finally {
      this.archivingProcesses.delete(team_id);
    }
  }

  isArchiving(team_id: string): boolean {
    return this.archivingProcesses.has(team_id);
  }

  async refreshContext() {
    this.isRefreshing = true;
    try {
      this.context = await this.contextService.getContext();
    } finally {
      this.isRefreshing = false;
    }
  }

  onRowSelect(event: any) {
    const actor_system_id = event.data.id;
    this.router.navigate(['/process', actor_system_id]);
  }

  handleConfigUpdate($event: any) {
    console.log('Config updated:', $event);
    this.processType$.next(this.processType$.value);
  }

  startEditDescription(teamId: string, currentDescription: string | null) {
    this.editingDescriptionFor = teamId;
    this.descriptionDrafts.set(teamId, currentDescription || '');

    // Focus the input field after the view updates
    setTimeout(() => {
      const input = this.descriptionInputs?.first?.nativeElement;
      if (input) {
        input.focus();
        input.select(); // Also select all text for easy replacement
      }
    }, 0);
  }

  cancelEditDescription() {
    this.editingDescriptionFor = null;
  }

  async saveDescription(teamId: string) {
    const description = this.descriptionDrafts.get(teamId) || null;
    const trimmed = description?.trim() || null;

    try {
      await this.apiService.updateTeamDescription(teamId, trimmed);

      // Update local context
      const team = this.context.find((ctx: any) => ctx.id === teamId);
      if (team) {
        team.description = trimmed;
      }

      this.editingDescriptionFor = null;
    } catch (error) {
      console.error('Failed to update description:', error);
    }
  }

  visible = false;
}
