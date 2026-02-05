const scheduler =
  typeof setImmediate === 'function' ? setImmediate : setTimeout;

export async function flushPromises() {
  return new Promise((resolve) => {
    scheduler(resolve, 0);
  });
}
