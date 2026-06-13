import {
  Component,
  ElementRef,
  inject,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges,
  ViewChild,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { FieldsetModule } from 'primeng/fieldset';
import { FloatLabelModule } from 'primeng/floatlabel';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { MentionModule } from 'angular-mentions';

import { BehaviorSubject, Observable } from 'rxjs';

import { CapitalizePipe } from '../../../shared/pipes/capitalise.pipe';
import { ApiService } from '../../../core/http/api.service';
import { UtilService } from '../../../core/ui/utils.service';
import { ContextService } from '../../../core/context/context.service';
import { ActorMessageService } from '../../../components/process/event/message.service';
import {
  SystemPromptRow,
  SystemPromptSelector,
} from '../../../services/system-prompt.selector';
import { CommandDescriptor } from '../../../protocol/message.types';

import { CopyButtonComponent } from '../../../shared/components/copy-button/copy-button.component';

/**
 * AkgentChatComponent - Displays chat messages with JSON-formatted arguments using Monaco Editor
 */

@Component({
  selector: 'app-akgent-chat',
  imports: [
    CommonModule,
    TableModule,
    CardModule,
    FieldsetModule,
    FormsModule,
    TextareaModule,
    FloatLabelModule,
    ButtonModule,
    ProgressSpinnerModule,
    MentionModule,
    CapitalizePipe,
    CopyButtonComponent,
  ],
  templateUrl: './akgent-chat.component.html',
  styleUrl: './akgent-chat.component.scss',
})
export class AkgentChatComponent implements OnInit, OnChanges {
  // The single trace scroll region (head system block + conversation). Auto
  // scroll-to-bottom targets this element so new messages stay in view.
  @ViewChild('traceScroll') traceScroll?: ElementRef<HTMLElement>;
  @Input() context$!: BehaviorSubject<any[]>;
  @Input() agentId!: string;
  @Input() agentName!: string;

  apiService: ApiService = inject(ApiService);
  utilService: UtilService = inject(UtilService);
  contextService: ContextService = inject(ContextService);
  messageService: ActorMessageService = inject(ActorMessageService);
  // ADR-004 §5b: component-scoped selector provided on ProcessComponent.providers
  // (Story 16-1) — resolves the same MessageLogService instance as this subtree.
  private systemPromptSelector: SystemPromptSelector = inject(
    SystemPromptSelector
  );
  private destroyRef = inject(DestroyRef);

  context: any[] = [];

  /**
   * ADR-004 §5b step 2 — the head system block, derived once from the unified
   * log by `SystemPromptSelector.latestSystemPrompt$`. Bound in the template via
   * the `async` pipe (OnPush-safe; self-unsubscribes). Latest-wins MVP: the
   * trace is a flat list, so this shows the most recent rendering. The selector
   * already does latest-wins, the FR2 fallback for pre-event teams, and the
   * `dynamic_ref → name` labelling — the component consumes `row.name` /
   * `row.content` directly and renders nothing for an empty array.
   */
  systemPrompt$!: Observable<SystemPromptRow[]>;

  /**
   * The agent-tabs dropdown REUSES this component across member selections (it
   * lives under `*ngIf="context$.length"`, which stays truthy when switching
   * between agents that both have context), so `ngOnInit` does NOT re-run on a
   * switch. Re-bind the head system block to the newly-selected agent here, or
   * it stays pinned to the first-opened agent. The initial bind is done in
   * `ngOnInit` (which also covers unit tests that set `agentId` directly), so
   * skip the first change to avoid binding twice.
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['agentId'] && !changes['agentId'].firstChange) {
      this.bindSystemPrompt();
    }
  }

  ngOnInit(): void {
    // Initial head system block for this panel's agent (ADR-004 §5b step 2).
    // Subsequent agent switches re-bind it in ngOnChanges — see above.
    this.bindSystemPrompt();

    // Subscribe to context$ for the selected agent.
    this.context$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((ctx) => {
      if (this.isLoading) {
        setTimeout(() => this.scroll(), 10);
      }
      this.isLoading = false;
      this.updateContext(ctx);
    });
  }

  /** Point `systemPrompt$` at the current `agentId`'s head system block. The
   *  async pipe in the template resubscribes to the new stream on reassignment. */
  private bindSystemPrompt(): void {
    this.systemPrompt$ = this.systemPromptSelector.latestSystemPrompt$(
      this.agentId
    );
  }

  /**
   * ADR-013 §3 / Epic 17 (ADR-014) — member chat target is unambiguous: this
   * panel's own agent. The `/` list is that agent's command descriptors, read
   * from `store.commands` by the panel's `agent_id` (`@Input() agentId`) and
   * mapped to dropdown items. Keying by `agent_id` (not the friendly name) is
   * the ADR-013 keying fix. Empty until a CommandsAnnouncedEvent arrives (AC-6).
   */
  get commandItems(): {
    name: string;
    description: string;
    args: CommandDescriptor['args'];
  }[] {
    const descriptors =
      this.messageService.commands.snapshot(this.agentId) ?? [];
    return descriptors
      // `_`-prefixed commands (e.g. `_expand_media_refs`) are internal, not
      // user-invocable — keep them out of the `/` dropdown.
      .filter((d) => !d.name.startsWith('_'))
      // `angular-mentions` renders a single flat list with no group headers, so
      // the best we can do is keep tool families adjacent: order by provenance
      // (`tool_card`) then command name. `.filter()` above returns a fresh
      // array, so sorting in place does not mutate the stored descriptors.
      .sort(
        (a, b) =>
          a.tool_card.localeCompare(b.tool_card) || a.name.localeCompare(b.name),
      )
      .map((d) => ({
        name: d.name,
        description: d.description,
        args: d.args,
      }));
  }

  /**
   * ADR-013 §2 — single `/` mention trigger for the member chat. Inserts
   * `/${name} ` via `selectCommand`; `allowSpace: false` closes the dropdown
   * after the command name so the user types args freely. The send path is
   * unchanged — text is sent verbatim (AC-5).
   */
  get mentionConfig() {
    return {
      mentions: [
        {
          triggerChar: '/',
          labelKey: 'name',
          allowSpace: false,
          mentionSelect: this.selectCommand,
          dropUp: true,
          maxItems: 10,
          // `angular-mentions` re-sorts every list by `labelKey` (here `name`)
          // unless told not to — that would clobber the tool-family ordering
          // `commandItems` builds. Opt out so our `tool_card`-then-name order
          // survives to the dropdown.
          disableSort: true,
          items: this.commandItems,
        },
      ],
    };
  }

  /**
   * ADR-013 §2 — insert `/${name} ` (leading slash + trailing space); does NOT
   * send. The literal text is sent verbatim on submit (AC-5).
   */
  selectCommand = (item: { name: string }) => {
    return `/${item.name} `;
  };

  /**
   * ADR-013 §2 — args hint for a command row, e.g. `<role> [name]`: required
   * in angle brackets, optional in square brackets, declared order.
   */
  commandArgsHint(args: CommandDescriptor['args']): string {
    return args
      .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
      .join(' ');
  }

  updateContext(context: any[]) {
    if (!context || context.length === 0) {
      this.context = [];
      return;
    }

    // First pass: collect all messages
    const allMessages = context.flatMap((message: any) => {
      const msg: any[] = [];

      // Handle new parts-based protocol
      if (message.parts && Array.isArray(message.parts)) {
        message.parts.forEach((part: any) => {
          // ADR-004 §5b step 3 — the `system-prompt` arm is intentionally gone:
          // the head system block is the SINGLE source (via systemPrompt$), so
          // the run-1 double-carry renders once. Only `user-prompt` is handled
          // here now; the system label/`dynamic_ref` logic moved to the selector.
          if (part.part_kind === 'user-prompt') {
            msg.push({
              type: 'human',
              name: 'User',
              content: part.content,
              timestamp: part.timestamp,
            });
          } else if (part.part_kind === 'tool-call') {
            // Parse args if it's a string
            let args = part.args;
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args);
              } catch (e) {
                // Keep as string if parsing fails
              }
            }

            msg.push({
              type: 'tool_call',
              name: part.tool_name,
              args: args,
              tool_call_id: part.tool_call_id,
              timestamp: part.timestamp,
              result: null, // Will be filled later
            });
          } else if (
            part.part_kind === 'tool-return' ||
            part.part_kind === 'retry-prompt'
          ) {
            msg.push({
              type: 'tool_return_data',
              content: part.content,
              tool_call_id: part.tool_call_id,
              timestamp: part.timestamp,
            });
          } else if (part.part_kind === 'text' && part.content) {
            // Handle AI text responses (including structured outputs)
            msg.push({
              type: 'ai',
              name: 'Assistant',
              content: part.content,
              timestamp: part.timestamp || message.timestamp,
              usage: message.usage,
              model_name: message.model_name,
              provider_name: message.provider_name,
            });
          }
        });
      }
      // Handle response-type messages (AI responses)
      else if (
        message.kind === 'response' &&
        message.parts &&
        Array.isArray(message.parts)
      ) {
        message.parts.forEach((part: any) => {
          if (part.part_kind === 'tool-call') {
            // Parse args if it's a string
            let args = part.args;
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args);
              } catch (e) {
                // Keep as string if parsing fails
              }
            }

            msg.push({
              type: 'tool_call',
              name: part.tool_name,
              args: args,
              tool_call_id: part.tool_call_id,
              timestamp: part.timestamp || message.timestamp,
              result: null, // Will be filled later
            });
          } else if (part.content) {
            // Regular AI response content
            msg.push({
              type: 'ai',
              name: 'Assistant',
              content: part.content,
              timestamp: part.timestamp || message.timestamp,
              usage: message.usage,
              model_name: message.model_name,
              provider_name: message.provider_name,
            });
          }
        });
      } else {
        // Handle legacy format for backward compatibility
        if (
          ['system', 'ai', 'human'].includes(message.type) &&
          message.content
        ) {
          msg.push({
            type: message.type,
            name: message.name,
            content: message.content,
          });
        }
        if (message.tool_calls?.length) {
          msg.push(
            ...message.tool_calls.map((tool_call: any) => ({
              type: 'tool_call',
              name: tool_call.name,
              args: tool_call.args,
              result:
                context.find((m: any) => m.tool_call_id === tool_call.id)
                  ?.content || null,
            }))
          );
        }
      }
      return msg;
    });

    // Second pass: match tool calls with their results
    allMessages.forEach((message: any) => {
      if (message.type === 'tool_call' && message.result === null) {
        const toolReturn = allMessages.find(
          (m: any) =>
            m.type === 'tool_return_data' &&
            m.tool_call_id === message.tool_call_id
        );
        if (toolReturn) {
          message.result = toolReturn.content;
        }
      }
    });

    // Filter out tool_return_data as they're now merged with tool_call messages
    this.context = allMessages.filter(
      (message: any) => message.type !== 'tool_return_data'
    );

    setTimeout(() => this.scroll(), 0);
    this.initialLoad = false;
  }

  userInput = '';
  isLoading = false;
  async sendMessage() {
    if (!this.contextService.currentTeamRunning$.value) return;
    this.isLoading = true;
    const processId = this.contextService.currentProcessId$.value;
    try {
      await this.apiService.sendMessage(
        processId,
        this.userInput,
        this.agentName
      );
    } catch (error) {
      this.isLoading = false;
    }
    this.userInput = '';
  }

  initialLoad = true;
  isMouseOverTable: boolean = false; // Track mouse hover state
  scroll(behavior: ScrollBehavior = 'smooth') {
    const el = this.traceScroll?.nativeElement;
    if (el && !this.isMouseOverTable && !this.initialLoad) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }
}
