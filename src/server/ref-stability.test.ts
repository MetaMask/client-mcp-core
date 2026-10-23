import { describe, it, expect } from 'vitest';

import { maxRefIndex, refKey, stabilizeRefs } from './ref-stability.js';
import type { RefTree } from './ref-stability.js';
import type { A11yNodeTrimmed } from '../tools/types/discovery.js';

type Spec = [ref: string, role: string, name: string, testId?: string];

function tree(specs: Spec[]): RefTree {
  const nodes = specs.map(
    ([ref, role, name, testId]): A11yNodeTrimmed => ({
      ref,
      role,
      name,
      path: [],
      ...(testId ? { testId } : {}),
    }),
  );
  return {
    nodes,
    refMap: new Map(
      specs.map(([ref, role, name]) => [ref, `${role}:${name}`] as const),
    ),
  };
}

const refsOf = (result: RefTree): string[] =>
  result.nodes.map((node) => node.ref);

const targetOf = (result: RefTree, name: string): string | undefined => {
  const found = result.nodes.find((node) => node.name === name);
  return found ? result.refMap.get(found.ref) : undefined;
};

describe('refKey', () => {
  const button: A11yNodeTrimmed = {
    ref: 'e1',
    role: 'button',
    name: 'Go',
    path: [],
  };

  it('uses role, name and testId in browser mode', () => {
    expect(refKey(button, 'browser')).not.toBe(
      refKey({ ...button, testId: 'go' }, 'browser'),
    );
    expect(refKey(button, 'browser')).not.toBe(
      refKey({ ...button, name: 'Stop' }, 'browser'),
    );
  });

  it('uses the testId alone in mobile mode when present', () => {
    expect(refKey({ ...button, testId: 'go' }, 'mobile')).toBe(
      refKey({ ...button, name: 'Renamed', testId: 'go' }, 'mobile'),
    );
  });

  it('uses role and name in mobile mode without a testId', () => {
    expect(refKey(button, 'mobile')).toBe(
      refKey({ ...button, ref: 'e9' }, 'mobile'),
    );
    expect(refKey(button, 'mobile')).not.toBe(
      refKey({ ...button, role: 'text' }, 'mobile'),
    );
  });
});

describe('stabilizeRefs', () => {
  it('keeps refs when an element is inserted before existing ones', () => {
    const previous = tree([
      ['e1', 'button', 'Send'],
      ['e2', 'button', 'Swap'],
    ]);
    const next = tree([
      ['e1', 'dialog', 'Notice'],
      ['e2', 'button', 'Send'],
      ['e3', 'button', 'Swap'],
    ]);

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e3', 'e1', 'e2']);
    expect(result.refMap).toStrictEqual(
      new Map([
        ['e3', 'dialog:Notice'],
        ['e1', 'button:Send'],
        ['e2', 'button:Swap'],
      ]),
    );
  });

  it('keeps refs of remaining elements and never reuses a removed ref', () => {
    const previous = tree([
      ['e1', 'button', 'Send'],
      ['e2', 'button', 'Swap'],
      ['e3', 'button', 'Bridge'],
    ]);
    const next = tree([
      ['e1', 'button', 'Send'],
      ['e2', 'button', 'Bridge'],
      ['e3', 'button', 'Buy'],
    ]);

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e1', 'e3', 'e4']);
    expect(targetOf(result, 'Bridge')).toBe('button:Bridge');
    expect(targetOf(result, 'Buy')).toBe('button:Buy');
    expect(result.refMap.has('e2')).toBe(false);
  });

  it('gives a renamed element a fresh ref in browser mode', () => {
    const previous = tree([
      ['e1', 'button', 'Unlock'],
      ['e2', 'button', 'Help'],
    ]);
    const next = tree([
      ['e1', 'button', 'Unlocking…'],
      ['e2', 'button', 'Help'],
    ]);

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e3', 'e2']);
  });

  it('keeps the ref of a renamed element with the same testId in mobile mode', () => {
    const previous = tree([['e1', 'Button', 'Unlock', 'unlock-button']]);
    const next = tree([
      ['e1', 'Text', 'Welcome'],
      ['e2', 'Button', 'Unlocking…', 'unlock-button'],
    ]);

    const result = stabilizeRefs(previous, next, 'mobile');

    expect(refsOf(result)).toStrictEqual(['e2', 'e1']);
    expect(targetOf(result, 'Unlocking…')).toBe('Button:Unlocking…');
  });

  it('matches a key that appears more often in the new tree in screen order; extra ones get fresh refs', () => {
    const previous = tree([
      ['e1', 'button', 'Copy'],
      ['e2', 'button', 'Done'],
    ]);
    const next = tree([
      ['e1', 'button', 'Copy'],
      ['e2', 'button', 'Copy'],
      ['e3', 'button', 'Done'],
    ]);

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e1', 'e3', 'e2']);
  });

  it('matches a key that appeared more often in the previous tree in screen order', () => {
    const previous = tree([
      ['e1', 'button', 'Copy'],
      ['e2', 'button', 'Copy'],
    ]);
    const next = tree([['e1', 'button', 'Copy']]);

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e1']);
  });

  describe('same key: matched in screen order', () => {
    const containers = (count: number, start = 1): Spec[] =>
      Array.from(
        { length: count },
        (_, index): Spec => [`e${start + index}`, 'android.view.ViewGroup', ''],
      );

    it('keeps the refs of 20 identical unnamed containers when a unique node is inserted', () => {
      const previous = tree(containers(20));
      const next = tree([
        ['e1', 'android.widget.TextView', 'Banner'],
        ...containers(20, 2),
      ]);

      const result = stabilizeRefs(previous, next, 'mobile');

      expect(refsOf(result)).toStrictEqual([
        'e21',
        ...refsOf(previous).slice(0, 20),
      ]);
      expect(targetOf(result, 'Banner')).toBe('android.widget.TextView:Banner');
    });

    it('shifts only the tail of a duplicate run when a container is inserted in its middle', () => {
      // previous: Header, 5 containers (e2–e6), Footer.
      const previous = tree([
        ['e1', 'text', 'Header'],
        ...containers(5, 2),
        ['e7', 'text', 'Footer'],
      ]);
      // A container is inserted after the 2nd one.
      const next = tree([
        ['e1', 'text', 'Header'],
        ...containers(6, 2),
        ['e8', 'text', 'Footer'],
      ]);

      const result = stabilizeRefs(previous, next, 'mobile');

      // The first two containers and the unique nodes keep their refs. From
      // the inserted one on, each container takes its predecessor's ref and
      // the last one gets a fresh ref: acceptable for unnamed containers.
      expect(refsOf(result)).toStrictEqual([
        'e1',
        'e2',
        'e3',
        'e4',
        'e5',
        'e6',
        'e8',
        'e7',
      ]);
    });

    it('gives a fresh ref only to a node whose name changed (status bar clock)', () => {
      const previous = tree([
        ['e1', 'android.widget.TextView', '1:01 AM', 'clock'],
        ['e2', 'android.widget.FrameLayout', 'T-Mobile, no signal.'],
        ...containers(4, 3),
      ]);
      const next = tree([
        ['e1', 'android.widget.TextView', '1:02 AM', 'clock'],
        ['e2', 'android.widget.FrameLayout', 'T-Mobile, signal full.'],
        ...containers(4, 3),
      ]);

      const result = stabilizeRefs(previous, next, 'mobile');

      // The clock keeps its ref (same testId); the unnamed signal label is
      // keyed by role + name, so it gets a fresh ref. The containers keep
      // theirs.
      expect(refsOf(result)).toStrictEqual([
        'e1',
        'e7',
        'e3',
        'e4',
        'e5',
        'e6',
      ]);
    });

    it('never produces duplicate refs with mixed duplicate and unique keys', () => {
      const previous = tree([
        ['e1', 'button', 'Copy'],
        ['e2', 'button', 'Copy'],
        ['e3', 'button', 'Copy'],
        ['e4', 'button', 'Done'],
      ]);
      const next = tree([
        ['e1', 'button', 'Done'],
        ['e2', 'button', 'Copy'],
        ['e3', 'button', 'New'],
        ['e4', 'button', 'Copy'],
        ['e5', 'button', 'Copy'],
        ['e6', 'button', 'Copy'],
      ]);

      const result = stabilizeRefs(previous, next, 'browser', 10);
      const refs = refsOf(result);

      expect(refs).toStrictEqual(['e4', 'e1', 'e11', 'e2', 'e3', 'e12']);
      expect(new Set(refs).size).toBe(refs.length);
      expect([...result.refMap.keys()]).toStrictEqual(refs);
      expect(result.refMap.get('e12')).toBe('button:Copy');
    });
  });

  it('never produces duplicate refs', () => {
    const previous = tree([
      ['e1', 'button', 'A'],
      ['e2', 'button', 'B'],
      ['e3', 'button', 'C'],
    ]);
    const next = tree([
      ['e1', 'button', 'C'],
      ['e2', 'button', 'X'],
      ['e3', 'button', 'A'],
      ['e4', 'button', 'Y'],
      ['e5', 'button', 'B'],
    ]);

    const result = stabilizeRefs(previous, next, 'browser');
    const refs = refsOf(result);

    expect(new Set(refs).size).toBe(refs.length);
    expect(new Set(result.refMap.keys()).size).toBe(result.refMap.size);
    expect(refs).toStrictEqual(['e3', 'e4', 'e1', 'e5', 'e2']);
  });

  it('rewrites collapsed runs consistently and gives their members fresh refs', () => {
    const previous = tree([['e1', 'button', 'Send']]);
    const next: RefTree = {
      nodes: [
        { ref: 'e1', role: 'img', name: 'icon', path: [] },
        {
          ref: 'e1\u2013e3',
          role: 'img',
          name: '\u2026 2 more "icon" (refs e1\u2013e3)',
          path: [],
        },
        { ref: 'e4', role: 'button', name: 'Send', path: [] },
      ],
      refMap: new Map([
        ['e1', 'img1'],
        ['e2', 'img2'],
        ['e3', 'img3'],
        ['e4', 'button:Send'],
      ]),
    };

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e2', 'e2\u2013e4', 'e1']);
    expect(result.nodes[1].name).toBe('\u2026 2 more "icon" (refs e2\u2013e4)');
    expect(result.refMap).toStrictEqual(
      new Map([
        ['e2', 'img1'],
        ['e3', 'img2'],
        ['e4', 'img3'],
        ['e1', 'button:Send'],
      ]),
    );
  });

  it('does not match previous nodes inside a collapsed run', () => {
    const previous: RefTree = {
      nodes: [
        { ref: 'e1', role: 'img', name: 'icon', path: [] },
        { ref: 'e1\u2013e3', role: 'img', name: 'more', path: [] },
      ],
      refMap: new Map([
        ['e1', 'a'],
        ['e2', 'b'],
        ['e3', 'c'],
      ]),
    };
    const next = tree([['e1', 'img', 'icon']]);

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e4']);
  });

  it('gives fresh refs to refMap entries without a node', () => {
    const previous = tree([['e1', 'button', 'Send']]);
    const next: RefTree = {
      nodes: [{ ref: 'e1', role: 'button', name: 'Send', path: [] }],
      refMap: new Map([
        ['e1', 'button:Send'],
        ['e2', 'hidden'],
      ]),
    };

    const result = stabilizeRefs(previous, next, 'browser');

    expect(result.refMap).toStrictEqual(
      new Map([
        ['e1', 'button:Send'],
        ['e2', 'hidden'],
      ]),
    );
  });

  it('leaves refs that are not eN untouched', () => {
    const previous = tree([['e1', 'button', 'Send']]);
    const next: RefTree = {
      nodes: [{ ref: 'custom', role: 'button', name: 'Send', path: [] }],
      refMap: new Map([['custom', 'x']]),
    };

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['custom']);
    expect(result.refMap).toStrictEqual(new Map([['custom', 'x']]));
  });

  it('does not change the inputs', () => {
    const previous = tree([['e1', 'button', 'Send']]);
    const next = tree([
      ['e1', 'button', 'New'],
      ['e2', 'button', 'Send'],
    ]);

    stabilizeRefs(previous, next, 'browser');

    expect(refsOf(next)).toStrictEqual(['e1', 'e2']);
    expect([...next.refMap.keys()]).toStrictEqual(['e1', 'e2']);
  });

  it('gives options fresh contiguous refs so option ranges stay valid', () => {
    const previous = tree([
      ['e1', 'combobox', 'Language'],
      ['e2', 'option', 'English'],
      ['e3', 'option', 'French'],
    ]);
    const next = tree([
      ['e1', 'combobox', 'Language'],
      ['e2', 'option', 'German'],
      ['e3', 'option', 'English'],
      ['e4', 'option', 'French'],
    ]);

    const result = stabilizeRefs(previous, next, 'browser');

    expect(refsOf(result)).toStrictEqual(['e1', 'e4', 'e5', 'e6']);
  });

  it('starts fresh refs above the floor', () => {
    const previous = tree([['e1', 'button', 'Send']]);
    const next = tree([
      ['e1', 'button', 'Send'],
      ['e2', 'button', 'New'],
    ]);

    const result = stabilizeRefs(previous, next, 'browser', 10);

    expect(refsOf(result)).toStrictEqual(['e1', 'e11']);
  });

  it('ignores a floor below the previous maximum', () => {
    const previous = tree([['e5', 'button', 'Send']]);
    const next = tree([['e1', 'button', 'New']]);

    expect(refsOf(stabilizeRefs(previous, next, 'browser', 2))).toStrictEqual([
      'e6',
    ]);
  });
});

describe('maxRefIndex', () => {
  it('reads nodes, ranges and map keys', () => {
    expect(
      maxRefIndex({
        nodes: [
          { ref: 'e2', role: 'img', name: '', path: [] },
          { ref: 'e3\u2013e7', role: 'img', name: '', path: [] },
        ],
        refMap: new Map([['e4', 'x']]),
      }),
    ).toBe(7);
    expect(maxRefIndex({ nodes: [], refMap: new Map([['e9', 'x']]) })).toBe(9);
    expect(maxRefIndex({ nodes: [], refMap: new Map() })).toBe(0);
  });
});
