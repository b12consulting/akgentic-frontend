import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import {
  KGStateReducer,
  KnowledgeGraphData,
  KnowledgeGraphEntity,
  KnowledgeGraphRelation,
} from './kg-state.reducer';

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------

function makeEntity(
  id: string,
  name: string,
  entity_type = 'Concept',
  description = '',
  observations: any[] = []
): KnowledgeGraphEntity {
  return { id, name, entity_type, description, observations };
}

function makeRelation(
  id: string,
  from_entity: string,
  to_entity: string,
  relation_type = 'relates_to',
  description = ''
): KnowledgeGraphRelation {
  return { id, from_entity, to_entity, relation_type, description };
}

interface KgEventOptions {
  tool_id: string;
  seq: number;
  entities_added?: KnowledgeGraphEntity[];
  entities_modified?: KnowledgeGraphEntity[];
  entities_removed?: string[];
  relations_added?: KnowledgeGraphRelation[];
  relations_modified?: KnowledgeGraphRelation[];
  relations_removed?: string[];
  payload_model?: string;
}

function makeKgEvent(opts: KgEventOptions): any {
  return {
    __model__: 'akgentic.tool.messages.ToolStateEvent',
    tool_id: opts.tool_id,
    seq: opts.seq,
    payload: {
      __model__:
        opts.payload_model ?? 'akgentic.tool.messages.KnowledgeGraphStateEvent',
      entities_added: opts.entities_added ?? [],
      entities_modified: opts.entities_modified ?? [],
      entities_removed: opts.entities_removed ?? [],
      relations_added: opts.relations_added ?? [],
      relations_modified: opts.relations_modified ?? [],
      relations_removed: opts.relations_removed ?? [],
    },
  };
}

describe('KGStateReducer', () => {
  let reducer: KGStateReducer;
  let emissions: KnowledgeGraphData[];

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [KGStateReducer] });
    reducer = TestBed.inject(KGStateReducer);
    emissions = [];
    reducer.knowledgeGraph$.subscribe((p) => emissions.push(p));
  });

  it('(1) empty init — emits {nodes:[], edges:[]} before any apply', () => {
    // The BehaviorSubject replays its initial value on subscribe.
    expect(emissions.length).toBe(1);
    expect(emissions[0]).toEqual({ nodes: [], edges: [] });
  });

  it('(2) single-add — apply emits projection with the added entity', () => {
    const e1 = makeEntity('e1', 'A');
    reducer.apply(makeKgEvent({ tool_id: 't1', seq: 1, entities_added: [e1] }));

    const proj = emissions[emissions.length - 1];
    expect(proj.nodes.length).toBe(1);
    expect(proj.nodes[0].id).toBe('e1');
    expect(proj.nodes[0].name).toBe('A');
    expect(proj.edges).toEqual([]);
  });

  it('(3) modify replaces by id, not by name (rename reflected, no dup)', () => {
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e1', 'A')],
      })
    );
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 2,
        entities_modified: [makeEntity('e1', 'B')],
      })
    );

    const proj = emissions[emissions.length - 1];
    expect(proj.nodes.length).toBe(1);
    expect(proj.nodes[0].id).toBe('e1');
    expect(proj.nodes[0].name).toBe('B');
  });

  it('(4) relation add + cascade delete — both drop in one reducer tick', () => {
    // Seed entities A, C and relation r1 (A→C).
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e1', 'A'), makeEntity('e3', 'C')],
        relations_added: [makeRelation('r1', 'A', 'C')],
      })
    );
    // Cascade: remove entity e1 AND relation r1 in the same event.
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 2,
        entities_removed: ['e1'],
        relations_removed: ['r1'],
      })
    );

    const proj = emissions[emissions.length - 1];
    expect(proj.nodes.length).toBe(1);
    expect(proj.nodes[0].id).toBe('e3');
    expect(proj.edges).toEqual([]);
  });

  it('(5) relations_modified forward-compat path — modify replaces by id', () => {
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        relations_added: [makeRelation('r1', 'A', 'B', 'old', '')],
      })
    );
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 2,
        relations_modified: [makeRelation('r1', 'A', 'B', 'updated', 'new')],
      })
    );

    const proj = emissions[emissions.length - 1];
    expect(proj.edges.length).toBe(1);
    expect(proj.edges[0].id).toBe('r1');
    expect(proj.edges[0].relation_type).toBe('updated');
    expect(proj.edges[0].description).toBe('new');
  });

  it('(6) empty-collections event — seq advances, projection emitted, no console output', () => {
    const warnSpy = spyOn(console, 'warn');
    const debugSpy = spyOn(console, 'debug');
    const logSpy = spyOn(console, 'log');

    const before = emissions.length;
    reducer.apply(makeKgEvent({ tool_id: 't1', seq: 1 }));
    const after = emissions.length;

    expect(after).toBe(before + 1);
    const proj = emissions[after - 1];
    expect(proj).toEqual({ nodes: [], edges: [] });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('(7) seq-gap log — 1 then 3 warns once with prev/event/tool_id', () => {
    const warnSpy = spyOn(console, 'warn');

    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e1', 'A')],
      })
    );
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 3,
        entities_added: [makeEntity('e2', 'B')],
      })
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.calls.first().args;
    expect(args[0]).toContain('seq gap');
    expect(args[1]).toEqual({ prev_seq: 1, event_seq: 3, tool_id: 't1' });

    // Both events applied — projection must reflect seq=3.
    const proj = emissions[emissions.length - 1];
    expect(proj.nodes.length).toBe(2);
  });

  it('(8) unknown payload __model__ — debug logged, no mutation, no new emission', () => {
    const debugSpy = spyOn(console, 'debug');
    const warnSpy = spyOn(console, 'warn');
    const before = emissions.length;

    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        payload_model: 'akgentic.tool.messages.VectorStoreStateEvent',
      })
    );

    expect(debugSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(emissions.length).toBe(before);
    expect(emissions[emissions.length - 1]).toEqual({ nodes: [], edges: [] });
  });

  it('(9) immutable projection — two successive applies yield distinct refs (NFR7)', () => {
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e1', 'A')],
      })
    );
    const proj1 = emissions[emissions.length - 1];
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 2,
        entities_added: [makeEntity('e2', 'B')],
      })
    );
    const proj2 = emissions[emissions.length - 1];

    expect(proj1).not.toBe(proj2);
    expect(proj1.nodes.length).toBe(1);
    expect(proj2.nodes.length).toBe(2);
  });

  it('(10) multiple tools isolated — deletes in one do not evict the other', () => {
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e1', 'A')],
      })
    );
    reducer.apply(
      makeKgEvent({
        tool_id: 't2',
        seq: 1,
        entities_added: [makeEntity('e2', 'B')],
      })
    );
    // Now delete e2 from t2 only — t1's e1 must survive.
    reducer.apply(
      makeKgEvent({
        tool_id: 't2',
        seq: 2,
        entities_removed: ['e2'],
      })
    );

    const proj = emissions[emissions.length - 1];
    expect(proj.nodes.length).toBe(1);
    expect(proj.nodes[0].id).toBe('e1');
  });

  it('(11) resetForTeam() clears state and emits empty projection', () => {
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e1', 'A')],
      })
    );
    expect(emissions[emissions.length - 1].nodes.length).toBe(1);

    reducer.resetForTeam();

    const proj = emissions[emissions.length - 1];
    expect(proj).toEqual({ nodes: [], edges: [] });

    // A fresh apply after reset starts from zero; seq gap from 1→1 must NOT
    // trigger a warning because the internal lastSeq was cleared.
    const warnSpy = spyOn(console, 'warn');
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e9', 'Z')],
      })
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(emissions[emissions.length - 1].nodes.length).toBe(1);
    expect(emissions[emissions.length - 1].nodes[0].id).toBe('e9');
  });

  it('(bonus) bind() pipes projections into an external subject', () => {
    const external = new BehaviorSubject<KnowledgeGraphData>({
      nodes: [],
      edges: [],
    });
    reducer.bind(external);
    reducer.apply(
      makeKgEvent({
        tool_id: 't1',
        seq: 1,
        entities_added: [makeEntity('e1', 'A')],
      })
    );
    expect(external.getValue().nodes.length).toBe(1);
  });
});
