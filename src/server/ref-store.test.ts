import { describe, it, expect, vi } from 'vitest';

import { RefStore } from './ref-store.js';
import type { A11yNodeTrimmed } from '../tools/types/discovery.js';

function createSessionManager() {
  let stored = new Map<string, string>();
  return {
    setRefMap: vi.fn((map: Map<string, string>) => {
      stored = map;
    }),
    getRefMap: vi.fn(() => stored),
  };
}

const node = (ref: string, name: string): A11yNodeTrimmed => ({
  ref,
  role: 'button',
  name,
  path: [],
});

describe('RefStore', () => {
  it('increments the generation on each begin()', () => {
    const store = new RefStore(createSessionManager());

    const first = store.begin();
    const second = store.begin();

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(store.generation).toBe(2);
  });

  it('forwards set() from the current handle to the session manager', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const map = new Map([['e1', 'role=button[name="Go"]']]);

    const handle = store.begin();

    expect(handle.isCurrent()).toBe(true);
    expect(handle.set(map)).toStrictEqual({ applied: true, refMap: map });
    expect(handle.toolSetRefs).toBe(true);
    expect(sessionManager.setRefMap).toHaveBeenCalledWith(map);
  });

  it('drops set() from a handle of an older generation', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);

    const stale = store.begin();
    store.begin();

    expect(stale.isCurrent()).toBe(false);
    expect(stale.set(new Map([['e1', 'old']])).applied).toBe(false);
    expect(stale.setObservation(new Map([['e1', 'old']]), []).applied).toBe(
      false,
    );
    expect(stale.toolSetRefs).toBe(false);
    expect(sessionManager.setRefMap).not.toHaveBeenCalled();
  });

  it('drops set() after the request signal aborts', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const controller = new AbortController();

    const handle = store.begin(controller.signal);
    controller.abort();

    expect(handle.isCurrent()).toBe(false);
    expect(handle.set(new Map([['e1', 'late']])).applied).toBe(false);
    expect(sessionManager.setRefMap).not.toHaveBeenCalled();
  });

  it('applies the observation map when the tool did not set refs', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const map = new Map([['e1', 'obs']]);

    const handle = store.begin();

    expect(handle.setObservation(map, [node('e1', 'Go')]).applied).toBe(true);
    expect(handle.toolSetRefs).toBe(false);
    expect(sessionManager.setRefMap).toHaveBeenCalledWith(map);
  });

  it('keeps the refs the tool set and adds the other observation refs', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const toolMap = new Map([
      ['e1', 'tool-send'],
      ['e2', 'tool-swap'],
    ]);

    const handle = store.begin();
    handle.set(toolMap, [node('e1', 'Send'), node('e2', 'Swap')]);
    // Banner is new; Send and Swap match the tool's tree.
    const written = handle.setObservation(
      new Map([
        ['e1', 'obs-banner'],
        ['e2', 'obs-send'],
        ['e3', 'obs-swap'],
      ]),
      [node('e1', 'Banner'), node('e2', 'Send'), node('e3', 'Swap')],
    );

    expect(written.applied).toBe(true);
    expect(written.nodes.map((each) => each.ref)).toStrictEqual([
      'e3',
      'e1',
      'e2',
    ]);
    // Tool entries win on conflict; the new ref is added.
    expect(sessionManager.getRefMap()).toStrictEqual(
      new Map([
        ['e1', 'tool-send'],
        ['e2', 'tool-swap'],
        ['e3', 'obs-banner'],
      ]),
    );
    // Every ref of the observation resolves.
    for (const each of written.nodes) {
      expect(sessionManager.getRefMap().has(each.ref)).toBe(true);
    }
    // The baseline is the observation nodes with the merged map.
    expect(store.baseline()).toStrictEqual({
      nodes: written.nodes,
      refMap: written.refMap,
    });
  });

  describe('toolSetRefs and toolSawScreen', () => {
    it('sets only toolSetRefs for a refs-only write', () => {
      const handle = new RefStore(createSessionManager()).begin();

      handle.set(new Map([['e1', 'tool']]));

      expect(handle.toolSetRefs).toBe(true);
      expect(handle.toolSawScreen).toBe(false);
    });

    it('sets both for a write with nodes, and keeps toolSawScreen after a later refs-only write', () => {
      const handle = new RefStore(createSessionManager()).begin();

      handle.set(new Map([['e1', 'go']]), [node('e1', 'Go')]);
      expect(handle.toolSawScreen).toBe(true);

      handle.set(new Map([['e1', 'tool']]));
      expect(handle.toolSetRefs).toBe(true);
      expect(handle.toolSawScreen).toBe(true);
    });

    it('sets neither when the write is dropped', () => {
      const store = new RefStore(createSessionManager());
      const stale = store.begin();
      store.begin();

      stale.set(new Map([['e1', 'go']]), [node('e1', 'Go')]);

      expect(stale.toolSetRefs).toBe(false);
      expect(stale.toolSawScreen).toBe(false);
    });
  });

  it('lets the tool map win when an observation ref collides with it', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const handle = store.begin();
    // A tool map without nodes: no baseline, so the observation is not
    // stabilized and its e1 collides with the tool's e1.
    handle.set(new Map([['e1', 'tool']]));

    handle.setObservation(
      new Map([
        ['e1', 'obs'],
        ['e2', 'obs2'],
      ]),
      [node('e1', 'A'), node('e2', 'B')],
    );

    expect(sessionManager.getRefMap().get('e1')).toBe('tool');
  });

  it('applies the observation map over tool refs when keepToolRefs is false', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const observationMap = new Map([['e1', 'obs']]);

    const handle = store.begin();
    handle.set(new Map([['e1', 'tool']]));

    const written = handle.setObservation(observationMap, [], {
      keepToolRefs: false,
    });

    expect(written.applied).toBe(true);
    // Not merged with the tool map. (e1 was used by the tool write, so the
    // observation's entry gets a fresh ref.)
    expect(sessionManager.getRefMap()).toStrictEqual(new Map([['e2', 'obs']]));
  });

  describe('baseline', () => {
    it('is null before any write', () => {
      expect(new RefStore(createSessionManager()).baseline()).toBeNull();
    });

    it('returns the nodes and map of the last write', () => {
      const store = new RefStore(createSessionManager());
      const nodes = [node('e1', 'Go')];
      const map = new Map([['e1', 'go']]);

      store.begin().set(map, nodes);

      expect(store.baseline()).toStrictEqual({ nodes, refMap: map });
    });

    it('is null when the last write had no nodes', () => {
      const store = new RefStore(createSessionManager());

      store.begin().set(new Map([['e1', 'go']]));

      expect(store.baseline()).toBeNull();
    });

    it('is null when the session manager map was replaced elsewhere', () => {
      const sessionManager = createSessionManager();
      const store = new RefStore(sessionManager);

      store.begin().set(new Map([['e1', 'go']]), [node('e1', 'Go')]);
      sessionManager.setRefMap(new Map([['e1', 'other']]));

      expect(store.baseline()).toBeNull();
    });

    it('is null when the session manager map has a different size', () => {
      const sessionManager = createSessionManager();
      const store = new RefStore(sessionManager);

      store.begin().set(new Map([['e1', 'go']]), [node('e1', 'Go')]);
      sessionManager.setRefMap(new Map());

      expect(store.baseline()).toBeNull();
    });

    it('is null when getRefMap throws (no session)', () => {
      const sessionManager = createSessionManager();
      const store = new RefStore(sessionManager);

      store.begin().set(new Map([['e1', 'go']]), [node('e1', 'Go')]);
      sessionManager.getRefMap.mockImplementation(() => {
        throw new Error('No active session');
      });

      expect(store.baseline()).toBeNull();
    });

    it('is cleared by resetBaseline()', () => {
      const store = new RefStore(createSessionManager());

      store.begin().set(new Map([['e1', 'go']]), [node('e1', 'Go')]);
      store.resetBaseline();

      expect(store.baseline()).toBeNull();
    });

    it('is not moved by a dropped write', () => {
      const store = new RefStore(createSessionManager());
      const nodes = [node('e1', 'Go')];
      const map = new Map([['e1', 'go']]);

      const stale = store.begin();
      store.begin().set(map, nodes);
      stale.set(new Map([['e1', 'late']]), [node('e1', 'Late')]);

      expect(store.baseline()).toStrictEqual({ nodes, refMap: map });
    });
  });

  describe('stable refs and the high-water mark', () => {
    const tree = (
      names: string[],
    ): { nodes: A11yNodeTrimmed[]; map: Map<string, string> } => ({
      nodes: names.map((name, index) => node(`e${index + 1}`, name)),
      map: new Map(names.map((name, index) => [`e${index + 1}`, name])),
    });
    const names = (count: number, prefix = 'B'): string[] =>
      Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

    it('never reuses a removed ref across three observations', () => {
      const store = new RefStore(createSessionManager());

      // 1: e1–e10.
      const first = tree(names(10));
      store.begin().setObservation(first.map, first.nodes);
      // 2: B8–B10 (e8–e10) are gone.
      const second = tree(names(7));
      const afterDrop = store.begin().setObservation(second.map, second.nodes);
      // 3: a new element appears after B7.
      const third = tree([...names(7), 'New']);
      const written = store.begin().setObservation(third.map, third.nodes);

      expect(afterDrop.nodes.map((each) => each.ref)).toStrictEqual(
        names(7).map((_, index) => `e${index + 1}`),
      );
      const fresh = written.nodes.find((each) => each.name === 'New');
      expect(fresh?.ref).toBe('e11');
      expect(written.refMap.get('e11')).toBe('New');
      expect(written.refMap.has('e8')).toBe(false);
      expect(store.highWater).toBe(11);
    });

    it('bumps the high-water mark on tool writes too', () => {
      const store = new RefStore(createSessionManager());

      store.begin().set(new Map([['e40', 'x']]));

      expect(store.highWater).toBe(40);
      // No baseline (no nodes), but fresh refs still start above 40.
      const written = store
        .begin()
        .setObservation(new Map([['e1', 'a']]), [node('e1', 'A')]);
      expect(written.nodes[0]?.ref).toBe('e41');
    });

    it('does not move the high-water mark on a dropped write', () => {
      const store = new RefStore(createSessionManager());
      const stale = store.begin();
      store.begin();

      stale.set(new Map([['e9', 'late']]));

      expect(store.highWater).toBe(0);
    });

    it('resetBaseline() restarts ref numbering', () => {
      const store = new RefStore(createSessionManager());
      const first = tree(names(5));
      store.begin().set(first.map, first.nodes);

      store.resetBaseline();
      const written = store
        .begin()
        .setObservation(new Map([['e1', 'a']]), [node('e1', 'A')]);

      expect(store.highWater).toBe(1);
      expect(written.nodes[0]?.ref).toBe('e1');
    });

    it('stabilizes tool writes with nodes against the baseline', () => {
      const store = new RefStore(createSessionManager());
      const first = tree(['Send', 'Swap']);
      store.begin().setObservation(first.map, first.nodes);

      const second = tree(['Banner', 'Send', 'Swap']);
      const written = store.begin().set(second.map, second.nodes);

      expect(written.nodes?.map((each) => [each.ref, each.name])).toStrictEqual(
        [
          ['e3', 'Banner'],
          ['e1', 'Send'],
          ['e2', 'Swap'],
        ],
      );
      expect(written.refMap).toStrictEqual(
        new Map([
          ['e3', 'Banner'],
          ['e1', 'Send'],
          ['e2', 'Swap'],
        ]),
      );
    });

    it('returns a tool write without nodes unchanged', () => {
      const store = new RefStore(createSessionManager());
      const first = tree(['Send']);
      store.begin().setObservation(first.map, first.nodes);
      const map = new Map([['e1', 'other']]);

      const written = store.begin().set(map);

      expect(written).toStrictEqual({ applied: true, refMap: map });
      expect(store.baseline()).toBeNull();
    });

    it('uses the key mode the store was created with', () => {
      const store = new RefStore(createSessionManager(), () => 'mobile');
      store
        .begin()
        .setObservation(new Map([['e1', 'id']]), [
          { ...node('e1', 'Unlock'), testId: 'unlock' },
        ]);

      // Mobile: same testId, new name → same ref.
      const written = store
        .begin()
        .setObservation(new Map([['e1', 'id']]), [
          { ...node('e1', 'Unlock, busy'), testId: 'unlock' },
        ]);

      expect(written.nodes[0]?.ref).toBe('e1');
    });
  });

  describe('baselineSignature', () => {
    it('is null without a valid baseline', () => {
      expect(
        new RefStore(createSessionManager()).baselineSignature(),
      ).toBeNull();
    });

    it('is computed once per baseline and ignores refs', () => {
      const store = new RefStore(createSessionManager());
      const nodes = [node('e1', 'Go')];
      store.begin().set(new Map([['e1', 'go']]), nodes);

      const first = store.baselineSignature();
      // A cached value: changing the stored nodes in place does not change
      // it.
      nodes.push(node('e2', 'Later'));

      expect(first).toBe(
        JSON.stringify([{ role: 'button', name: 'Go', path: [] }]),
      );
      expect(store.baselineSignature()).toBe(first);
    });
  });
});
