"""Drive TurnRunner with a fake Anthropic client: tool_use → dispatch → tool_result → end_turn."""
import asyncio
import os
from pathlib import Path
from types import SimpleNamespace as NS

os.environ.setdefault("DATA_DIR", "/tmp/lk-test-data")

from app.agent import runner as R  # noqa: E402


class Block:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def model_dump(self, exclude_none=True):
        return dict(self.__dict__)


class FakeStream:
    def __init__(self, final):
        self.final = final

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        async def gen():
            yield NS(type="content_block_delta", delta=NS(type="text_delta", text="hi "))
        return gen()

    async def get_final_message(self):
        return self.final


class FakeStore:
    def __init__(self):
        self.saved, self.usage, self.assets = [], [], []

    async def load_messages(self, pid):
        return []

    async def save_message(self, pid, role, content):
        self.saved.append((role, content))

    async def add_asset(self, pid, path, kind, name, meta=None):
        self.assets.append(name)
        return {"id": "a1", "kind": kind, "name": name, "url": "/x"}

    async def record_usage(self, pid, kind, units, cost, meta):
        self.usage.append((kind, units, cost))


def test_tool_round_trip(monkeypatch, tmp_path: Path):
    usage = NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=0, cache_creation_input_tokens=0)
    turns = [
        NS(stop_reason="tool_use", usage=usage, content=[
            Block(type="text", text="先看素材"),
            Block(type="tool_use", id="t1", name="probe_footage", input={})]),
        NS(stop_reason="end_turn", usage=usage, content=[Block(type="text", text="沒有素材，請上傳。")]),
    ]
    calls = {"n": 0}

    def fake_stream(**kw):
        assert kw["tools"][0]["strict"] is True
        assert "fallbacks" in kw
        calls["n"] += 1
        return FakeStream(turns[calls["n"] - 1])

    events = []

    async def emit(ev):
        events.append(ev)

    store = FakeStore()
    monkeypatch.setattr(R.anthropic, "AsyncAnthropic", lambda: NS(beta=NS(messages=NS(stream=fake_stream)), messages=NS(stream=None)))

    async def main():
        tr = R.TurnRunner("p1", tmp_path, store, emit)
        for s in ("raw", "sheets/thumbs", "work"):
            (tmp_path / s).mkdir(parents=True, exist_ok=True)
        await tr.run([{"type": "text", "text": "開始"}])

    asyncio.run(main())
    roles = [r for r, _ in store.saved]
    assert roles == ["user", "assistant", "user", "assistant"]
    tool_result = store.saved[2][1][0]
    assert tool_result["type"] == "tool_result" and tool_result["tool_use_id"] == "t1"
    assert "沒有影片" in tool_result["content"][0]["text"]  # probe on empty dir
    assert [e["type"] for e in events if e["type"] in ("tool_run", "tool_end", "done")] == ["tool_run", "tool_end", "done"]
    assert len(store.usage) == 2 and store.usage[0][2] > 0
