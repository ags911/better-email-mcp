"""Regression tests for the live Cloudflare flow harness."""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

_SCRIPT = Path(__file__).with_name("cf_full_flow.py")
_SPEC = importlib.util.spec_from_file_location("cf_full_flow", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


class _FakeResponse:
    def __init__(self, *, status_code=200, headers=None, body=None, text=""):
        self.status_code = status_code
        self.headers = headers or {}
        self._body = body
        self.text = text

    def json(self):
        return self._body


class _FakeHttpError(Exception):
    pass


class _FakeCookie:
    name = "session"
    value = "cookie-secret"
    domain = "example.invalid"
    path = "/"


class _FakeCookies:
    def __init__(self):
        self.jar: list = [_FakeCookie()]

    def set(self, name, value, **kwargs):
        self.jar.append(SimpleNamespace(name=name, value=value, domain=kwargs.get("domain"), path=kwargs.get("path", "/")))


class _FakeClient:
    def __init__(self, calls):
        self.calls = calls
        self.status_polls = 0
        self.cookies = _FakeCookies()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        if url.endswith("/authorize"):
            return _FakeResponse(
                headers={"location": "https://example.invalid/login?next=gate"},
            )
        if "/authorize?nonce=" in url:
            return _FakeResponse(
                body=None,
                text='<form action="/authorize?nonce=nonce"><input name="EMAIL_CREDENTIALS"></form>',
            )
        if url.endswith("/setup-status"):
            self.status_polls += 1
            return _FakeResponse(
                body={"gdrive": "idle", "outlook": "complete"}
                if self.status_polls > 1
                else {"gdrive": "idle", "outlook": "pending"},
            )
        raise AssertionError(f"unexpected GET {url}")

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if url.endswith("/register"):
            return _FakeResponse(body={"client_id": "local-browser"})
        if url.endswith("/login"):
            return _FakeResponse(headers={"location": "/authorize?nonce=nonce"})
        if url.endswith("/authorize"):
            return _FakeResponse(
                body={
                    "ok": True,
                    "redirect_url": "http://localhost:9999/cb?code=deferred-auth-code&state=st",
                    "next_step": {
                        "type": "oauth_device_code",
                        "verification_url": "https://microsoft.com/devicelogin",
                        "user_code": "ABCD-EFGH",
                        "device_code": "device-secret",
                    },
                }
            )
        if url.endswith("/token"):
            return _FakeResponse(
                body={
                    "access_token": "access-secret",
                    "refresh_token": "refresh-secret",
                    "id_token": "jwt-secret",
                }
            )
        raise AssertionError(f"unexpected POST {url}")


class _FakeHttpx:
    HTTPError = _FakeHttpError

    def __init__(self, calls):
        self.calls = calls

    def Client(self, **kwargs):
        return _FakeClient(self.calls)


class _FakeToolTransport:
    async def __aenter__(self):
        return ("read", "write")

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeToolSession:
    def __init__(self, calls):
        self.calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def initialize(self):
        return None

    async def call_tool(self, tool, args):
        self.calls.append((tool, args))
        text = "INBOX" if tool == "folders" else "message search result"
        return SimpleNamespace(content=[SimpleNamespace(text=text)])


class CfFullFlowMcpSdkTest(unittest.TestCase):
    def test_email_credentials_selects_first_account_for_single_account_flow(self) -> None:
        canonical = "first@gmail.com:app-password,second@outlook.com:oauth-token"
        with patch.dict(
            os.environ,
            {
                "EMAIL_CREDENTIALS": canonical,
                "GMAIL_EMAIL": "stale@gmail.com",
                "GMAIL_APP_PASSWORD": "stale-password",
            },
            clear=True,
        ):
            self.assertEqual(_MODULE._email_credentials(), "first@gmail.com:app-password")

    def test_session_loads_supported_streamable_http_client(self) -> None:
        transport, client_session = asyncio.run(
            _MODULE._session("https://example.invalid", "token")
        )

        self.assertTrue(hasattr(transport, "__aenter__"))
        self.assertEqual(client_session.__name__, "ClientSession")

    def test_client_streams_accepts_current_and_legacy_transport_shapes(self) -> None:
        self.assertEqual(
            _MODULE._client_streams(("read", "write")), ("read", "write")
        )
        self.assertEqual(
            _MODULE._client_streams(("read", "write", "legacy")),
            ("read", "write"),
        )

    def test_outlook_email_prefers_injected_value_without_reading_credentials(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OUTLOOK_EMAIL": "user@company.example",
                "EMAIL_CREDENTIALS": "user@outlook.com:secret-password",
            },
            clear=True,
        ):
            self.assertEqual(_MODULE._outlook_email(), "user@company.example")

    def test_outlook_email_falls_back_to_outlook_shaped_entry(self) -> None:
        with patch.dict(
            os.environ,
            {
                "EMAIL_CREDENTIALS": "first@gmail.com:one,user@hotmail.com:two",
            },
            clear=True,
        ):
            self.assertEqual(_MODULE._outlook_email(), "user@hotmail.com")

    def test_parse_outlook_next_step_is_strict_and_secret_free(self) -> None:
        self.assertEqual(
            _MODULE._parse_outlook_next_step(
                {
                    "next_step": {
                        "type": "oauth_device_code",
                        "verification_url": "https://microsoft.com/devicelogin",
                        "user_code": "ABCD-EFGH",
                        "device_code": "device-secret",
                    }
                }
            ),
            ("https://microsoft.com/devicelogin", "ABCD-EFGH"),
        )
        with self.assertRaisesRegex(RuntimeError, "oauth_device_code"):
            _MODULE._parse_outlook_next_step({"next_step": {"type": "other"}})

    def test_outlook_flow_polls_before_deferred_token_exchange_and_redacts_secrets(self) -> None:
        calls = []
        fake_httpx = _FakeHttpx(calls)
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.dict(os.environ, {"RELAY_PW": "test-relay-password"}), patch.object(
            _MODULE.time, "sleep", lambda _seconds: None
        ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            token = _MODULE._get_token_once(
                fake_httpx,
                "https://example.invalid",
                {"EMAIL_CREDENTIALS": "user@outlook.com:"},
                wait_for_device_code=True,
            )

        self.assertEqual(token, "access-secret")
        authorize_posts = [call for call in calls if call[0] == "POST" and "/authorize" in call[1]]
        self.assertEqual(authorize_posts[0][2]["json"], {"EMAIL_CREDENTIALS": "user@outlook.com:"})
        poll_indices = [index for index, call in enumerate(calls) if call[1].endswith("/setup-status")]
        token_index = next(index for index, call in enumerate(calls) if call[1].endswith("/token"))
        self.assertTrue(poll_indices)
        self.assertGreater(token_index, poll_indices[-1])
        self.assertIn("verification_url: https://microsoft.com/devicelogin", stdout.getvalue())
        self.assertIn("user_code: ABCD-EFGH", stdout.getvalue())
        self.assertIn("[poll]", stderr.getvalue())
        combined_output = stdout.getvalue() + stderr.getvalue()
        for secret in ("device-secret", "access-secret", "refresh-secret", "jwt-secret"):
            self.assertNotIn(secret, combined_output)

    def test_outlook_start_exits_after_printing_code_and_resume_uses_saved_state(self) -> None:
        calls = []
        fake_httpx = _FakeHttpx(calls)
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"OUTLOOK_EMAIL": "user@outlook.com", "RELAY_PW": "test-relay-password"}, clear=True
        ), contextlib.redirect_stdout(stdout):
            state_path = Path(tmp) / "outlook-state.json"
            _MODULE._begin_outlook_device_code(fake_httpx, "https://example.invalid", state_path)
            state = json.loads(state_path.read_text(encoding="utf-8"))

            self.assertEqual(state["version"], 1)
            self.assertEqual(state["endpoint"], "https://example.invalid")
            self.assertEqual(state["authorization_code"], "deferred-auth-code")
            self.assertFalse(any(call[1].endswith("/setup-status") for call in calls))
            self.assertIn("user_code: ABCD-EFGH", stdout.getvalue())
            self.assertNotIn("device-secret", stdout.getvalue())

            with patch.object(_MODULE.time, "sleep", lambda _seconds: None):
                token = _MODULE._resume_outlook_token(fake_httpx, "https://example.invalid", state_path)

        self.assertEqual(token, "access-secret")
        self.assertFalse(state_path.exists())

    def test_outlook_flag_is_mutually_exclusive_with_existing_modes(self) -> None:
        with self.assertRaises(SystemExit):
            _MODULE.build_parser().parse_args(["--outlook", "--tools"])
        args = _MODULE.build_parser().parse_args(["--outlook-start", "--outlook-state", "state.json"])
        self.assertTrue(args.outlook_start)
        self.assertEqual(args.outlook_state, "state.json")

    def test_run_outlook_uses_exact_credential_shape_and_read_only_tools(self) -> None:
        tool_calls = []
        fake_session = _FakeToolSession(tool_calls)

        async def fake_transport(_endpoint, _token):
            return _FakeToolTransport(), lambda *_streams: fake_session

        with patch.dict(os.environ, {"OUTLOOK_EMAIL": "user@outlook.com"}, clear=True), patch.object(
            _MODULE, "get_token", return_value="internal-token"
        ) as get_token, patch.object(_MODULE, "_session", new=AsyncMock(side_effect=fake_transport)):
            asyncio.run(_MODULE.run_outlook("https://example.invalid"))

        get_token.assert_called_once_with(
            "https://example.invalid",
            {"EMAIL_CREDENTIALS": "user@outlook.com:"},
            wait_for_device_code=True,
        )
        self.assertEqual(
            tool_calls,
            [
                ("folders", {"action": "list"}),
                ("messages", {"action": "search", "query": "ALL", "limit": 2}),
            ],
        )


if __name__ == "__main__":
    unittest.main()
