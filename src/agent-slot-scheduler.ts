export class AgentSlotCancelledError extends Error {
  constructor() {
    super("Agent 排队已取消");
    this.name = "AgentSlotCancelledError";
  }
}

export interface AgentSlotLease {
  release(): void;
}

export interface AgentSlotScheduler {
  readonly activeCount: number;
  readonly queuedCount: number;
  acquire(signal?: AbortSignal): Promise<AgentSlotLease>;
}

type WaitingRequest = {
  resolve: (lease: AgentSlotLease) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export function createAgentSlotScheduler(maxActive = 4): AgentSlotScheduler {
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    throw new Error("Agent 并发槽位必须是正整数");
  }

  let activeCount = 0;
  const waiting: WaitingRequest[] = [];

  const createLease = (): AgentSlotLease => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        activeCount -= 1;
        grantNext();
      },
    };
  };

  const grantNext = () => {
    while (activeCount < maxActive) {
      const next = waiting.shift();
      if (!next) return;
      next.signal?.removeEventListener("abort", next.abort!);
      if (next.signal?.aborted) {
        next.reject(new AgentSlotCancelledError());
        continue;
      }
      activeCount += 1;
      next.resolve(createLease());
    }
  };

  return {
    get activeCount() {
      return activeCount;
    },
    get queuedCount() {
      return waiting.length;
    },
    acquire(signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(new AgentSlotCancelledError());
      if (activeCount < maxActive && waiting.length === 0) {
        activeCount += 1;
        return Promise.resolve(createLease());
      }
      return new Promise<AgentSlotLease>((resolve, reject) => {
        const request: WaitingRequest = {
          resolve,
          reject,
          ...(signal ? { signal } : {}),
        };
        const abort = () => {
          const index = waiting.indexOf(request);
          if (index >= 0) waiting.splice(index, 1);
          reject(new AgentSlotCancelledError());
        };
        request.abort = abort;
        signal?.addEventListener("abort", abort, { once: true });
        waiting.push(request);
      });
    },
  };
}
