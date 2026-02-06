export type RetryOptions = {
  attempts: number;
  delayMs: number;
};

/**
 * Delay execution for a specified number of milliseconds.
 *
 * @param ms - Number of milliseconds to delay
 */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an operation until it succeeds or max attempts are reached.
 *
 * @param operation - The async operation to retry
 * @param isSuccess - Function to determine if the result is successful
 * @param options - Retry configuration with attempts and delay
 * @returns The result from the operation
 */
export async function retryUntil<Result>(
  operation: () => Promise<Result>,
  isSuccess: (result: Result) => boolean,
  options: RetryOptions,
): Promise<Result> {
  const { attempts, delayMs } = options;

  let lastResult: Result | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    lastResult = await operation();
    if (isSuccess(lastResult)) {
      return lastResult;
    }

    if (attempt < attempts - 1) {
      await delay(delayMs);
    }
  }

  return lastResult as Result;
}
