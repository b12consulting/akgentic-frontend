import { AsyncPipe, CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { AkgentService } from '../services/akgent.service';
import { ContextService } from '../services/context.service';
import { ActorMessageService } from '../services/message.service';

import { AgentTabsComponent } from './agent-tabs/agent-tabs.component';
import { TeamTabsComponent } from './team-tabs/team-tabs.component';
import { KnowledgeGraphComponent } from './knowledge-graph/knowledge-graph.component';
import { MessageListComponent } from './message-list/message-list.component';
import { WorkspaceExplorerComponent } from './workspace-explorer/workspace-explorer.component';

import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TabsModule } from 'primeng/tabs';
import { BehaviorSubject } from 'rxjs';
import { ChatComponent } from '../chat/chat.component';
import { ChatService } from '../services/chat.service';
import { FeedbackService } from '../services/feedback.service';
import { GraphDataService } from '../services/graph-data.service';
import { SelectionService } from '../services/selection.service';
import { ViewService } from '../view.service';

@Component({
  selector: 'app-process',
  imports: [
    CommonModule,
    MessageListComponent,
    AgentTabsComponent,
    TeamTabsComponent,
    KnowledgeGraphComponent,
    WorkspaceExplorerComponent,
    TabsModule,
    ButtonModule,
    ChatComponent,
    SelectButtonModule,
    FormsModule,
  ],
  providers: [
    AsyncPipe,
    ActorMessageService,
    GraphDataService,
    ChatService,
    SelectionService,
    FeedbackService,
  ],
  templateUrl: './process.component.html',
  styleUrl: './process.component.scss',
})
export class ProcessComponent {
  route: ActivatedRoute = inject(ActivatedRoute);
  router: Router = inject(Router);

  akgentService: AkgentService = inject(AkgentService);
  contextService: ContextService = inject(ContextService);
  messageService: ActorMessageService = inject(ActorMessageService);
  graphDataService: GraphDataService = inject(GraphDataService);
  viewService: ViewService = inject(ViewService);

  processId: string = '';
  processType: string = '';
  hasKnowledgeGraph: boolean = false;
  hasWorkspace: boolean = false;

  visualizationMode$ = new BehaviorSubject<string>('team');
  visualizationOptions: { label: string; value: string; icon: string }[] = [
    { label: 'Team', value: 'team', icon: 'pi pi-users' },
    { label: 'Member', value: 'member', icon: 'pi pi-user' },
    { label: 'Workspace', value: 'workspace', icon: 'pi pi-folder-open' },
    {
      label: 'Knowledge graph',
      value: 'knowledge-graph',
      icon: 'pi pi-sitemap',
    },
    { label: 'Messages', value: 'messages', icon: 'pi pi-envelope' },
  ];

  isRightColumnCollapsed$ =
    this.viewService.isRightColumnCollapsed$.asObservable();

  isLoading$ = this.graphDataService.isLoading$;

  async ngOnInit(): Promise<void> {
    this.processId = this.route.snapshot.params['id'];
    this.contextService.currentProcessId$.next(this.processId);

    const useCache = false;
    const currentProcess = await this.contextService.getCurrentProcess(
      this.processId,
      useCache
    );

    // Ensure we always have a visualization mode selected
    if (!this.visualizationMode$.value) {
      this.visualizationMode$.next('team');
    }

    if (currentProcess === null) {
      this.router.navigate(['/']);
      return;
    }

    this.processType = currentProcess.name;
    // Manage the tab for the Knowledge Graph and Workspace
    this.hasKnowledgeGraph = !!currentProcess.params.knowledge_graph;
    this.hasWorkspace = !!currentProcess.params.workspace;
    this.visualizationOptions = this.visualizationOptions.filter(
      (option) =>
        (option.value !== 'knowledge-graph' || this.hasKnowledgeGraph) &&
        (option.value !== 'workspace' || this.hasWorkspace)
    );

    await this.messageService.init(this.processId, currentProcess.running);
  }
  ngOnDestroy() {
    this.akgentService.unselect();
  }

  setVisualizationMode(mode: string): void {
    this.visualizationMode$.next(mode);
  }

  get currentVisualizationMode(): string {
    return this.visualizationMode$.value || 'team';
  }

  isHidden(mode: string): boolean {
    const currentMode = this.currentVisualizationMode;
    return currentMode !== mode;
  }
}
