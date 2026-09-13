export type ReplyPriority = "progress" | "final";

type ReplyJob = {
  priority: ReplyPriority;
  run: () => Promise<unknown>;
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  progressKey?: string;
  superseded?: boolean;
  shouldRun?: () => boolean;
};

export interface ReplyScheduler {
  readonly activeCount: number;
  readonly queuedCount: number;
  schedule<T>(run: () => Promise<T>, priority?: ReplyPriority): Promise<T>;
  scheduleIf<T>(shouldRun: () => boolean, run: () => Promise<T>, priority?: ReplyPriority): Promise<T | undefined>;
  scheduleLatest<T>(key: string, run: () => Promise<T>, shouldRun?: () => boolean): Promise<T | undefined>;
}

export function createReplyScheduler(maxInFlight = 4): ReplyScheduler {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error("回复调度并发数必须是正整数");
  }

  let activeCount = 0;
  const finalJobs: ReplyJob[] = [];
  const progressJobs: ReplyJob[] = [];
  const latestProgressJobs = new Map<string, ReplyJob>();

  const nextJob = () => finalJobs.shift() || progressJobs.shift();
  const drain = () => {
    while (activeCount < maxInFlight) {
      const job = nextJob();
      if (!job) return;
      if (job.superseded) continue;
      if (job.progressKey) latestProgressJobs.delete(job.progressKey);
      if (job.shouldRun && !job.shouldRun()) {
        job.resolve(undefined);
        continue;
      }
      activeCount += 1;
      void Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeCount -= 1;
          drain();
        });
    }
  };

  const enqueue = <T>(
    run: () => Promise<T>,
    priority: ReplyPriority,
    shouldRun?: () => boolean,
  ): Promise<T | undefined> => new Promise<T | undefined>((resolve, reject) => {
    const job: ReplyJob = {
      priority,
      run,
      resolve,
      reject,
      ...(shouldRun ? { shouldRun } : {}),
    };
    if (priority === "final") {
      finalJobs.push(job);
    } else {
      progressJobs.push(job);
    }
    drain();
  });

  return {
    get activeCount() {
      return activeCount;
    },
    get queuedCount() {
      return finalJobs.length + progressJobs.filter(job => !job.superseded).length;
    },
    schedule<T>(run: () => Promise<T>, priority: ReplyPriority = "progress") {
      return enqueue(run, priority).then(value => value as T);
    },
    scheduleIf<T>(shouldRun: () => boolean, run: () => Promise<T>, priority: ReplyPriority = "progress") {
      return enqueue(run, priority, shouldRun);
    },
    scheduleLatest<T>(key: string, run: () => Promise<T>, shouldRun?: () => boolean) {
      return new Promise<T | undefined>((resolve, reject) => {
        const previous = latestProgressJobs.get(key);
        if (previous) {
          previous.superseded = true;
          previous.resolve(undefined);
        }
        const job: ReplyJob = {
          priority: "progress",
          run,
          resolve,
          reject,
          progressKey: key,
          ...(shouldRun ? { shouldRun } : {}),
        };
        latestProgressJobs.set(key, job);
        progressJobs.push(job);
        drain();
      });
    },
  };
}
