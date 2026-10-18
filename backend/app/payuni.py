"""統一金流 PAYUNi: the integrated payment page (UPP) for card and ATM virtual account, with the e-invoice
issued by PAYUNi on the same trade.

Envelope (same as PAYUNi's official PHP/.NET SDK):
  EncryptInfo = hex( base64(AES-256-GCM(urlencode(fields), key=HashKey, iv=HashIV)) + ":::" + base64(tag) )
  HashInfo    = upper( sha256(HashKey + EncryptInfo + HashIV) )
The browser posts {MerID, Version, EncryptInfo, HashInfo} to /api/upp; PAYUNi posts the same envelope back to
ReturnURL (the buyer's browser) and NotifyURL (server to server). Only NotifyURL credits an order.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
from datetime import date, timedelta
from urllib.parse import parse_qsl, urlencode

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import config

VERSION = "1.0"
PAYMENT_TYPES = {"1": "信用卡", "2": "ATM 轉帳", "3": "超商代碼", "6": "愛金卡", "7": "AFTEE", "9": "LINE Pay"}


def configured() -> bool:
    return bool(config.PAYUNI_MER_ID and config.PAYUNI_HASH_KEY and config.PAYUNI_HASH_IV)


def endpoint(path: str = "upp") -> str:
    return f"https://{'sandbox-' if config.PAYUNI_SANDBOX else ''}api.payuni.com.tw/api/{path}"


def _key() -> bytes:
    return config.PAYUNI_HASH_KEY.strip().encode()


def _iv() -> bytes:
    return config.PAYUNI_HASH_IV.strip().encode()


def encrypt(fields: dict) -> str:
    plain = urlencode({k: v for k, v in fields.items() if v is not None}).encode()
    ct_tag = AESGCM(_key()).encrypt(_iv(), plain, None)   # cryptography appends the 16-byte tag
    ct, tag = ct_tag[:-16], ct_tag[-16:]
    return (base64.b64encode(ct) + b":::" + base64.b64encode(tag)).hex()


def decrypt(enc: str) -> dict:
    raw = bytes.fromhex(enc.strip())
    ct_b64, tag_b64 = raw.split(b":::", 1)
    plain = AESGCM(_key()).decrypt(_iv(), base64.b64decode(ct_b64) + base64.b64decode(tag_b64), None)
    return dict(parse_qsl(plain.decode(), keep_blank_values=True))


def hash_info(enc: str) -> str:
    return hashlib.sha256(_key() + enc.encode() + _iv()).hexdigest().upper()


def mer_trade_no(order_id: str) -> str:
    """PAYUNi wants ≤25 chars of [A-Za-z0-9_], not all digits / all letters: prefix our hex id."""
    return f"TC{order_id}"


def order_id(mer_trade_no: str) -> str:
    return mer_trade_no[2:] if mer_trade_no.startswith("TC") else mer_trade_no


def upp_form(*, order_id_: str, amount: int, desc: str, email: str, method: str, return_url: str, notify_url: str, back_url: str) -> dict:
    """What the browser posts to PAYUNi's payment page. method: card | atm."""
    fields = {
        "MerID": config.PAYUNI_MER_ID, "MerTradeNo": mer_trade_no(order_id_), "TradeAmt": int(amount),
        "Timestamp": int(time.time()), "ProdDesc": desc[:50], "UsrMail": email, "Lang": "zh-tw",
        "ReturnURL": return_url, "NotifyURL": notify_url, "BackURL": back_url,
    }
    if method == "atm":
        fields["ATM"] = 1
        fields["ExpireDate"] = (date.today() + timedelta(days=config.PAYUNI_ATM_DAYS)).isoformat()
    else:
        fields["Credit"] = 1
    if config.PAYUNI_INVOICE:
        fields["TradeInvoice"] = 1
    enc = encrypt(fields)
    return {"action": endpoint("upp"), "fields": {"MerID": config.PAYUNI_MER_ID, "Version": VERSION, "EncryptInfo": enc, "HashInfo": hash_info(enc)}}


class Invalid(Exception):
    pass


def parse_result(form: dict) -> dict:
    """Verify and open a ReturnURL / NotifyURL post. Returns the decrypted fields plus the envelope Status."""
    enc, h = form.get("EncryptInfo", ""), form.get("HashInfo", "")
    if not enc or not h:
        raise Invalid(f"missing EncryptInfo/HashInfo (Status={form.get('Status', '')})")
    if not hmac.compare_digest(hash_info(enc), h.upper()):
        raise Invalid("hash mismatch")
    try:
        data = decrypt(enc)
    except Exception as e:
        raise Invalid(f"decrypt failed: {type(e).__name__}")
    data.setdefault("Status", form.get("Status", ""))
    if form.get("MerID") and form["MerID"] != config.PAYUNI_MER_ID:
        raise Invalid("wrong merchant")
    return data


def atm_info(d: dict) -> dict | None:
    """The virtual account to pay into, from a TradeStatus=0 (number issued) ATM result."""
    if d.get("PaymentType") != "2" or not d.get("PayNo"):
        return None
    return {"bank": d.get("BankType", ""), "account": d.get("PayNo", ""), "expire": d.get("ExpireDate", "")}


def invoice_info(d: dict) -> dict | None:
    if not d.get("InvoiceNo"):
        return None
    return {"no": d.get("InvoiceNo"), "random": d.get("InvoiceRandom", ""), "time": d.get("InvoiceTime", ""), "type": d.get("InvoiceInfo", "")}
