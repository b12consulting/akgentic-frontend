import { Component, inject, ViewChildren, QueryList, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { BehaviorSubject, firstValueFrom } from 'rxjs';

import { ApiService } from '../services/api.service';
import { TeamContext, isRunning } from '../models/team.interface';
import { NamespaceSummary } from '../models/catalog.interface';

import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';

import { AuthService } from '../services/auth.service';
import { ConfigService } from '../services/config.service';
import { ContextService } from '../services/context.service';

@Component({
  selector: 'app-home',
  imports: [
    FormsModule,
    TableModule,
    SelectModule,
    ButtonModule,
    TagModule,
    CommonModule,
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
  authService: AuthService = inject(AuthService);
  private config = inject(ConfigService);

  // Catalog namespaces for the team creation dropdown
  namespaces$ = new BehaviorSubject<NamespaceSummary[]>([]);
  selectedNamespace$ = new BehaviorSubject<NamespaceSummary | null>(null);
  isCreatingTeam = false;
  isRefreshing = false;
  stoppingTeams = new Set<string>();
  restoringTeams = new Set<string>();
  editingDescriptionFor: string | null = null;
  descriptionDrafts = new Map<string, string>();

  @ViewChildren('descriptionInput') descriptionInputs!: QueryList<ElementRef>;

  // Expose isRunning to template
  isRunning = isRunning;

  async ngOnInit() {
    // Load catalog namespaces for the team creation dropdown.
    // The endpoint always returns a list (possibly empty); no defensive
    // branching needed for dict/array shape.
    try {
      const namespaces = await this.apiService.getNamespaces();
      this.namespaces$.next(namespaces);
      if (namespaces.length > 0) {
        this.selectedNamespace$.next(namespaces[0]);
      }
    } catch (error) {
      console.error('Failed to load namespaces:', error);
    }

    // Populate _context$; return value reused for the hideHome branch.
    const teams = await this.contextService.getTeams();

    if (this.config.hideHome) {
      // If no team exists, create one using the first namespace.
      if (!teams || teams.length === 0) {
        const selected = this.selectedNamespace$.value;
        if (selected) {
          await this.contextService.createTeamAndNavigate(selected.namespace);
        }
      }
      // If a team exists, navigate to its process page.
      if (teams && teams.length > 0) {
        const teamId = teams[0].team_id;
        this.router.navigate(['/process', teamId]);
      }
    }

    this.authService.checkAuth().subscribe();
  }

  async createTeam() {
    this.isCreatingTeam = true;
    try {
      const selected = this.selectedNamespace$.value;
      if (!selected) {
        console.warn('No namespace selected');
        return;
      }
      await this.apiService.createTeam(selected.namespace);
      await this.contextService.getTeams();
    } catch (error) {
      console.error('Failed to create team:', error);
    } finally {
      this.isCreatingTeam = false;
    }
  }

  async createTeamAndNavigate() {
    const selected = this.selectedNamespace$.value;
    if (!selected) {
      console.warn('No namespace selected');
      return;
    }
    await this.contextService.createTeamAndNavigate(selected.namespace);
  }

  async deleteTeam(teamId: string) {
    await this.contextService.deleteTeam(teamId);
  }

  async restoreTeam(teamId: string) {
    this.restoringTeams.add(teamId);
    try {
      await this.apiService.restoreTeam(teamId);
      await this.contextService.getTeams();
    } finally {
      this.restoringTeams.delete(teamId);
    }
  }

  isRestoring(teamId: string): boolean {
    return this.restoringTeams.has(teamId);
  }

  async stopTeam(teamId: string) {
    this.stoppingTeams.add(teamId);
    try {
      await this.contextService.stopTeamAndAwait(teamId);
    } catch (error) {
      console.error(`Failed to stop team ${teamId}:`, error);
    } finally {
      this.stoppingTeams.delete(teamId);
    }
  }

  isStopping(teamId: string): boolean {
    return this.stoppingTeams.has(teamId);
  }

  async refreshContext() {
    this.isRefreshing = true;
    try {
      await this.contextService.getTeams();
    } finally {
      this.isRefreshing = false;
    }
  }

  onRowSelect(event: any) {
    const teamId = event.data.team_id;
    this.router.navigate(['/process', teamId]);
  }

  startEditDescription(teamId: string, currentDescription: string | null) {
    this.editingDescriptionFor = teamId;
    this.descriptionDrafts.set(teamId, currentDescription || '');

    // Focus the input field after the view updates
    setTimeout(() => {
      const input = this.descriptionInputs?.first?.nativeElement;
      if (input) {
        input.focus();
        input.select();
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
      // Note: updateTeamDescription is a no-op in V2 (no equivalent endpoint).
      // Description changes will not persist. This is a known limitation.
      console.warn(
        'Description editing is not available in V2 -- changes will not persist.'
      );
      await this.apiService.updateTeamDescription(teamId, trimmed);

      // Update local context optimistically (read current list from teams$).
      const teams = await firstValueFrom(this.contextService.teams$);
      const team = teams.find((ctx: TeamContext) => ctx.team_id === teamId);
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
