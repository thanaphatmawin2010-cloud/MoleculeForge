/**
 * Typed JSON-RPC 2.0 client with progress streaming and cancellation (spec 4.2 / 6.3).
 */
import type { z } from "zod";
import { type Progress, ProgressSchema, RpcMessageSchema } from "./schema";
import { createTransport, type Transport } from "./transport";

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
  get cancelled(): boolean {
    return this.code === -32000;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  jobId: string;
}

type ProgressHandler = (progress: Progress) => void;
type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export interface CallOptions {
  jobId?: string;
  onProgress?: ProgressHandler;
  signal?: AbortSignal;
  /** Reject (and forget the request) if no response arrives in time. Jobs normally have no timeout. */
  timeoutMs?: number;
}

let counter = 0;
const newJobId = () => `ui-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class RpcClient {
  private transport: Transport;
  private pending = new Map<string, Pending>();
  private progress = new Map<string, ProgressHandler>();
  private notificationHandlers = new Set<NotificationHandler>();
  private readyResolve!: (params: Record<string, unknown>) => void;
  readonly ready: Promise<Record<string, unknown>>;

  constructor(transport: Transport = createTransport()) {
    this.transport = transport;
    this.ready = new Promise((resolve) => (this.readyResolve = resolve));
    this.transport.onMessage((line) => this.receive(line));
  }

  get transportKind(): Transport["kind"] {
    return this.transport.kind;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  private receive(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error("Discarded malformed sidecar message");
      return;
    }
    const message = RpcMessageSchema.safeParse(parsed);
    if (!message.success) {
      console.error("Discarded sidecar message failing schema validation");
      return;
    }
    const msg = message.data;
    if ("method" in msg) {
      if (msg.method === "ready") this.readyResolve(msg.params);
      if (msg.method === "progress") {
        const progress = ProgressSchema.safeParse(msg.params);
        if (progress.success) this.progress.get(progress.data.jobId)?.(progress.data);
      }
      for (const handler of this.notificationHandlers) handler(msg.method, msg.params);
      return;
    }
    const key = String(msg.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    this.progress.delete(pending.jobId);
    if ("error" in msg) pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else pending.resolve(msg.result);
  }

  /** Call a method and validate the result with ``schema``. */
  async call<T extends z.ZodTypeAny>(
    method: string,
    params: Record<string, unknown>,
    schema: T,
    options: CallOptions = {},
  ): Promise<z.infer<T>> {
    const jobId = options.jobId ?? newJobId();
    const id = `${jobId}#${method}`;
    if (options.onProgress) this.progress.set(jobId, options.onProgress);
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, jobId });
    });
    const abort = () => void this.cancel(jobId);
    options.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout =
      options.timeoutMs === undefined
        ? null
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              this.pending.delete(id);
              this.progress.delete(jobId);
              reject(new RpcError(-32001, `${method} timed out after ${options.timeoutMs} ms`));
            }, options.timeoutMs);
          });
    try {
      await this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, jobId } }));
      const raw = await (timeout ? Promise.race([result, timeout]) : result);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RpcError(-32603, `Response for ${method} failed validation at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? ""}`);
      }
      return parsed.data;
    } catch (err) {
      this.pending.delete(id);
      this.progress.delete(jobId);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /**
   * Resolve once the compute sidecar answers. The "ready" notification can be emitted before the
   * webview subscribes to sidecar events, so a cheap ``system.ping`` is polled as well.
   */
  async waitUntilReady(ping: () => Promise<unknown>, timeoutMs = 60_000): Promise<void> {
    let done = false;
    const notified = this.ready.then(() => {
      done = true;
    });
    const deadline = Date.now() + timeoutMs;
    while (!done && Date.now() < deadline) {
      const attempt = ping().then(
        () => {
          done = true;
        },
        () => undefined,
      );
      await Promise.race([notified, Promise.all([attempt, new Promise((r) => setTimeout(r, 400))])]);
    }
    if (!done) throw new Error("The compute engine did not start within 60 seconds.");
  }

  async cancel(jobId: string): Promise<void> {
    await this.transport.send(
      JSON.stringify({ jsonrpc: "2.0", id: `cancel-${jobId}`, method: "job.cancel", params: { jobId } }),
    );
  }
}

let shared: RpcClient | null = null;

export function rpc(): RpcClient {
  shared ??= new RpcClient();
  return shared;
}

export function setRpcClient(client: RpcClient): void {
  shared = client;
}
