import { TestBed } from '@angular/core/testing';

import { ContextService } from '../../../core/context/context.service';
import { HttpError } from '../../../core/http/fetch.service';
import {
  MetadataFieldDescriptor,
  NamespaceSummary,
  TeamMetadataContract,
} from '../../../protocol/catalog.interface';
import { TeamCreationService } from './team-creation.service';

/**
 * A `NamespaceSummary` fixture carrying neutral values for every field these
 * specs do not exercise.
 *
 * `teamMetadata` is deliberately three-valued. OMITTING the argument leaves the
 * `team_metadata` KEY OFF the object entirely — the shape a server predating
 * the field sends. Passing `null` sets the key to `null`. Both mean "asks
 * nothing", and the two are distinct fixtures precisely because a gate written
 * as `=== null` passes one and fails the other.
 */
function nsSummary(
  namespace: string,
  name: string,
  teamMetadata?: TeamMetadataContract | null,
): NamespaceSummary {
  const summary: NamespaceSummary = {
    namespace,
    name,
    description: 'd',
    team: false,
    shareable: false,
    public: false,
    owner: null,
    counts: {},
  };
  if (teamMetadata !== undefined) {
    summary.team_metadata = teamMetadata;
  }
  return summary;
}

function field(
  key: string,
  overrides: Partial<MetadataFieldDescriptor> = {},
): MetadataFieldDescriptor {
  return { key, description: '', index: false, mandatory: false, ...overrides };
}

function contract(fields: MetadataFieldDescriptor[]): TeamMetadataContract {
  return { type: 'acme.contracts.CaseMetadata', fields };
}

/** A promise a spec releases by hand, so "while it is in flight" is observable. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve: () => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The creation gate, tested WITHOUT MOUNTING A PAGE.
 *
 * The whole bed is the gate and a `ContextService` spy (AC13). No component is
 * created, and no `Router`, `ActivatedRoute`, `ApiService`, `AuthService` or
 * `ConfigService` is provided — so an injection added to the gate turns every
 * spec in this file red at `TestBed.inject`, immediately and loudly. That is
 * the property being pinned: the decision "must creating this team ask
 * something first?" is answerable without a page, a route or a fetch.
 */
describe('TeamCreationService', () => {
  const asking = contract([field('tenant', { mandatory: true })]);

  let contextSpy: jasmine.SpyObj<ContextService>;
  let gate: TeamCreationService;

  beforeEach(() => {
    contextSpy = jasmine.createSpyObj<ContextService>('ContextService', [
      'createTeamAndNavigate',
    ]);
    contextSpy.createTeamAndNavigate.and.returnValue(Promise.resolve());

    TestBed.configureTestingModule({
      providers: [
        TeamCreationService,
        { provide: ContextService, useValue: contextSpy },
      ],
    });
    gate = TestBed.inject(TeamCreationService);
  });

  it('(AC13) is reachable with no component, no router and no route', () => {
    // The bed above is the assertion. Written out so the intent survives a
    // future reader who is tempted to "just add" an injection: the moment the
    // gate needs anything else, this file stops compiling its bed.
    expect(gate).toBeInstanceOf(TeamCreationService);
    expect(gate.modalVisible).toBeFalse();
    expect(gate.contract).toBeNull();
    expect(gate.creatingByGesture).toBeFalse();
  });

  // --- AC2: the three no-ask states, each pinned separately ---

  describe('contractOf (AC2)', () => {
    it('returns the declared contract when the namespace asks for a field', () => {
      expect(gate.contractOf(nsSummary('acme-cases', 'Acme Cases', asking))).toBe(asking);
    });

    it('an ABSENT team_metadata key asks nothing', () => {
      const ns = nsSummary('agent-team-v1', 'Agent Team');
      expect('team_metadata' in ns).toBeFalse();
      expect(gate.contractOf(ns)).toBeNull();
    });

    it('a null team_metadata asks nothing', () => {
      expect(gate.contractOf(nsSummary('agent-team-v1', 'Agent Team', null))).toBeNull();
    });

    it('a declared contract with an empty fields list asks nothing', () => {
      // The state a `=== null` gate lets through: a contract object IS present,
      // and it asks for nothing at all.
      expect(gate.contractOf(nsSummary('agent-team-v1', 'Agent Team', contract([]))))
        .toBeNull();
    });
  });

  // --- AC3 / AC4 / AC5: the one decision, for both origins ---

  it('(AC3) a gesture on a namespace that asks nothing creates, with no metadata payload', async () => {
    const outcome = await gate.request(nsSummary('agent-team-v1', 'Agent Team'), 'gesture');

    expect(outcome).toBe('created');
    // The two-argument form, second `undefined` — the request the app issues
    // is byte-identical to the one it issued before the extraction.
    expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
      'agent-team-v1',
      undefined,
    ]);
    expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args.length).toBe(2);
    expect(gate.modalVisible).toBeFalse();
  });

  it('(AC4) a gesture on a namespace that asks opens the dialog and creates nothing', async () => {
    const outcome = await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');

    expect(outcome).toBe('asked');
    expect(gate.modalVisible).toBeTrue();
    expect(gate.contract).toBe(asking);
    expect(gate.namespaceLabel).toBe('Acme Cases');
    expect(gate.errorMessage).toBeNull();
    expect(gate.submitting).toBeFalse();
    expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
  });

  it('(AC4) the dialog header falls back to the namespace when the name is empty', async () => {
    await gate.request(nsSummary('acme-cases', '', asking), 'gesture');

    expect(gate.namespaceLabel).toBe('acme-cases');
  });

  it('(AC5) the GESTURE-LESS route gates exactly as the button does', async () => {
    // The spec that goes red when the auto-create route stops asking. A
    // mandatory field going unanswered here is invisible: nobody pressed
    // anything, so nobody is waiting for a dialog that never came.
    const outcome = await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'auto');

    expect(outcome).toBe('asked');
    expect(gate.modalVisible).toBeTrue();
    expect(gate.contract).toBe(asking);
    expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
  });

  it('(AC5) the gesture-less route still creates when nothing is asked', async () => {
    const outcome = await gate.request(nsSummary('agent-team-v1', 'Agent Team'), 'auto');

    expect(outcome).toBe('created');
    expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
      'agent-team-v1',
      undefined,
    ]);
    expect(gate.modalVisible).toBeFalse();
  });

  // --- AC6: the spinner belongs to the button, and only to the button ---

  describe('creatingByGesture (AC6)', () => {
    it('is TRUE while an ungated GESTURE create is in flight, and false once it settles', async () => {
      const post = deferred();
      contextSpy.createTeamAndNavigate.and.returnValue(post.promise);

      const inFlight = gate.request(nsSummary('agent-team-v1', 'Agent Team'), 'gesture');
      // The only spec in the suite that pins this flag TRUE. Without it the
      // `= true` could be deleted and the Create button would simply never
      // spin, with every other assertion still green.
      expect(gate.creatingByGesture).toBeTrue();

      post.resolve();
      await inFlight;

      expect(gate.creatingByGesture).toBeFalse();
    });

    it('is FALSE at every point of an AUTO create', async () => {
      const post = deferred();
      contextSpy.createTeamAndNavigate.and.returnValue(post.promise);

      const inFlight = gate.request(nsSummary('agent-team-v1', 'Agent Team'), 'auto');
      // Nobody pressed the button. A spinner on a control nobody touched is a
      // lie, and this is the assertion that keeps the two call sites different.
      expect(gate.creatingByGesture).toBeFalse();

      post.resolve();
      await inFlight;

      expect(gate.creatingByGesture).toBeFalse();
    });

    it('is FALSE for a GATED request of either origin — a dialog is not a POST', async () => {
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      expect(gate.creatingByGesture).toBeFalse();

      gate.cancel();

      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'auto');
      expect(gate.creatingByGesture).toBeFalse();
    });
  });

  // --- AC7: an ungated create that rejects ---

  it('(AC7) an ungated create that rejects resolves failed, is logged once, and re-arms the button', async () => {
    const consoleErrorSpy = spyOn(console, 'error');
    contextSpy.createTeamAndNavigate.and.returnValue(
      Promise.reject(new HttpError('Server error', 500, 'boom')),
    );

    const outcome = await gate.request(nsSummary('agent-team-v1', 'Agent Team'), 'gesture');

    expect(outcome).toBe('failed');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(gate.creatingByGesture).toBeFalse();
    expect(gate.modalVisible).toBeFalse();
  });

  it('(AC7) the gesture-less route absorbs its rejection too, rather than escaping into ngOnInit', async () => {
    const consoleErrorSpy = spyOn(console, 'error');
    contextSpy.createTeamAndNavigate.and.returnValue(
      Promise.reject(new HttpError('Server error', 500, 'boom')),
    );

    await expectAsync(
      gate.request(nsSummary('agent-team-v1', 'Agent Team'), 'auto'),
    ).toBeResolvedTo('failed');
    // Asserted on THIS origin as well as on the gesture, because this is the
    // unwatched path: nobody pressed anything, so a second log or a spinner
    // left turning on a control nobody touched would surface to no one.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(gate.creatingByGesture).toBeFalse();
  });

  // --- AC8 / AC11 / AC12: confirm and cancel ---

  describe('confirm (AC8, AC11)', () => {
    it('creates with the emitted map, forwarded VERBATIM, and closes on success', async () => {
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      contextSpy.createTeamAndNavigate.calls.reset();

      await gate.confirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args).toEqual([
        'acme-cases',
        { tenant: 'acme' },
      ]);
      expect(gate.modalVisible).toBeFalse();
      expect(gate.contract).toBeNull();
      expect(gate.namespaceLabel).toBe('');
      expect(gate.creatingByGesture).toBeFalse();
    });

    it('uses the namespace CAPTURED at open time, not the last one asked about', async () => {
      // The dropdown stays live behind the dialog, so the page can ask the gate
      // about a DIFFERENT namespace while it is open — that is what a second
      // Create click on a changed selection is. The capture must survive it:
      // the user answered for `acme-cases` and the header said so.
      //
      // This is structural, not careful. The gate holds no reference to the
      // page's selection at all — it cannot read a live value even if it tried.
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      expect(gate.namespaceLabel).toBe('Acme Cases');

      await gate.request(nsSummary('other-ns', 'Other'), 'gesture');
      contextSpy.createTeamAndNavigate.calls.reset();

      await gate.confirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate.calls.mostRecent().args[0]).toBe('acme-cases');
    });

    it('(AC11) a rejected confirm leaves the typed values alone and clears submitting', async () => {
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(new HttpError('Unprocessable', 422, 'nope')),
      );

      await gate.confirm({ tenant: 'acme' });

      expect(gate.modalVisible).toBeTrue();
      expect(gate.contract).toBe(asking);
      expect(gate.namespaceLabel).toBe('Acme Cases');
      expect(gate.submitting).toBeFalse();
    });

    it('(AC11) submitting is TRUE while the confirmed create is in flight', async () => {
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      const post = deferred();
      contextSpy.createTeamAndNavigate.and.returnValue(post.promise);

      const inFlight = gate.confirm({ tenant: 'acme' });
      expect(gate.submitting).toBeTrue();
      // And the BUTTON still does not spin — a dialog confirm is not a gesture
      // on the Create control.
      expect(gate.creatingByGesture).toBeFalse();

      post.resolve();
      await inFlight;

      expect(gate.submitting).toBeFalse();
    });
  });

  describe('cancel and the pending guard (AC12)', () => {
    it('cancel closes the dialog, clears the capture and creates nothing', async () => {
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      contextSpy.createTeamAndNavigate.calls.reset();

      gate.cancel();

      expect(gate.modalVisible).toBeFalse();
      expect(gate.contract).toBeNull();
      expect(gate.namespaceLabel).toBe('');
      expect(gate.errorMessage).toBeNull();
      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
      expect(gate.creatingByGesture).toBeFalse();
    });

    it('a confirm with nothing pending creates nothing — before any request', async () => {
      await gate.confirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });

    it('a confirm with nothing pending creates nothing — after a cancel', async () => {
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      gate.cancel();
      contextSpy.createTeamAndNavigate.calls.reset();

      await gate.confirm({ tenant: 'acme' });

      expect(contextSpy.createTeamAndNavigate).not.toHaveBeenCalled();
    });
  });

  // --- AC9 / AC10: what a rejected confirm renders ---

  describe('the rejected confirm keeps the dialog open (AC9, AC10)', () => {
    /** Open the dialog, then make the confirmed create reject with `error`. */
    async function openThenFail(error: unknown): Promise<void> {
      await gate.request(nsSummary('acme-cases', 'Acme Cases', asking), 'gesture');
      contextSpy.createTeamAndNavigate.and.returnValue(Promise.reject(error));
      await gate.confirm({ tenant: 'acme' });
    }

    it('(AC9) a FastAPI detail list renders one line per entry, naming the field', async () => {
      await openThenFail(
        new HttpError('Unprocessable', 422, {
          detail: [
            { loc: ['body', 'metadata', 'tenant'], msg: 'field required' },
            { loc: ['body', 'metadata', 'case'], msg: 'not a valid integer' },
          ],
        }),
      );

      expect(gate.modalVisible).toBeTrue();
      expect(gate.errorMessage).toBe('tenant: field required\ncase: not a valid integer');
      expect(gate.submitting).toBeFalse();
      expect(gate.creatingByGesture).toBeFalse();
    });

    it('(AC9) a bare string body renders verbatim', async () => {
      await openThenFail(new HttpError('Unprocessable', 422, 'tenant is required'));

      expect(gate.errorMessage).toBe('tenant is required');
    });

    it('(AC9) a { detail: "..." } envelope is unwrapped', async () => {
      await openThenFail(
        new HttpError('Unprocessable', 422, { detail: 'tenant is required' }),
      );

      expect(gate.errorMessage).toBe('tenant is required');
    });

    it('(AC9) an unknown shape falls back to the serialized body', async () => {
      await openThenFail(new HttpError('Unprocessable', 422, { oops: 1 }));

      expect(gate.errorMessage).toBe('{"oops":1}');
    });

    it('(AC9) a 422 with nothing to say renders no alert region at all', async () => {
      // `errorMessage` is rendered on `!== null`, so `''` would paint an empty
      // red box and announce an empty `role="alert"`. BOTH empty shapes are
      // pinned: FetchService hands an empty response body over as `''`, and an
      // empty FastAPI `detail` list extracts to `''` too.
      await openThenFail(new HttpError('Unprocessable', 422, ''));

      expect(gate.modalVisible).toBeTrue();
      expect(gate.errorMessage).toBeNull();

      contextSpy.createTeamAndNavigate.and.returnValue(
        Promise.reject(new HttpError('Unprocessable', 422, { detail: [] })),
      );
      await gate.confirm({ tenant: 'acme' });

      expect(gate.modalVisible).toBeTrue();
      expect(gate.errorMessage).toBeNull();
    });

    it('(AC10) a non-422 keeps the dialog open with no inline message and logs nothing', async () => {
      const consoleErrorSpy = spyOn(console, 'error');

      await openThenFail(new HttpError('Server error', 500, 'boom'));

      expect(gate.modalVisible).toBeTrue();
      expect(gate.errorMessage).toBeNull();
      // FetchService has ALREADY toasted the failure; a second channel would
      // double up — no inline message, no console noise.
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
