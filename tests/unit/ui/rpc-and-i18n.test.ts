import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RpcClient, RpcError } from "@/ipc/client";
import type { Transport } from "@/ipc/transport";
import { wedgeShape } from "@/lib/depict";

/** In-memory transport: replies via a handler, like the sidecar would. */
class FakeTransport implements Transport {
  readonly kind = "bridge" as const;
  sent: Record<string, unknown>[] = [];
  private handler: ((line: string) => void) | null = null;
  constructor(private respond: (req: Record<string, unknown>) => Record<string, unknown> | null) {}
  async send(line: string): Promise<void> {
    const req = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(req);
    const reply = this.respond(req);
    if (reply) queueMicrotask(() => this.handler?.(JSON.stringify(reply)));
  }
  onMessage(handler: (line: string) => void): () => void {
    this.handler = handler;
    return () => (this.handler = null);
  }
  emit(message: Record<string, unknown>): void {
    this.handler?.(JSON.stringify(message));
  }
}

describe("RpcClient", () => {
  it("returns validated results and attaches a job id to every request", async () => {
    const transport = new FakeTransport((req) => ({ jsonrpc: "2.0", id: req.id, result: { pong: true } }));
    const client = new RpcClient(transport);
    await expect(client.call("system.ping", {}, z.object({ pong: z.literal(true) }))).resolves.toEqual({ pong: true });
    expect((transport.sent[0]!.params as Record<string, unknown>).jobId).toMatch(/^ui-/);
  });

  it("surfaces engine errors as RpcError, never as a validation failure", async () => {
    const transport = new FakeTransport((req) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Invalid params" } }));
    const client = new RpcClient(transport);
    const failure = client.call("library.list", {}, z.object({ total: z.number() }));
    await expect(failure).rejects.toBeInstanceOf(RpcError);
    await expect(failure).rejects.toMatchObject({ code: -32602, message: "Invalid params" });
  });

  it("rejects malformed results with the failing field path", async () => {
    const transport = new FakeTransport((req) => ({ jsonrpc: "2.0", id: req.id, result: { total: "many" } }));
    const client = new RpcClient(transport);
    await expect(client.call("library.list", {}, z.object({ total: z.number() }))).rejects.toThrow(/at total/);
  });

  it("times out and forgets requests that never answer", async () => {
    const client = new RpcClient(new FakeTransport(() => null));
    await expect(client.call("system.ping", {}, z.unknown(), { timeoutMs: 30 })).rejects.toMatchObject({ code: -32001 });
  });

  it("streams progress to the caller and cancels by job id", async () => {
    let transport!: FakeTransport;
    transport = new FakeTransport((req) => {
      if (req.method === "sim.md") {
        const jobId = (req.params as Record<string, unknown>).jobId;
        queueMicrotask(() => transport.emit({ jsonrpc: "2.0", method: "progress", params: { jobId, percent: 50, stage: "md", message: "half" } }));
        setTimeout(() => transport.emit({ jsonrpc: "2.0", id: req.id, result: { ok: true } }), 5);
      }
      return null;
    });
    const client = new RpcClient(transport);
    const seen: number[] = [];
    await client.call("sim.md", {}, z.object({ ok: z.boolean() }), { onProgress: (p) => seen.push(p.percent) });
    expect(seen).toEqual([50]);
    await client.cancel("job-1");
    expect(transport.sent.at(-1)).toMatchObject({ method: "job.cancel", params: { jobId: "job-1" } });
  });

  it("becomes ready from a ping even if the ready notification was missed", async () => {
    const transport = new FakeTransport((req) => ({ jsonrpc: "2.0", id: req.id, result: { pong: true, version: "1" } }));
    const client = new RpcClient(transport);
    await client.waitUntilReady(() => client.call("system.ping", {}, z.unknown()), 2000);
  });
});

describe("stereo wedge geometry", () => {
  const seg = { bond: 0, x1: 0, y1: 0, x2: 1.5, y2: 0, dashed: false };
  it("starts narrow at the stereocentre and widens away from it", () => {
    const wedge = wedgeShape(seg, [1.5, 0], "wedge");
    expect(wedge.points!.startsWith("1.5,0 ")).toBe(true);
  });
  it("draws hash rungs that grow along the bond", () => {
    const hash = wedgeShape(seg, [0, 0], "hash");
    const widths = hash.rungs!.map(([x1, y1, x2, y2]) => Math.hypot(x2 - x1, y2 - y1));
    expect(widths.length).toBeGreaterThanOrEqual(4);
    expect([...widths].sort((a, b) => a - b)).toEqual(widths);
  });
});

describe("i18n", () => {
  it("formats plurals per locale and mirrors layout for right-to-left languages", async () => {
    const { initI18n, applyDirection } = await import("@/lib/i18n");
    const i18n = await initI18n();
    await i18n.changeLanguage("en");
    expect(i18n.t("library.count", { count: 1 })).toBe("1 molecule");
    expect(i18n.t("library.count", { count: 3 })).toBe("3 molecules");
    await i18n.changeLanguage("th");
    expect(i18n.t("library.count", { count: 3 })).toBe("3 โมเลกุล");
    expect(i18n.t("validation.valid")).toBe("เชื่อมต่อพันธะถูกต้อง");
    applyDirection("ar");
    expect(document.documentElement.dir).toBe("rtl");
    applyDirection("th");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
