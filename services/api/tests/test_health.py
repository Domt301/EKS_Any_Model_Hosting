"""Health endpoint tests."""
from __future__ import annotations

import httpx


def test_live_returns_200_and_does_not_call_vllm(app_client):
    resp = app_client.get("/health/live")
    assert resp.status_code == 200
    assert resp.json() == {"status": "live"}
    # No upstream route registered; assert nothing was sent to vLLM.
    assert app_client.respx.calls.call_count == 0


def test_ready_200_when_upstream_reachable(app_client):
    app_client.respx.get("/health").mock(return_value=httpx.Response(200))
    resp = app_client.get("/health/ready")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_ready_503_when_upstream_unreachable(app_client):
    app_client.respx.get("/health").mock(side_effect=httpx.ConnectError("down"))
    app_client.respx.get("/v1/models").mock(side_effect=httpx.ConnectError("down"))
    resp = app_client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json()["status"] == "not_ready"


def test_metrics_endpoint_no_auth(app_client):
    resp = app_client.get("/metrics")
    assert resp.status_code == 200
    assert b"api_requests_total" in resp.content
