/** Job contexts: progress notifications and cooperative cancellation (compute/mfcompute/jobs.py). */
import { JOB_CANCELLED, RpcFailure } from "./errors";

export type Emitter = (method: string, params: Record<string, unknown>) => void;

export class JobContext {
  private lastEmit = 0;
  readonly started = performance.now();

  constructor(
    readonly jobId: string,
    private readonly emit: Emitter | null = null,
    private readonly token: { cancelled: boolean } = { cancelled: false },
  ) {}

  cancel(): void {
    this.token.cancelled = true;
  }

  get cancelled(): boolean {
    return this.token.cancelled;
  }

  check(): void {
    if (this.token.cancelled) throw new RpcFailure(JOB_CANCELLED, "Job cancelled", { jobId: this.jobId });
  }

  /** Yield to the worker's event loop (so cancel requests and other calls get through), then check. */
  async tick(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.check();
  }

  /** Emit a progress notification (rate limited to ~30 Hz unless forced). */
  progress(percent: number, stage: string, message = "", data?: Record<string, unknown>, force = false): void {
    if (!this.emit) return;
    const now = performance.now();
    if (!force && now - this.lastEmit < 1000 / 30 && percent < 100) return;
    this.lastEmit = now;
    const params: Record<string, unknown> = {
      jobId: this.jobId,
      percent: Math.round(Math.max(0, Math.min(100, percent)) * 100) / 100,
      stage,
      message,
    };
    if (data !== undefined) params["data"] = data;
    this.emit("progress", params);
  }

  /** A context sharing this job's id and cancellation, with a different emitter. */
  derive(emit: Emitter | null): JobContext {
    return new JobContext(this.jobId, emit, this.token);
  }

  get emitter(): Emitter | null {
    return this.emit;
  }
}
