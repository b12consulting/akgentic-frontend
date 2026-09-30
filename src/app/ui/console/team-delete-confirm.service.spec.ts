import { TestBed } from '@angular/core/testing';

import { ConfirmDialogService } from '../../core/components/primitives/confirm-dialog/confirm-dialog.service';
import { provideTranslateTesting, setTestTranslations } from '../../../testing/i18n-testing';
import { TeamDeleteConfirmService } from './team-delete-confirm.service';

describe('TeamDeleteConfirmService', () => {
  let service: TeamDeleteConfirmService;
  let dialog: ConfirmDialogService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateTesting()] });
    // Synthetic, not the shipped copy: the point is that the NAME is threaded.
    setTestTranslations({ team: { deleteConfirm: { message: '<<{{name}}>>' } } });
    service = TestBed.inject(TeamDeleteConfirmService);
    dialog = TestBed.inject(ConfirmDialogService);
  });

  afterEach(() => dialog.settle(false));

  it('asks the one delete question, naming the team, in the danger tone', () => {
    void service.ask('Research Crew');
    const request = dialog.current()!.request;

    expect(request.header).toBe('team.deleteConfirm.title');
    expect(request.message).toBe('<<Research Crew>>');
    expect(request.confirmLabel).toBe('team.deleteConfirm.confirm');
    expect(request.cancelLabel).toBe('common.cancel');
    expect(request.tone).toBe('danger');
  });

  it('resolves with the dialog answer', async () => {
    const yes = service.ask('A');
    dialog.settle(true);
    expect(await yes).toBeTrue();

    const no = service.ask('B');
    dialog.settle(false);
    expect(await no).toBeFalse();
  });
});
