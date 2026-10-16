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

    balance_points = 100
    charges: list = []

    async def credit_state(self, pid):
        return {"balance": self.balance_points, "free_project": False, "in_free": False,
                "free_revisions_left": None, "exports": self.exports}

    revisions = 0
    exports = 0

    async def note_revision_turn(self, pid):
        self.revisions += 1
        return await self.charge(pid, 4, "revision_turn")

    async def storage_state(self):
        return {"used_bytes": 0, "quota_bytes": 2 << 30, "over": False, "plan": "free", "renews_at": None}

    async def charge(self, pid, points, reason):
        if points > self.balance_points:
            return False, self.balance_points
        self.balance_points -= points
        self.charges.append((reason, points))
        return True, self.balance_points

    async def note_export(self, pid):
        pass


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
        assert "strict" not in kw["tools"][0]  # strict schemas are capped at 24 optional params
        assert "fallbacks" in kw
        assert kw["messages"][-1]["role"] == "system" and "點數" in kw["messages"][-1]["content"]
        calls["n"] += 1
        return FakeStream(turns[calls["n"] - 1])

    events = []

    async def emit(ev):
        events.append(ev)

    store = FakeStore()
    monkeypatch.setattr(R.anthropic, "AsyncAnthropic", lambda **kw: NS(beta=NS(messages=NS(stream=fake_stream)), messages=NS(stream=None)))

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
    assert store.charges == [("probe_footage", 14)] and store.balance_points == 86
    assert any(e["type"] == "credits" and e["balance"] == 86 for e in events)


def test_insufficient_credits(monkeypatch, tmp_path: Path):
    usage = NS(input_tokens=1, output_tokens=1, cache_read_input_tokens=0, cache_creation_input_tokens=0)
    turns = [
        NS(stop_reason="tool_use", usage=usage, content=[Block(type="tool_use", id="t1", name="make_cover", input={"clip": 1, "t": 0, "title": ["x"]})]),
        NS(stop_reason="end_turn", usage=usage, content=[Block(type="text", text="請儲值")]),
    ]
    it = iter(turns)
    monkeypatch.setattr(R.anthropic, "AsyncAnthropic",
                        lambda **_kw: NS(beta=NS(messages=NS(stream=lambda **kw: FakeStream(next(it)))), messages=NS(stream=None)))
    store = FakeStore()
    store.balance_points = 2
    events = []

    async def emit(ev):
        events.append(ev)

    asyncio.run(R.TurnRunner("p1", tmp_path, store, emit).run([{"type": "text", "text": "封面"}]))
    tr = store.saved[2][1][0]
    assert tr["is_error"] and "點數不足" in tr["content"][0]["text"]
    assert any(e["type"] == "need_credits" and e["needed"] == 5 for e in events)
    assert store.balance_points == 2


def test_revision_turn_counted_once_and_only_with_tool_work(monkeypatch, tmp_path: Path):
    """After the first export, a turn consumes a revision only if it runs a chargeable tool, and only once."""
    usage = NS(input_tokens=1, output_tokens=1, cache_read_input_tokens=0, cache_creation_input_tokens=0)

    def run_turn(turns, store):
        it = iter(turns)
        monkeypatch.setattr(R.anthropic, "AsyncAnthropic",
                            lambda **kw: NS(beta=NS(messages=NS(stream=lambda **k: FakeStream(next(it)))), messages=NS(stream=None)))
        asyncio.run(R.TurnRunner("p1", tmp_path, store, lambda ev: asyncio.sleep(0)).run([{"type": "text", "text": "改"}]))

    store = FakeStore()
    store.exports = 1
    # question-only turn: no revision consumed
    run_turn([NS(stop_reason="end_turn", usage=usage, content=[Block(type="text", text="要改哪裡？")])], store)
    assert store.revisions == 0
    # a turn with two chargeable tools counts exactly one revision
    run_turn([
        NS(stop_reason="tool_use", usage=usage, content=[Block(type="tool_use", id="t1", name="probe_footage", input={})]),
        NS(stop_reason="tool_use", usage=usage, content=[Block(type="tool_use", id="t2", name="probe_footage", input={})]),
        NS(stop_reason="end_turn", usage=usage, content=[Block(type="text", text="好了")]),
    ], store)
    assert store.revisions == 1
    assert [c for c in store.charges if c[0] == "revision_turn"] == [("revision_turn", 4)]  # the per-turn fee, once
    # before the first export nothing is counted even with tool work
    store2 = FakeStore()
    run_turn([
        NS(stop_reason="tool_use", usage=usage, content=[Block(type="tool_use", id="t1", name="probe_footage", input={})]),
        NS(stop_reason="end_turn", usage=usage, content=[Block(type="text", text="ok")]),
    ], store2)
    assert store2.revisions == 0
