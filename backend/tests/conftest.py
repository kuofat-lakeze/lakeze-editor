import pytest


@pytest.fixture(autouse=True)
def _no_railway(monkeypatch):
    """Railway's billing API is not reachable from tests: hosting cost is zero unless a test says otherwise."""
    from app import railway_cost

    async def zero(days):
        return {"ok": True, "usd": 0.0, "usage_usd": 0.0, "month_estimate_usd": 0.0, "month_bill_usd": 0.0, "plan_fee_usd": 0.0, "items": []}
    monkeypatch.setattr(railway_cost, "cost", zero)
