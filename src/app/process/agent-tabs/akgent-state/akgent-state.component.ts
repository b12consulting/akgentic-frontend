import { Component, inject, Input, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import {
  FormArray,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';

import { BehaviorSubject } from 'rxjs';

import { ButtonModule } from 'primeng/button';
import { TextareaModule } from 'primeng/textarea';

import { environment } from '../../../../environments/environment';
import { ApiService } from '../../../services/api.service';
import { AkgentService } from '../../../services/akgent.service';
import { ActorMessageService } from '../../../services/message.service';
import { FetchService } from '../../../services/fetch.service';

@Component({
  selector: 'app-akgent-state',
  imports: [CommonModule, ReactiveFormsModule, TextareaModule, ButtonModule],
  templateUrl: './akgent-state.component.html',
  styleUrl: './akgent-state.component.scss',
})
export class AkgentStateComponent {
  @Input() state$!: BehaviorSubject<any>;
  @Input() agentId!: string;

  akgentService: AkgentService = inject(AkgentService);
  apiService: ApiService = inject(ApiService);
  messageService: ActorMessageService = inject(ActorMessageService);
  fetchService: FetchService = inject(FetchService);
  formBuider: FormBuilder = inject(FormBuilder);
  private destroyRef = inject(DestroyRef);

  schemaFields!: any[];
  dynamicForm!: FormGroup;

  ngOnInit(): void {
    this.state$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((data) => {
      if (this.akgentService.isSavingState[this.agentId]) {
        this.fetchService.showNotification('State saved successfully');
      }
      this.akgentService.isSavingState[this.agentId] = false;
      this.dynamicForm = this.formBuider.group({});
      this.generateForm(data);
    });
  }

  generateForm(data: any): void {
    if (!data) return;
    const schema = data.schema || {};

    this.schemaFields = Object.keys(schema.properties).map((key) => {
      const field = schema.properties[key];
      const isRequired = schema.required?.includes(key) || false;

      const defaultValue =
        field.type === 'array'
          ? JSON.stringify(data?.state?.[key] || '', null, 4)
          : data?.state?.[key] || '';

      const disabled =
        field.type === 'array'
          ? true
          : field.readOnly || field.readonly || false;

      const control = this.formBuider.control(
        {
          value: defaultValue,
          disabled: disabled,
        },
        [...(isRequired ? [Validators.required] : [])]
      );

      this.dynamicForm.addControl(key, control);

      return {
        name: key,
        label: this.mapKeysToUserFriendlyNames(
          field.description || field.title || key
        ),
        type:
          field.type || field.anyOf?.find((f: any) => f.type != 'null')?.type,
        controls:
          field.type === 'array'
            ? (this.dynamicForm.get(key) as FormArray).controls
            : null,
      };
    });
  }

  mapKeysToUserFriendlyNames(key: string): string {
    if (environment.production) {
      if (key === 'Backstory') {
        return 'Objectives';
      } else if (key === 'Support Ticket') {
        return 'Tasks';
      } else {
        return key;
      }
    }
    return key;
  }

  addArrayItem(fieldName: string): void {
    const arrayControl = this.dynamicForm.get(fieldName) as FormArray;
    arrayControl.push(this.formBuider.control(''));
  }

  removeArrayItem(fieldName: string, index: number): void {
    const arrayControl = this.dynamicForm.get(fieldName) as FormArray;
    arrayControl.removeAt(index);
  }

  onSubmit(): void {
    this.akgentService.isSavingState[this.agentId] = true;
    const dirtValues = this.getDirtyValues(this.dynamicForm);
    const currentProcessId =
      this.akgentService.contextService.currentProcessId$.value;

    this.apiService.updateAkgentState(
      currentProcessId,
      this.agentId,
      dirtValues
    );
  }

  getDirtyValues(form: FormGroup | FormArray): any {
    const dirtyValues: any = {};
    Object.keys(form.controls).forEach((key) => {
      const currentControl = form.get(key);
      if (currentControl?.dirty) {
        const recursiveCall =
          currentControl instanceof FormGroup ||
          currentControl instanceof FormArray;
        dirtyValues[key] = recursiveCall
          ? this.getDirtyValues(currentControl)
          : currentControl.value;
      }
    });
    return dirtyValues;
  }
}
