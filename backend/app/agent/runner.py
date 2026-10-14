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
from .prompt import SYSTEM
from .tools import ToolContext, TOOLS, dispatch

log = logging.getLogger("agent")

# USD per million tokens for the default model (Claude Opus 5.5).
PRICE = {"input": 4.0, "output": 20.0, "cache_read": 0.20, "cache_write": 5.0}
Emit = Callable[[dict], Awaitable[None]]


def _tools_strict() -> list[dict]:
    return [{**t, "strict": True} for t in TOOLS]


def _cost(u) -> float:
    return ((u.input_tokens or 0) * PRICE["input"] + (u.output_tokens or 0) * PRICE["output"]
            + (getattr(u, "cache_read_input_tokens", 0) or 0) * PRICE["cache_read"]
            + (getattr(u, "cache_creation_input_tokens", 0) or 0) * PRICE["cache_write"]) / 1e6


class TurnRunner:
    def __init__(self, project_id: str, root: Path, store, emit: Emit):
        """store: object with async load_messages(), save_message(role, content), add_asset(...),
        record_usage(...) — implemented in app.db."""
        self.project_id, self.root, self.store, self.emit = project_id, root, store, emit
        self.client = anthropic.AsyncAnthropic()
        self.ctx = ToolContext(root=root, add_asset=self._add_asset_sync, record_usage=self._usage_sync)
        self._loop = asyncio.get_event_loop()
        self.cancelled = False

    # Tools run in a worker thread; these bridge back to the async store.
    def _add_asset_sync(self, path, kind, name, meta=None):
        fut = asyncio.run_coroutine_threadsafe(self.store.add_asset(self.project_id, path, kind, name, meta), self._loop)
        a = fut.result()
        asyncio.run_coroutine_threadsafe(self.emit({"type": "asset", "asset": a}), self._loop).result()
        return a

    def _usage_sync(self, kind, units, meta=None):
        asyncio.run_coroutine_threadsafe(self.store.record_usage(self.project_id, kind, units, 0.0, meta), self._loop).result()

    async def run(self, user_blocks: list[dict]) -> None:
        messages = await self.store.load_messages(self.project_id)
        messages.append({"role": "user", "content": user_blocks})
        await self.store.save_message(self.project_id, "user", user_blocks)
        for _round in range(40):  # hard cap on tool rounds per turn
            if self.cancelled:
                break
            msg = await self._stream_once(messages)
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

    async def _stream_once(self, messages):
        kwargs = dict(
            model=config.ANTHROPIC_MODEL, max_tokens=32000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            tools=_tools_strict(), messages=messages,
            thinking={"type": "adaptive", "display": "summarized"},
            output_config={"effort": config.ANTHROPIC_EFFORT},
        )
        # Server-side refusal fallback: re-run on a fallback model if a safeguard declines.
        fb = dict(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        try:
            return await self._consume(self.client.beta.messages.stream(**kwargs, **fb))
        except anthropic.BadRequestError as e:
            if "fallback" not in str(e).lower():
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
            content = await asyncio.to_thread(dispatch, tu.name, inp, self.ctx)
            ok = True
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
