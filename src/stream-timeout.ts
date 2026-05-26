export class StreamIdleTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly activeCalls: string[],
  ) {
    super(`Agent stream idle timeout after ${timeoutMs}ms`);
    this.name = "StreamIdleTimeoutError";
  }
}

export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  getActiveCalls: () => string[] = () => [],
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new StreamIdleTimeoutError(timeoutMs, getActiveCalls()));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([iterator.next(), timeout]);
      if (result.done) return;
      yield result.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
