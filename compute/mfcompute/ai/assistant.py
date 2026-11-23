"""``ai.query``: the local chemistry assistant.

Grounding guarantees (spec 7.10, X4):
* The model is told to obtain every chemical number from tools or the bundled reference notes.
* After answering, every number in the text is checked against tool results, retrieved notes and
  the user's own message. If any is unsupported the model gets one chance to revise (the UI is
  told to discard the streamed draft); if numbers are still unsupported the answer is shown with
  confidence "low" and the unsupported values listed.
"""

from __future__ import annotations

import contextlib
import json
import re
import time
from typing import Any

from ..jobs import JobContext
from ..models import AiQueryParams
from . import knowledge, llm, tools

MAX_ROUNDS = 5
LANGUAGE = {"en": "English", "th": "Thai (ภาษาไทย)"}
NUMBER = re.compile(r"(?<![\w.])[-−]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?")

HARMFUL = re.compile(
    r"(synthes|manufactur|produc|prepar|make|making|cook|recipe|step[- ]by[- ]step|route|weaponi[sz]|detonat|build)\w*"
    r".{0,60}?"
    r"(nerve agent|sarin|soman|tabun|novichok|\bvx\b|mustard gas|chemical weapon|ricin|explosive|\btnt\b|\brdx\b|\bpetn\b|"
    r"\btatp\b|\bhmx\b|nitroglycerin|pipe bomb|\bbomb\b|methamphetamine|\bmeth\b|fentanyl|carfentanil|heroin|\blsd\b|\bmdma\b|cocaine)",
    re.IGNORECASE,
)

REFUSAL = {
    "en": ("I can't help with making or weaponising hazardous substances. MoleculeForge is for learning about structures "
           "and computing their properties, so I'm happy to explain the chemistry or compute properties of a structure instead."),
    "th": ("ฉันช่วยเรื่องการผลิตหรือการนำสารอันตรายไปใช้เป็นอาวุธไม่ได้ MoleculeForge มีไว้เพื่อการเรียนรู้โครงสร้างและคำนวณสมบัติของโมเลกุล "
           "ฉันยินดีอธิบายหลักเคมีหรือคำนวณสมบัติของโครงสร้างแทนได้"),
}


def system_prompt(locale: str) -> str:
    return (
        "You are Forge, the chemistry assistant inside MoleculeForge. You run fully offline on the user's computer.\n"
        "Rules:\n"
        "1. Every numerical chemical value you state (energies, bond lengths, angles, charges, frequencies, masses, "
        "logP, pKa, dipoles, affinities, element data) must come from a tool result in this conversation or from the "
        "reference notes provided. Call the tools to compute or look values up. Never estimate numbers from memory.\n"
        "2. Give units with every value and name the method that produced it (it is in the tool result).\n"
        "3. If a tool fails or data is missing, say so plainly instead of guessing.\n"
        "4. End with a short 'Sources:' line naming the tools and notes you used.\n"
        "5. State uncertainty and method limitations (e.g. docking scores are educational estimates).\n"
        "6. MoleculeForge computes properties of structures; it is not a synthesis planner. Refuse requests to make "
        "weapons, explosives, illegal drugs or other harmful instructions, and briefly decline out-of-scope requests.\n"
        "7. Be concise and educational: short paragraphs or bullet lists, suitable for students.\n"
        f"Answer in {LANGUAGE.get(locale, 'English')}."
    )


def _molecule_context(params: AiQueryParams) -> str:
    m = params.molecule
    if m is None or not m.atoms:
        return "No molecule is open in the editor."
    return (f"The molecule open in the editor: name '{m.name or 'untitled'}', formula {m.formula or 'unknown'}, "
            f"SMILES {m.meta.smiles or 'unknown'}, {len(m.atoms)} atoms. Tools use it when no SMILES is given.")


def _numbers(text: str) -> list[str]:
    return [n.replace("−", "-").replace(",", ".") for n in NUMBER.findall(text)]


def _grounded(value: str, pool: list[float]) -> bool:
    try:
        x = float(value)
    except ValueError:
        return True
    if abs(x) <= 10 and float(x).is_integer():
        return True  # small counts ("2 lone pairs", "rule of 5") are not chemical measurements
    decimals = len(value.split(".")[1]) if "." in value else 0
    for y in pool:
        if round(y, decimals) == round(x, decimals) or abs(y - x) <= max(abs(y) * 0.01, 10 ** -decimals):
            return True
        if abs(abs(y) - abs(x)) <= max(abs(y) * 0.01, 10 ** -decimals):
            return True  # sign conventions (e.g. "affinity of 7.2 kcal/mol" for -7.2)
    return False


def _collect(obj: Any, out: list[float]) -> None:
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        out.append(float(obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _collect(v, out)
    elif isinstance(obj, str):
        for n in _numbers(obj):
            with contextlib.suppress(ValueError):
                out.append(float(n))


def _summary(name: str, result: dict[str, Any]) -> str:
    if "error" in result:
        return f"error: {result['error']}"
    parts = []
    for key, value in result.items():
        if isinstance(value, dict) and "value" in value and isinstance(value["value"], (int, float)):
            parts.append(f"{key} {value['value']} {value.get('unit', '')}".strip())
        if len(parts) >= 3:
            break
    return ", ".join(parts) if parts else name


def answer(params: AiQueryParams, ctx: JobContext) -> dict[str, Any]:
    started = time.perf_counter()
    locale = params.locale if params.locale in LANGUAGE else "en"
    if HARMFUL.search(params.prompt):
        text = REFUSAL[locale]
        ctx.notify("ai.delta", {"text": text})
        return {"answer": text, "toolCalls": [], "sources": [], "confidence": "high", "model": "policy",
                "durationMs": int((time.perf_counter() - started) * 1000), "refused": True}

    ctx.notify("ai.status", {"stage": "loading"})
    llm.ensure_running(ctx)
    notes = knowledge.search(params.prompt + " " + (params.molecule.formula if params.molecule else ""), k=3)
    notes_text = "\n\n".join(f"[{n.title}] ({n.source})\n{n.text}" for n in notes)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(locale) + "\n\n" + _molecule_context(params)
         + (f"\n\nReference notes:\n{notes_text}" if notes else "")},
    ]
    for turn in params.history[-8:]:
        role = turn.get("role")
        if role in ("user", "assistant") and isinstance(turn.get("content"), str):
            messages.append({"role": role, "content": turn["content"][:2000]})
    messages.append({"role": "user", "content": params.prompt})

    tool_ctx = tools.ToolContext(params.molecule, ctx)
    calls: list[dict[str, Any]] = []
    pool: list[float] = []
    _collect(params.prompt, pool)
    for note in notes:
        _collect(note.text, pool)
    if params.molecule is not None:
        _collect(params.molecule.formula, pool)

    def stream(text: str) -> None:
        ctx.notify("ai.delta", {"text": text})

    final = ""
    for _round in range(MAX_ROUNDS):
        ctx.notify("ai.status", {"stage": "thinking"})
        turn = llm.stream_chat(messages, tools.schemas(), ctx, stream)
        if not turn["tool_calls"]:
            final = turn["content"]
            break
        messages.append({"role": "assistant", "content": turn["content"] or "",
                         "tool_calls": [{"id": c["id"] or f"call_{i}", "type": "function",
                                         "function": {"name": c["name"], "arguments": c["arguments"] or "{}"}}
                                        for i, c in enumerate(turn["tool_calls"])]})
        if turn["content"]:
            ctx.notify("ai.reset", {})
        for i, call in enumerate(turn["tool_calls"]):
            call_id = call["id"] or f"call_{i}"
            ctx.notify("ai.tool", {"id": call_id, "name": call["name"], "arguments": call["arguments"], "status": "running"})
            ok, result, duration = tools.execute(call["name"], call["arguments"], tool_ctx)
            _collect(result, pool)
            summary = _summary(call["name"], result)
            try:
                parsed_args = json.loads(call["arguments"]) if call["arguments"] else {}
            except json.JSONDecodeError:
                parsed_args = {"raw": call["arguments"]}
            calls.append({"id": call_id, "name": call["name"], "arguments": parsed_args if isinstance(parsed_args, dict) else {},
                          "ok": ok, "durationMs": duration, "summary": summary, "result": result})
            ctx.notify("ai.tool", {"id": call_id, "name": call["name"], "status": "done" if ok else "error",
                                   "summary": summary, "durationMs": duration})
            content = json.dumps(result, ensure_ascii=False, default=str)
            messages.append({"role": "tool", "tool_call_id": call_id, "content": content[:6000]})
    else:
        final = final or "I could not complete the request within the tool-call limit."

    unsupported = [n for n in _numbers(final) if not _grounded(n, pool)]
    if unsupported:
        ctx.notify("ai.reset", {})
        messages.append({"role": "assistant", "content": final})
        messages.append({"role": "user", "content": (
            "Verification: these numbers in your answer are not supported by any tool result or reference note: "
            + ", ".join(sorted(set(unsupported))[:12])
            + ". Rewrite the answer using only values returned by tools in this conversation (call a tool if you need "
            "another value). Do not state any other numbers.")})
        revised = llm.stream_chat(messages, None, ctx, stream)
        final = revised["content"] or final
        unsupported = [n for n in _numbers(final) if not _grounded(n, pool)]

    if unsupported:
        confidence = "low"
    elif calls and all(c["ok"] for c in calls):
        confidence = "high"
    else:
        confidence = "medium"
    sources = [f"tool:{c['name']}" for c in calls] + [f"note:{n.title}" for n in notes]
    return {
        "answer": final.strip(),
        "toolCalls": calls,
        "sources": sources,
        "confidence": confidence,
        "unsupportedNumbers": sorted(set(unsupported)),
        "model": llm.status()["model"]["name"] or "local model",
        "durationMs": int((time.perf_counter() - started) * 1000),
        "refused": False,
    }
