import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { TabsModule } from 'primeng/tabs';
import { GraphComponent } from './graph/graph.component';
import { TreeComponent } from './tree/tree.component';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-team-tabs',
  standalone: true,
  imports: [CommonModule, TabsModule, GraphComponent, TreeComponent, TranslatePipe],
  templateUrl: './team-tabs.component.html',
  styleUrl: './team-tabs.component.scss',
})
export class TeamTabsComponent {}
