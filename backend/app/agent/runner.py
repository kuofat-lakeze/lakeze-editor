"""One conversation turn: stream Claude, run tools, persist, emit UI events.

Manual loop (not the beta tool runner) because tool calls here take minutes and we want
per-token streaming plus full control over persistence and cancellation.
"""
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Awaitable, Callable

import anthropic

from .. import config
from ..pricing import tool_cost
from .prompt import SYSTEM
from .tools import ToolContext, TOOLS, dispatch

log = logging.getLogger("agent")

# USD per million tokens for the default model (Claude Opus 5.5).
PRICE = {"input": 4.0, "output": 20.0, "cache_read": 0.20, "cache_write": 5.0}
Emit = Callable[[dict], Awaitable[None]]


def _tools() -> list[dict]:
    # Not `strict`: the API caps strict schemas at 24 optional parameters and rejects array/number
    # constraints; our tools have ~33 optionals and every handler defaults missing fields anyway.
    return TOOLS


def _cost(u) -> float:
    return ((u.input_tokens or 0) * PRICE["input"] + (u.output_tokens or 0) * PRICE["output"]
            + (getattr(u, "cache_read_input_tokens", 0) or 0) * PRICE["cache_read"]
            + (getattr(u, "cache_creation_input_tokens", 0) or 0) * PRICE["cache_write"]) / 1e6


class TurnRunner:
    def __init__(self, project_id: str, root: Path, store, emit: Emit):
        """store: object with async load_messages(), save_message(role, content), add_asset(...),
        record_usage(...) — implemented in app.db."""
        self.project_id, self.root, self.store, self.emit = project_id, root, store, emit
        self.client = anthropic.AsyncAnthropic(
            default_headers={"anthropic-workspace-id": config.ANTHROPIC_WORKSPACE_ID} if config.ANTHROPIC_WORKSPACE_ID else None)
        self.ctx = ToolContext(root=root, add_asset=self._add_asset_sync, record_usage=self._usage_sync)
        self._loop: asyncio.AbstractEventLoop | None = None  # set in run()
        self.cancelled = False
        self._state_as_system = True  # mid-conversation system messages; falls back if the model rejects them

    # Tools run in a worker thread; these bridge back to the async store.
    def _add_asset_sync(self, path, kind, name, meta=None):
        fut = asyncio.run_coroutine_threadsafe(self.store.add_asset(self.project_id, path, kind, name, meta), self._loop)
        a = fut.result()
        asyncio.run_coroutine_threadsafe(self.emit({"type": "asset", "asset": a}), self._loop).result()
        return a

    def _usage_sync(self, kind, units, meta=None):
        asyncio.run_coroutine_threadsafe(self.store.record_usage(self.project_id, kind, units, 0.0, meta), self._loop).result()

    async def run(self, user_blocks: list[dict]) -> None:
        self._loop = asyncio.get_running_loop()
        messages = await self.store.load_messages(self.project_id)
        messages.append({"role": "user", "content": user_blocks})
        await self.store.save_message(self.project_id, "user", user_blocks)
        await self.store.note_user_turn(self.project_id)
        for _round in range(40):  # hard cap on tool rounds per turn
            if self.cancelled:
                break
            msg = await self._stream_once(messages + [await self._credit_note()])
            content = [b.model_dump(exclude_none=True) for b in msg.content]
            messages.append({"role": "assistant", "content": content})
            await self.store.save_message(self.project_id, "assistant", content)
            await self.store.record_usage(self.project_id, "claude_tokens",
                                          (msg.usage.input_tokens or 0) + (msg.usage.output_tokens or 0), _cost(msg.usage),
                                          {"in": msg.usage.input_tokens, "out": msg.usage.output_tokens,
                                           "cache_read": getattr(msg.usage, "cache_read_input_tokens", 0)})
            if msg.stop_reason == "pause_turn":
                continue
            tool_uses = [b for b in msg.content if b.type == "tool_use"]
            if msg.stop_reason == "refusal":
                await self.emit({"type": "error", "message": "模型拒絕了這個請求（安全政策）。請換個說法。"})
                break
            if msg.stop_reason == "max_tokens" and tool_uses:
                await self.emit({"type": "error", "message": "輸出被截斷，請再送一次。"})
                break
            if not tool_uses:
                break
            results = []
            for tu in tool_uses:
                results.append(await self._run_tool(tu))
            messages.append({"role": "user", "content": results})
            await self.store.save_message(self.project_id, "user", results)
        await self.emit({"type": "done"})

    async def _credit_note(self) -> dict:
        """Operator note with the live credit state, appended (not persisted) to every request."""
        st = await self.store.credit_state(self.project_id)
        if st["in_free"]:
            left = st["free_revisions_left"]
            txt = "免費專案，目前在免費額度內" + (f"，免費修改還剩 {left} 輪" if left is not None else "（第一版尚未輸出）") + \
                  f"。餘額 {st['balance']} 點。"
        else:
            txt = f"本專案照價目扣點。餘額 {st['balance']} 點。"
        self._state_txt = txt
        return {"role": "system", "content": f"[點數狀態] {txt}"}

    async def _stream_once(self, messages):
        if not self._state_as_system:  # model rejected role=system mid-conversation: fold into the prompt
            messages = messages[:-1]
        kwargs = dict(
            model=config.ANTHROPIC_MODEL, max_tokens=32000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}]
            + ([] if self._state_as_system else [{"type": "text", "text": f"[點數狀態] {self._state_txt}"}]),
            tools=_tools(), messages=messages,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": config.ANTHROPIC_EFFORT},
        )
        # Server-side refusal fallback: re-run on a fallback model if a safeguard declines.
        fb = dict(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        try:
            return await self._consume(self.client.beta.messages.stream(**kwargs, **fb))
        except anthropic.BadRequestError as e:
            s = str(e).lower()
            if "role" in s and "system" in s and self._state_as_system:
                log.warning("mid-conversation system message rejected; folding state into system prompt")
                self._state_as_system = False
                return await self._stream_once(messages)
            if "fallback" not in s:
                raise
            log.warning("fallbacks rejected, retrying without: %s", e)
            return await self._consume(self.client.messages.stream(**kwargs))

    async def _consume(self, stream_cm):
        async with stream_cm as stream:
            async for event in stream:
                et = event.type
                if et == "content_block_start" and event.content_block.type == "tool_use":
                    await self.emit({"type": "tool_start", "name": event.content_block.name})
                elif et == "content_block_delta":
                    d = event.delta
                    if d.type == "text_delta":
                        await self.emit({"type": "text", "text": d.text})
                    elif d.type == "thinking_delta" and d.thinking:
                        await self.emit({"type": "thinking", "text": d.thinking})
            return await stream.get_final_message()

    async def _run_tool(self, tu) -> dict:
        t0 = time.time()
        await self.emit({"type": "tool_run", "name": tu.name, "input": _brief(tu.input)})
        try:
            inp = tu.input if isinstance(tu.input, dict) else json.loads(tu.input)
            cost = tool_cost(tu.name, inp)
            charged, bal = await self.store.charge(self.project_id, cost, tu.name)
            if not charged:
                await self.emit({"type": "need_credits", "needed": cost, "balance": bal})
                content = [{"type": "text", "text": f"點數不足：此動作需 {cost} 點，目前餘額 {bal} 點。"
                                                    "請用戶按側欄「儲值」，儲值後說「繼續」再執行。"}]
                ok = False
            else:
                if cost:
                    await self.emit({"type": "credits", "balance": bal, "charged": cost, "tool": tu.name})
                content = await asyncio.to_thread(dispatch, tu.name, inp, self.ctx)
                ok = True
                if tu.name == "export_video":
                    await self.store.note_export(self.project_id)
        except Exception as e:  # tool failures go back to the model, not the user
            log.exception("tool %s failed", tu.name)
            content, ok = [{"type": "text", "text": f"錯誤：{type(e).__name__}: {str(e)[:1200]}"}], False
        await self.emit({"type": "tool_end", "name": tu.name, "ok": ok, "seconds": round(time.time() - t0, 1),
                         "summary": next((b["text"][:300] for b in content if b["type"] == "text"), "")})
        return {"type": "tool_result", "tool_use_id": tu.id, "content": content, "is_error": not ok}


def _brief(inp) -> str:
    s = json.dumps(inp, ensure_ascii=False)
    return s if len(s) < 200 else s[:200] + "…"


def new_id() -> str:
    return uuid.uuid4().hex[:12]
