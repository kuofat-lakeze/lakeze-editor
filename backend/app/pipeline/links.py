"""Any shared cloud link → a list of downloadable media files.

Supported: Google Drive (folder or single file), Dropbox (file or folder), iCloud Drive file links,
iCloud Photos shared albums, OneDrive / 1drv.ms (file or folder), and plain direct links to a video
or photo. Every resolver returns [{id, path, url, size?, zip?}] where `url` downloads the bytes
without a login; `zip` marks a folder archive (Dropbox) that is unpacked after download.
"""
import base64
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urlparse, urlunparse

import requests

MEDIA_EXT = (".mp4", ".mov", ".m4v", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"}


class LinkError(ValueError):
    """A message meant for the user (Traditional Chinese)."""


def provider(url: str) -> str:
    h = urlparse(url.strip()).netloc.lower()
    if "drive.google.com" in h or "docs.google.com" in h:
        return "google"
    if "dropbox.com" in h:
        return "dropbox"
    if "icloud.com" in h:
        return "icloud"
    if "1drv.ms" in h or "onedrive.live.com" in h or "sharepoint.com" in h:
        return "onedrive"
    return "direct"


LABEL = {"google": "Google 雲端硬碟", "dropbox": "Dropbox", "icloud": "iCloud", "onedrive": "OneDrive", "direct": "網址"}


def _is_media(name: str) -> bool:
    return Path(name.split("?")[0]).suffix.lower() in MEDIA_EXT


def _safe(name: str) -> str:
    name = re.sub(r"[\\/:*?\"<>|\s]+", "_", unquote(name)).strip("._") or "clip"
    return name[:120]


# ---- Google -------------------------------------------------------------------------------------
GDRIVE_DL = "https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t"


def _google(url: str, root: Path) -> list[dict]:
    from . import footage
    if re.search(r"/folders/[\w-]+", url):
        items = footage.list_drive_folder(url, root)
        return [{**it, "url": GDRIVE_DL.format(id=it["id"])} for it in items]
    m = re.search(r"/file/d/([\w-]+)", url) or re.search(r"[?&]id=([\w-]+)", url)
    if not m:
        raise LinkError("這個 Google 連結不是檔案或資料夾的分享連結")
    fid = m.group(1)
    name = f"gdrive_{fid[:8]}.mp4"
    try:   # the file name comes back in the download headers
        r = requests.get(GDRIVE_DL.format(id=fid), headers=UA, stream=True, timeout=30, allow_redirects=True)
        cd = r.headers.get("content-disposition", "")
        r.close()
        if r.status_code >= 400 or "text/html" in r.headers.get("content-type", ""):
            raise LinkError("打不開這個檔案。請把分享設定改成「知道連結的使用者」都能檢視。")
        n = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)", cd)
        if n:
            name = _safe(n.group(1))
    except requests.RequestException:
        pass
    return [{"id": fid, "path": name, "url": GDRIVE_DL.format(id=fid)}]


# ---- Dropbox ------------------------------------------------------------------------------------
def _dropbox(url: str, root: Path) -> list[dict]:
    p = urlparse(url)
    q = parse_qs(p.query)
    q["dl"] = ["1"]
    dl = urlunparse(p._replace(query=urlencode({k: v[0] for k, v in q.items()})))
    folder = "/fo/" in p.path or "/sh/" in p.path or "/scl/fo/" in p.path
    if folder:
        return [{"id": "dropbox", "path": "dropbox_folder.zip", "url": dl, "zip": True}]
    name = _safe(Path(unquote(p.path)).name or "dropbox_clip.mp4")
    return [{"id": "dropbox", "path": name, "url": dl}]


# ---- iCloud -------------------------------------------------------------------------------------
def _icloud(url: str, root: Path) -> list[dict]:
    if "sharedalbum" in url:
        token = url.split("#", 1)[-1].split(";")[0]
        return _icloud_album(token)
    m = re.search(r"/iclouddrive/([\w-]+)", url) or re.search(r"/attachment/\?.*?u=([^&]+)", url)
    if not m:
        raise LinkError("這個 iCloud 連結看不懂。請在「檔案」App 對檔案按分享 →「拷貝連結」，或用 iCloud 共享相簿的公開網址。")
    guid = m.group(1)
    r = requests.post("https://ckdatabasews.icloud.com/database/1/com.apple.cloudkit/production/public/records/resolve",
                      json={"shortGUIDs": [{"value": guid}]}, headers=UA, timeout=30)
    if r.status_code >= 400:
        raise LinkError("打不開這個 iCloud 連結，請確認分享設定是「任何擁有連結的人」。")
    res = (r.json().get("results") or [{}])[0]
    rec = (res.get("rootRecord") or {}).get("fields", {})
    contents = rec.get("fileContent", {}).get("value", {})
    dl = contents.get("downloadURL")
    if not dl:
        raise LinkError("iCloud 只分享了資料夾或需要登入。請改分享單一檔案，或用共享相簿的公開網址。")
    name = _safe(res.get("share", {}).get("fields", {}).get("cloudkit.title", {}).get("value") or "icloud_clip")
    ext = rec.get("extension", {}).get("value")
    if ext and not name.lower().endswith("." + ext.lower()):
        name = f"{name}.{ext}"
    return [{"id": guid, "path": name, "url": dl.replace("${f}", name), "size": contents.get("size")}]


def _icloud_album(token: str) -> list[dict]:
    """Public iCloud Photos shared album (網站公開). Two calls: the stream, then asset URLs."""
    base = "p23-sharedstreams.icloud.com"
    for _ in range(2):
        r = requests.post(f"https://{base}/{token}/sharedstreams/webstream", json={"streamCtag": None}, headers=UA, timeout=30)
        if r.status_code == 330:   # redirected to the album's own host
            base = r.json().get("X-Apple-MMe-Host", base)
            continue
        break
    if r.status_code >= 400:
        raise LinkError("打不開這個共享相簿。請在相簿設定開啟「公開網站」，再貼那個網址。")
    photos = r.json().get("photos", [])
    guids = [p["photoGuid"] for p in photos]
    if not guids:
        raise LinkError("共享相簿裡沒有照片或影片")
    r2 = requests.post(f"https://{base}/{token}/sharedstreams/webasseturls", json={"photoGuids": guids}, headers=UA, timeout=30)
    items = r2.json().get("items", {})
    out = []
    for i, p in enumerate(photos, 1):
        ders = p.get("derivatives", {})
        if p.get("mediaAssetType") == "video":
            pick = ders.get("720p") or ders.get("360p") or max(ders.values(), key=lambda d: int(d.get("fileSize", 0)))
            ext = ".mp4"
        else:
            pick = max(ders.values(), key=lambda d: int(d.get("width", 0) or 0))
            ext = ".jpg"
        loc = items.get(pick.get("checksum", ""))
        if not loc:
            continue
        out.append({"id": p["photoGuid"], "path": f"icloud_{i:02d}{ext}", "url": f"https://{loc['url_location']}{loc['url_path']}",
                    "size": int(pick.get("fileSize", 0) or 0)})
    return out


# ---- OneDrive -----------------------------------------------------------------------------------
def _onedrive(url: str, root: Path) -> list[dict]:
    share = "u!" + base64.urlsafe_b64encode(url.strip().encode()).decode().rstrip("=")
    api = f"https://api.onedrive.com/v1.0/shares/{share}/root"
    r = requests.get(api + "?expand=children", headers=UA, timeout=30)
    if r.status_code >= 400:
        raise LinkError("打不開這個 OneDrive 連結，請把分享設定改成「任何人都可以檢視」。")
    d = r.json()
    if "folder" in d:
        kids = d.get("children", [])
        return [{"id": k["id"], "path": _safe(k["name"]), "url": k.get("@content.downloadUrl") or f"{api}:/{k['name']}:/content",
                 "size": k.get("size")} for k in kids if "file" in k]
    return [{"id": d.get("id", "od"), "path": _safe(d.get("name", "onedrive_clip")), "url": d.get("@content.downloadUrl") or api + "/content",
             "size": d.get("size")}]


# ---- direct -------------------------------------------------------------------------------------
def _direct(url: str, root: Path) -> list[dict]:
    try:
        r = requests.head(url, headers=UA, timeout=20, allow_redirects=True)
        if r.status_code in (403, 405):
            r = requests.get(url, headers=UA, timeout=20, stream=True, allow_redirects=True); r.close()
    except requests.RequestException:
        raise LinkError("連不到這個網址")
    ctype = r.headers.get("content-type", "")
    name = _safe(Path(urlparse(r.url).path).name or "clip")
    if not (ctype.startswith(("video/", "image/")) or _is_media(name)):
        raise LinkError("這個網址不是影片或照片檔，也不是支援的雲端（Google 雲端、Dropbox、iCloud、OneDrive）分享連結")
    if not _is_media(name):
        name += {"video/quicktime": ".mov", "image/jpeg": ".jpg", "image/png": ".png"}.get(ctype.split(";")[0], ".mp4")
    return [{"id": "direct", "path": name, "url": url, "size": int(r.headers.get("content-length") or 0) or None}]


RESOLVERS = {"google": _google, "dropbox": _dropbox, "icloud": _icloud, "onedrive": _onedrive, "direct": _direct}


def resolve(url: str, root: Path) -> dict:
    """Resolve a share link, save the list to sheets/drive.json (what download_footage reads)."""
    url = url.strip()
    if not re.match(r"https?://", url):
        raise LinkError("請貼完整的分享網址（https:// 開頭）")
    prov = provider(url)
    items = RESOLVERS[prov](url, root)
    # dedupe names
    seen: dict[str, int] = {}
    for it in items:
        k = it["path"].lower()
        seen[k] = seen.get(k, 0) + 1
        if seen[k] > 1:
            p = Path(it["path"])
            it["path"] = str(p.with_name(f"{p.stem}_{seen[k]}{p.suffix}"))
    (root / "sheets").mkdir(parents=True, exist_ok=True)
    (root / "sheets" / "drive.json").write_text(json.dumps(items, ensure_ascii=False))
    return {"provider": prov, "label": LABEL[prov], "items": items}
