import { TestBed } from '@angular/core/testing';
import { MessageService } from 'primeng/api';

import { ConnectionToast } from './connection-toast';

/**
 * The MINIMAL provider set is itself an assertion (Epic 34 / ADR-025 §1, AC9):
 * `ConnectionToast` depends on PrimeNG's `MessageService` and on NOTHING else.
 * No `IngestionService`, no WebSocket, no `ApiService`, no `MessageLogService`,
 * no `PerAgentStoreRegistry`, no `ProcessStores` — the whole disconnect-warning
 * concern specs with no transport and no log harness at all. That reduction in
 * setup is the point of the extraction (FR10); if this unit ever grows a
 * dependency, every test in this file fails at `TestBed.inject` with
 * `NullInjectorError`, which is the intended alarm and not a nuisance.
 *
 * It also proves the unit is an independent injectable rather than a helper of
 * the class it was carved out of: nothing here can resolve through
 * `IngestionService`, because `IngestionService` is not in the injector.
 */
function setup(): { unit: ConnectionToast; add: jasmine.Spy; clear: jasmine.Spy } {
  const add = jasmine.createSpy('add');
  const clear = jasmine.createSpy('clear');
  TestBed.configureTestingModule({
    providers: [
      ConnectionToast,
      { provide: MessageService, useValue: { add, clear } },
    ],
  });
  return { unit: TestBed.inject(ConnectionToast), add, clear };
}

/** Every payload handed to `MessageService.add`. */
function payloads(add: jasmine.Spy): any[] {
  return add.calls.allArgs().map((args: any[]) => args[0]);
}

describe('ConnectionToast — the payload (AC2)', () => {
  it('passes exactly the five load-bearing properties', () => {
    const { unit, add } = setup();

    unit.show();

    // Deep equality on the WHOLE object, never `objectContaining`: two of this
    // payload's properties are defined by their ABSENCE (`life` defeats
    // `sticky`, and a `key` is dropped by the single keyless `<p-toast>`
    // mount), and a containment assertion cannot see an added property at all.
    expect(payloads(add)).toEqual([
      {
        severity: 'warn',
        summary: 'Connection Lost',
        detail:
          'Real-time connection to the server has been lost. Updates are paused.',
        sticky: true,
        closable: false,
      },
    ]);
  });

  it('AC2: `closable` is false and not merely falsy — this warning is undismissable', () => {
    const { unit, add } = setup();

    unit.show();

    // Spelled out separately from the equality above because this is the one
    // property that is the deliberate OPPOSITE of the notification toast, which
    // omits `closable` so PrimeNG renders its close cross. `undefined` here
    // would be that toast's semantics leaking into this one.
    expect(payloads(add)[0].closable).toBeFalse();
  });

  it('AC8: the unit never clears the toast container', () => {
    const { unit, add, clear } = setup();

    unit.start();
    unit.show();
    unit.stop();

    // `clear()` empties the whole keyless container, notification toasts
    // included, so it belongs to `IngestionService`'s lifecycle sequencing. A
    // `clear()` added here would silently wipe unrelated toasts on every
    // disconnect.
    expect(clear).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionToast — one toast, not two (AC3)', () => {
  it('AC3: two consecutive show() calls raise exactly ONE toast', () => {
    const { unit, add } = setup();

    // This is the `error`-then-`complete` sequence: a dropped socket ordinarily
    // fires BOTH handlers, so without the dedup flag every disconnect stacks
    // two identical undismissable warnings the user cannot get rid of.
    unit.show();
    unit.show();

    expect(add).toHaveBeenCalledTimes(1);
  });

  it('AC3: it stays one toast however many times the socket reports the loss', () => {
    const { unit, add } = setup();

    unit.show();
    unit.show();
    unit.show();
    unit.show();

    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionToast — teardown suppression (AC4)', () => {
  it('AC4: after stop(), show() is a no-op — navigation is not a connection loss', () => {
    const { unit, add } = setup();

    unit.stop();
    unit.show();

    // `ngOnDestroy` unsubscribes the socket, which completes it, which calls
    // `show()`. Without this suppression every deliberate navigation away from
    // a process view leaves a "Connection Lost" warning behind it.
    expect(add).not.toHaveBeenCalled();
  });

  it('AC4: the suppression outlives a start() — the destroying flag is one-way', () => {
    const { unit, add } = setup();

    unit.stop();
    // `start()` re-arms the DEDUP flag only. If it also cleared `destroying`,
    // the teardown suppression would evaporate the moment anything re-armed the
    // unit, and this call would toast.
    unit.start();
    unit.show();

    expect(add).not.toHaveBeenCalled();
  });

  it('AC4: a toast already raised before stop() is left alone', () => {
    const { unit, add, clear } = setup();

    unit.show();
    unit.stop();

    // Removing it is `IngestionService`'s `messageService.clear()`, not this
    // unit's business (AC8).
    expect(add).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('ConnectionToast — re-arming for a fresh cycle (AC5)', () => {
  it('AC5: start() clears the dedup flag, so a second team cycle toasts again', () => {
    const { unit, add } = setup();

    // Cycle 1: the team the user was on dropped its socket.
    unit.start();
    unit.show();
    expect(add).toHaveBeenCalledTimes(1);

    // Cycle 2 (team switch): a unit that never reset would sit permanently
    // silent for the rest of this component's life, and the user would watch a
    // dead socket with no warning at all. Nothing else in the suite notices,
    // because the absence of a toast fails nothing on its own.
    unit.start();
    unit.show();

    expect(add).toHaveBeenCalledTimes(2);
  });

  it('AC5: start() re-arms only ONE toast per cycle, not an unlimited supply', () => {
    const { unit, add } = setup();

    unit.start();
    unit.show();
    unit.show();
    unit.start();
    unit.show();
    unit.show();

    expect(add).toHaveBeenCalledTimes(2);
  });

  it('AC5: start() before any show() is harmless', () => {
    const { unit, add } = setup();

    unit.start();
    unit.start();

    expect(add).not.toHaveBeenCalled();
  });
});

describe('ConnectionToast — no self-wiring, the orchestrator drives it (AC5)', () => {
  it('AC5: construction alone touches the MessageService not at all', () => {
    const { add, clear } = setup();

    // Merely resolving the unit must raise nothing and remove nothing. A
    // constructor that toasted (or subscribed to anything of its own) would put
    // Angular's DI in charge of when the warning appears, and the explicit
    // start/show/stop sequencing `IngestionService` relies on would be a
    // fiction.
    expect(add).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('AC5: a constructed-but-never-started unit still toasts on the first show()', () => {
    const { unit, add } = setup();

    // `start()` ARMS a cycle; it is not a precondition. The two WS callbacks can
    // fire before anything called it (a socket that fails to open), and the
    // warning is exactly as necessary then.
    unit.show();

    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionToast — separate from the notification toast (AC9)', () => {
  it('AC9: it resolves from an injector holding only itself and a MessageService', () => {
    const { unit } = setup();

    // The provider list in `setup()` is the assertion: no `IngestionService`,
    // no `ApiService`, no `MessageLogService`, no registry. A unit that were
    // still a helper of the ingestion class could not stand up here at all.
    expect(unit).toBeInstanceOf(ConnectionToast);
  });

  it('AC9: the unit exposes start/show/stop and nothing that shapes another toast', () => {
    const { unit } = setup();

    // A guard against the reunification this story exists to prevent: the two
    // toast systems must not grow a shared payload builder, base class or
    // constant. This unit's whole surface is its three lifecycle calls.
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(unit),
    ).filter((name) => name !== 'constructor');

    expect(new Set(surface)).toEqual(new Set(['start', 'show', 'stop']));
  });
});

describe('ConnectionToast — component-scoped, never root-provided (AC1)', () => {
  it('is NOT reachable from an injector that does not provide it', () => {
    TestBed.resetTestingModule();
    // `MessageService` IS available here, so the injection can only fail on
    // `ConnectionToast` itself. Give the class `providedIn: 'root'` and this
    // injection SUCCEEDS instead — and one dedup flag, armed or spent, would
    // then be shared across every team the user visits, with a prior team's
    // disconnect silencing the next team's.
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MessageService,
          useValue: { add: jasmine.createSpy('add'), clear: jasmine.createSpy('clear') },
        },
      ],
    });

    expect(() => TestBed.inject(ConnectionToast)).toThrowError(/No provider/);
  });
});
