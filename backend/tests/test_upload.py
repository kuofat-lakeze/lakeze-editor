"""Chunked upload: begin → chunks (with a retried chunk) → complete lands the file in raw/uploads."""
import os
from pathlib import Path
from types import SimpleNamespace as NS

os.environ.setdefault("DATA_DIR", "/tmp/lk-test-data")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main as M  # noqa: E402
from app.auth import current_user  # noqa: E402


@pytest.fixture
def client(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(M, "project_dir", lambda pid: (tmp_path / pid).mkdir(parents=True, exist_ok=True) or (tmp_path / pid))

    async def own(pid, user):
        return NS(id=pid)
    monkeypatch.setattr(M, "_own", own)
    M.app.dependency_overrides[current_user] = lambda: NS(id="u1")
    yield TestClient(M.app)  # no `with`: skips lifespan (db, fonts)
    M.app.dependency_overrides.clear()


def test_chunked_upload_roundtrip(client, tmp_path: Path):
    data = bytes(range(256)) * 40  # 10240 bytes
    r = client.post("/api/projects/p1/upload/begin", json={"name": "IMG 0001.MOV", "size": len(data)})
    assert r.status_code == 200, r.text
    uid = r.json()["upload_id"]
    chunk = 4096
    for off in range(0, len(data), chunk):
        r = client.put(f"/api/projects/p1/upload/{uid}/chunk?offset={off}", content=data[off:off + chunk])
        assert r.status_code == 200, r.text
    # a retried chunk (response lost on a phone) is harmless
    r = client.put(f"/api/projects/p1/upload/{uid}/chunk?offset=4096", content=data[4096:8192])
    assert r.json()["received"] == len(data)
    r = client.post(f"/api/projects/p1/upload/{uid}/complete")
    assert r.status_code == 200, r.text
    assert r.json()["saved"][0]["name"] == "IMG_0001.MOV"
    assert (tmp_path / "p1/raw/uploads/IMG_0001.MOV").read_bytes() == data
    assert not list((tmp_path / "p1/raw/uploads/.part").iterdir())
    # same name again gets a suffix instead of overwriting
    uid2 = client.post("/api/projects/p1/upload/begin", json={"name": "IMG 0001.MOV", "size": 3}).json()["upload_id"]
    client.put(f"/api/projects/p1/upload/{uid2}/chunk?offset=0", content=b"abc")
    assert client.post(f"/api/projects/p1/upload/{uid2}/complete").json()["saved"][0]["name"] == "IMG_0001_2.MOV"


def test_chunked_upload_guards(client):
    too_big = (M.config.MAX_UPLOAD_MB << 20) + 1
    assert client.post("/api/projects/p1/upload/begin", json={"name": "a.mp4", "size": too_big}).status_code == 413
    uid = client.post("/api/projects/p1/upload/begin", json={"name": "a.mp4", "size": 10}).json()["upload_id"]
    assert client.put(f"/api/projects/p1/upload/{uid}/chunk?offset=5", content=b"x").status_code == 409  # gap
    assert client.post(f"/api/projects/p1/upload/{uid}/complete").status_code == 409  # incomplete
    assert client.put(f"/api/projects/p1/upload/{uid}/chunk?offset=0", content=b"x" * 11).status_code == 413  # over-announced
    assert client.post(f"/api/projects/p1/upload/{uid}/complete").status_code == 404  # state dropped
    assert client.post("/api/projects/p2/upload/begin", json={"name": "a.mp4", "size": 10}).status_code == 200
    # another project can't touch it
    uid = client.post("/api/projects/p2/upload/begin", json={"name": "a.mp4", "size": 10}).json()["upload_id"]
    assert client.put(f"/api/projects/p1/upload/{uid}/chunk?offset=0", content=b"x").status_code == 404
