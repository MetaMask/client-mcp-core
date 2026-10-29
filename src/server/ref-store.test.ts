import { describe, it, expect, vi } from 'vitest';

import { RefStore } from './ref-store.js';

function createSessionManager() {
  return { setRefMap: vi.fn() };
}

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

    const applied = store.begin().set(map);

    expect(applied).toBe(true);
    expect(sessionManager.setRefMap).toHaveBeenCalledWith(map);
  });

  it('drops set() from a handle of an older generation', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const old = store.begin();
    store.begin();

    const applied = old.set(new Map([['e1', 'late']]));

    expect(applied).toBe(false);
    expect(old.isCurrent()).toBe(false);
    expect(sessionManager.setRefMap).not.toHaveBeenCalled();
  });

  it('drops set() once the request signal is aborted', () => {
    const sessionManager = createSessionManager();
    const store = new RefStore(sessionManager);
    const controller = new AbortController();
    const handle = store.begin(controller.signal);

    expect(handle.isCurrent()).toBe(true);
    controller.abort();

    expect(handle.isCurrent()).toBe(false);
    expect(handle.set(new Map([['e1', 'late']]))).toBe(false);
    expect(sessionManager.setRefMap).not.toHaveBeenCalled();
  });

  it('sets toolSetRefs only for applied tool writes', () => {
    const store = new RefStore(createSessionManager());
    const handle = store.begin();

    expect(handle.toolSetRefs).toBe(false);
    handle.set(new Map(), 'observation');
    expect(handle.toolSetRefs).toBe(false);
    handle.set(new Map());
    expect(handle.toolSetRefs).toBe(true);

    const stale = store.begin();
    store.begin();
    stale.set(new Map());
    expect(stale.toolSetRefs).toBe(false);
  });
});
