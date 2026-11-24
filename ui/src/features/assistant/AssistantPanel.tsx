/** Local chemistry assistant panel (spec 7.10): streaming answers with visible, inspectable tool calls. */
import DOMPurify from "dompurify";
import { AnimatePresence, motion } from "framer-motion";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Bot, Check, Cpu, Loader2, Send, ShieldCheck, Square, TriangleAlert, Wrench, X } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, IconButton, cx } from "@/design-system/primitives";
import { type AiAnswer, type AiStatus, api, askAssistant } from "@/ipc/api";
import { rpc, RpcError } from "@/ipc/client";
import { IS_LITE } from "@/lib/edition";
import { errorText } from "@/lib/errors";
import { canChooseModel, chooseModelFile } from "@/lib/files";
import { useApp } from "@/state/app";
import { useEditor } from "@/state/editor";
import { DesktopOnly } from "../../app/LiteNotice";

interface ToolChip {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
  durationMs?: number;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  tools?: ToolChip[];
  meta?: Pick<AiAnswer, "confidence" | "sources" | "model" | "durationMs" | "refused"> & { unsupported?: string[] };
  pending?: boolean;
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text]);
  return (
    <div
      className="prose-sm space-y-2 text-sm leading-6 text-ink [&_code]:rounded-sm [&_code]:bg-surface-3 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_li]:ms-4 [&_ol]:list-decimal [&_strong]:font-semibold [&_ul]:list-disc"
      // Content is sanitised by DOMPurify above (spec 10: sanitize any rendered HTML).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const SUGGESTIONS = ["assistant.suggest.explain", "assistant.suggest.druglike", "assistant.suggest.element", "assistant.suggest.repair"];

export function AssistantPanel() {
  const { t, i18n } = useTranslation();
  const open = useApp((s) => s.assistantOpen);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const jobRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || status || statusFailed || IS_LITE) return;
    api.aiStatus().then(setStatus).catch(() => setStatusFailed(true));
  }, [open, status, statusFailed]);

  const pushToast = useApp((s) => s.pushToast);
  const applyModel = async (config: { modelPath?: string; useDefault?: boolean }) => {
    try {
      const next = await api.aiConfigure(config);
      setStatus(next);
      pushToast({ tone: "success", title: t("assistant.model.changed", { model: next.model.name ?? "" }) });
    } catch (err) {
      pushToast({ tone: "danger", title: t("assistant.model.failed"), body: errorText(err) });
    }
  };
  const chooseModel = async () => {
    try {
      const picked = await chooseModelFile();
      if (picked) await applyModel({ modelPath: picked.path });
    } catch (err) {
      pushToast({ tone: "danger", title: t("assistant.model.failed"), body: errorText(err) });
    }
  };

  useEffect(() => {
    return rpc().onNotification((method, params) => {
      if (params.jobId !== jobRef.current) return;
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "assistant") return prev;
        if (method === "ai.delta") next[next.length - 1] = { ...last, content: last.content + String(params.text ?? "") };
        else if (method === "ai.reset") next[next.length - 1] = { ...last, content: "" };
        else if (method === "ai.tool") {
          const tools = [...(last.tools ?? [])];
          const idx = tools.findIndex((c) => c.id === params.id);
          const chip: ToolChip = {
            id: String(params.id),
            name: String(params.name),
            status: params.status as ToolChip["status"],
            summary: params.summary as string | undefined,
            durationMs: params.durationMs as number | undefined,
          };
          if (idx >= 0) tools[idx] = { ...tools[idx]!, ...chip };
          else tools.push(chip);
          next[next.length - 1] = { ...last, tools };
        }
        return next;
      });
      if (method === "ai.status") setStage(String(params.stage));
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const send = async (prompt: string) => {
    const text = prompt.trim();
    if (!text || busy) return;
    const jobId = `ai-${Date.now().toString(36)}`;
    jobRef.current = jobId;
    const history = turns.filter((x) => !x.pending).map((x) => ({ role: x.role, content: x.content }));
    setTurns((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "", tools: [], pending: true }]);
    setInput("");
    setBusy(true);
    setStage("loading");
    const molecule = useEditor.getState().doc.molecule;
    try {
      const result = await askAssistant(text, history, molecule.atoms.length ? molecule : null, {}, i18n.language, { jobId });
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1]!;
        next[next.length - 1] = {
          ...last,
          content: result.answer,
          pending: false,
          meta: { confidence: result.confidence, sources: result.sources, model: result.model, durationMs: result.durationMs, refused: result.refused, unsupported: result.unsupportedNumbers },
        };
        return next;
      });
    } catch (err) {
      const message = err instanceof RpcError && err.cancelled ? t("assistant.cancelled") : errorText(err);
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1]!;
        next[next.length - 1] = { ...last, content: last.content || message, pending: false, meta: { confidence: "low", sources: [], model: "", durationMs: 0, refused: false } };
        return next;
      });
    } finally {
      setBusy(false);
      setStage(null);
      jobRef.current = null;
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 32, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 32, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 36 }}
          className="flex w-[420px] shrink-0 flex-col border-s border-line bg-surface-1"
          aria-label={t("assistant.title")}
          data-testid="assistant-panel"
        >
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <div className="grid size-8 place-items-center rounded-full bg-accent-soft text-accent">
              <Bot className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{t("assistant.title")}</p>
              <p className="truncate text-2xs text-ink-3" data-testid="assistant-model">
                {IS_LITE
                  ? t("lite.feature.assistant.title")
                  : status?.available
                  ? t("assistant.runningOn", { model: status.model.name ?? "", device: status.accelerator })
                  : status || statusFailed
                    ? t("assistant.unavailable")
                    : t("assistant.model.checking")}
              </p>
            </div>
            {canChooseModel() && (
              <Dropdown.Root>
                <Dropdown.Trigger asChild>
                  <IconButton size="sm" label={t("assistant.model.menu")} data-testid="assistant-model-menu">
                    <Cpu className="size-4" />
                  </IconButton>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content align="end" sideOffset={6} className="z-50 max-w-72 rounded bg-surface-1 p-1 shadow-3 hairline">
                    <Dropdown.Label className="px-3 py-1.5 text-2xs text-ink-3">{t("assistant.model.hint")}</Dropdown.Label>
                    <Dropdown.Item onSelect={() => void chooseModel()} className="cursor-pointer rounded-sm px-3 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-surface-3">
                      {t("assistant.model.choose")}
                    </Dropdown.Item>
                    {status?.bundledModel && !status.model.bundled && (
                      <Dropdown.Item onSelect={() => void applyModel({ useDefault: true })} className="cursor-pointer rounded-sm px-3 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-surface-3">
                        {t("assistant.model.useBundled", { model: status.bundledModel })}
                      </Dropdown.Item>
                    )}
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            )}
            <Badge tone="success">
              <ShieldCheck className="size-3" />
              {t("assistant.offline")}
            </Badge>
            <IconButton size="sm" label={t("action.close")} onClick={() => useApp.getState().toggleAssistant(false)}>
              <X className="size-4" />
            </IconButton>
          </header>

          {IS_LITE ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <p className="mb-3 text-sm leading-6 text-ink-2">{t("assistant.intro")}</p>
              <DesktopOnly feature="assistant" />
            </div>
          ) : (
            <>
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
              {turns.length === 0 && (
                <div className="space-y-3">
                  <p className="text-sm leading-6 text-ink-2">{t("assistant.intro")}</p>
                  <div className="flex flex-col gap-2">
                    {SUGGESTIONS.map((key) => (
                      <button
                        key={key}
                        className="rounded bg-surface-2 px-3 py-2 text-start text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink hairline"
                        onClick={() => void send(t(key))}
                      >
                        {t(key)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {turns.map((turn, i) =>
                turn.role === "user" ? (
                  <div key={i} className="ms-10 rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink" data-testid="assistant-user-turn">
                    {turn.content}
                  </div>
                ) : (
                  <div key={i} className="space-y-2" data-testid="assistant-answer" data-confidence={turn.meta?.confidence}>
                    {turn.tools && turn.tools.length > 0 && (
                      <ul className="space-y-1">
                        {turn.tools.map((tool) => (
                          <li key={tool.id} className="flex items-center gap-2 rounded bg-surface-2 px-2.5 py-1.5 text-2xs hairline" data-testid="assistant-tool-call" data-tool={tool.name}>
                            {tool.status === "running" ? (
                              <Loader2 className="size-3 animate-spin text-accent" />
                            ) : tool.status === "done" ? (
                              <Check className="size-3 text-success" />
                            ) : (
                              <TriangleAlert className="size-3 text-danger" />
                            )}
                            <Wrench className="size-3 text-ink-3" />
                            <span className="font-mono font-medium text-ink">{tool.name}</span>
                            <span className="truncate text-ink-3">{tool.summary}</span>
                            {tool.durationMs !== undefined && <span className="ms-auto font-mono text-ink-3">{tool.durationMs} ms</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {turn.content ? (
                      <Markdown text={turn.content} />
                    ) : (
                      turn.pending && (
                        <p className="flex items-center gap-2 text-xs text-ink-3">
                          <Loader2 className="size-3.5 animate-spin" />
                          {t(`assistant.stage.${stage ?? "thinking"}`)}
                        </p>
                      )
                    )}
                    {turn.meta && !turn.pending && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={turn.meta.confidence === "high" ? "success" : turn.meta.confidence === "medium" ? "info" : "warning"}>
                          {t(`assistant.confidence.${turn.meta.confidence}`)}
                        </Badge>
                        {turn.meta.unsupported && turn.meta.unsupported.length > 0 && (
                          <Badge tone="warning">{t("assistant.unsupported", { values: turn.meta.unsupported.join(", ") })}</Badge>
                        )}
                        {turn.meta.durationMs > 0 && <span className="text-2xs text-ink-3">{(turn.meta.durationMs / 1000).toFixed(1)} s</span>}
                      </div>
                    )}
                  </div>
                ),
              )}
            </div>

            <form
              className="border-t border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <div className="flex items-end gap-2 rounded-lg bg-surface-2 p-2 hairline focus-within:ring-2 focus-within:ring-focus">
                <textarea
                  className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-1 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
                  rows={2}
                  value={input}
                  placeholder={t("assistant.placeholder")}
                  aria-label={t("assistant.placeholder")}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(input);
                    }
                  }}
                  data-testid="assistant-input"
                />
                {busy ? (
                  <Button type="button" size="sm" variant="secondary" icon={<Square className="size-3.5" />} onClick={() => jobRef.current && void rpc().cancel(jobRef.current)}>
                    {t("action.stop")}
                  </Button>
                ) : (
                  <Button type="submit" size="sm" variant="primary" icon={<Send className="size-3.5" />} disabled={!input.trim() || status?.available === false || statusFailed} data-testid="assistant-send">
                    {t("assistant.send")}
                  </Button>
                )}
              </div>
              <p className={cx("mt-2 text-2xs text-ink-3")}>{t("assistant.disclaimer")}</p>
            </form>
            </>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
