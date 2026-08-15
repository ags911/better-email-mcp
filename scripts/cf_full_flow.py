"""CF better-email-mcp live OAuth full-flow self-test harness.

Drives the deployed better-email-mcp Cloudflare Worker (Worker + Container + KV)
end-to-end against a public endpoint. better-email is a LOCAL-FORM server (like
wet/imagine, NOT delegated like notion): the /authorize gate is just the relay
password, so the whole flow is fully autonomous -- no third-party consent.

Flow (authorization_code + PKCE, DCR public client; ported from imagine's harness):
  1. DCR register   -- POST /register (RFC 7591) -> client_id
  2. password-grant -- GET /authorize -> POST /login (relay password gate) -> form
  3. save creds     -- POST /authorize?nonce=... {EMAIL_CREDENTIALS} (retry-on-500
                       for the E.1 outbound-interception race); the server VALIDATES
                       the IMAP login server-side, so a real Gmail app-password is
                       required. -> {ok, redirect_url}
  4. token          -- POST /token (code + verifier) -> bearer JWT
  5. tool call      -- config(status) + folders(list); assert the saved account is
                       resolved (no awaiting_setup / NO_ACCOUNTS / error).

Recreate gate (SUCCESS CRITERION 4 -- the whole point of the migration):
  --save-only  : run 1-4, dump the EXACT JWT (relay-login mints a random sub per
                 /authorize, so the verify half MUST replay this token).
  --auth-only  : replay the dumped JWT WITHOUT re-saving; folders(list) must still
                 resolve the account -> creds survived container delete+recreate in
                 KV (PerSubCredStore, embed in subs/<sub>/config), and the JWT still
                 verifies (EdDSA derived from CREDENTIAL_SECRET, stable across recreate).

Secrets from env (skret): EMAIL_CREDENTIALS from /better-email-mcp/prod;
relay gate password MCP_RELAY_PASSWORD (or RELAY_PW) from /oci-vm-prod/prod
(infra-shared) -- compose both namespaces.

Examples:
  skret run -e prod --path=/oci-vm-prod/prod -- \
    skret run -e prod --path=/better-email-mcp/prod -- \
      python scripts/cf_full_flow.py
  ... -- python scripts/cf_full_flow.py --save-only
  ... -- python scripts/cf_full_flow.py --auth-only
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json as _json
import os
import re
import secrets
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

# No hardcoded host: set CF_ENDPOINT or pass --endpoint https://<your-worker-domain>.
# This self-tests YOUR deployed CF server; creds come from env (MCP_RELAY_PASSWORD +
# provider keys) -- the maintainer injects them via skret, but any export works.
DEFAULT_ENDPOINT = os.environ.get("CF_ENDPOINT", "")
_OUTLOOK_DOMAINS = frozenset({"outlook.com", "hotmail.com", "live.com"})
_OUTLOOK_DEVICE_CODE_TIMEOUT = 900.0
_OUTLOOK_POLL_INTERVAL = 3.0
_OUTLOOK_PROGRESS_INTERVAL = 30.0
_OUTLOOK_STATE_VERSION = 1


def _password() -> str:
    pw = os.environ.get("RELAY_PW") or os.environ.get("MCP_RELAY_PASSWORD")
    if not pw:
        raise SystemExit(
            "MCP_RELAY_PASSWORD (or RELAY_PW) is required for the password-grant login "
            "gate. It lives in skret /oci-vm-prod/prod (infra-shared), NOT "
            "/better-email-mcp/prod -- compose both namespaces."
        )
    return pw


def _email_credentials() -> str:
    """Return the first canonical account for this single-account flow."""
    credentials = os.environ.get("EMAIL_CREDENTIALS", "").strip()
    if not credentials:
        raise SystemExit(
            "EMAIL_CREDENTIALS required (skret /better-email-mcp/prod) "
            "to save a credential -- the server validates the IMAP login on save."
        )
    first = credentials.split(",", 1)[0].strip()
    if not first:
        raise SystemExit("EMAIL_CREDENTIALS must contain at least one account.")
    return first


def _outlook_email() -> str:
    """Return the injected Outlook address without exposing its credential."""
    configured = os.environ.get("OUTLOOK_EMAIL", "").strip()
    if configured:
        if ":" in configured or "," in configured or "@" not in configured:
            raise SystemExit("OUTLOOK_EMAIL must be one email address without credentials.")
        return configured

    credentials = os.environ.get("EMAIL_CREDENTIALS", "").strip()
    extra_domains = {
        domain.strip().lower()
        for domain in os.environ.get("OUTLOOK_EXTRA_DOMAINS", "").split(",")
        if domain.strip()
    }
    for entry in credentials.split(","):
        email = entry.split(":", 1)[0].strip()
        domain = email.rsplit("@", 1)[-1].lower()
        if "@" in email and domain in _OUTLOOK_DOMAINS | extra_domains:
            return email

    raise SystemExit(
        "OUTLOOK_EMAIL required (skret /better-email-mcp/prod), or an Outlook-shaped "
        "entry must be present in EMAIL_CREDENTIALS."
    )


class _SaveRetry(Exception):
    pass


def _parse_outlook_next_step(data: dict) -> tuple[str, str]:
    """Extract only the user-facing fields from an Outlook device-code step."""
    if not isinstance(data, dict):
        raise TypeError("Outlook authorization returned an invalid response.")
    next_step = data.get("next_step")
    if not isinstance(next_step, dict) or next_step.get("type") != "oauth_device_code":
        raise RuntimeError("Outlook authorization did not return an oauth_device_code step.")

    verification_url = next_step.get("verification_url")
    user_code = next_step.get("user_code")
    if not isinstance(verification_url, str) or not verification_url.strip():
        raise RuntimeError("Outlook device-code step did not include a verification URL.")
    if not isinstance(user_code, str) or not user_code.strip():
        raise RuntimeError("Outlook device-code step did not include a user code.")
    return verification_url, user_code


def _default_outlook_state_path() -> Path:
    return Path(tempfile.gettempdir()) / f"better-email-outlook-{os.getpid()}.json"


def _cookie_snapshot(client) -> list[dict[str, str]]:
    return [
        {
            "name": cookie.name,
            "value": cookie.value,
            "domain": cookie.domain or "",
            "path": cookie.path or "/",
        }
        for cookie in client.cookies.jar
    ]


def _restore_cookies(client, cookies: list[dict[str, str]]) -> None:
    for cookie in cookies:
        domain = cookie.get("domain") or None
        if domain:
            client.cookies.set(cookie["name"], cookie["value"], domain=domain, path=cookie.get("path", "/"))
        else:
            client.cookies.set(cookie["name"], cookie["value"], path=cookie.get("path", "/"))


def _begin_outlook_device_code(httpx, endpoint: str, state_path: Path) -> None:
    """Start the provider flow, persist local PKCE state, then exit immediately.

    The deployed server owns the Microsoft device-code poll. The local state file
    only holds the deferred MCP authorization exchange and session cookies needed
    by the later ``--outlook-resume`` phase.
    """
    email = _outlook_email()
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    ru = "http://localhost:9999/cb"
    pw = _password()

    with httpx.Client(timeout=120, follow_redirects=False) as c:
        cid = c.post(
            f"{endpoint}/register",
            json={
                "client_name": "cf-verify-outlook",
                "redirect_uris": [ru],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": "offline_access",
            },
        ).json()["client_id"]
        az = c.get(
            f"{endpoint}/authorize",
            params={
                "response_type": "code",
                "client_id": cid,
                "redirect_uri": ru,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "st",
                "scope": "offline_access",
            },
        )
        nxt = urllib.parse.parse_qs(urllib.parse.urlparse(az.headers["location"]).query)["next"][0]
        lg = c.post(f"{endpoint}/login", data={"next": nxt, "password": pw})
        url = lg.headers["location"]
        url = url if url.startswith("http") else endpoint + url
        form_html = c.get(url).text
        match = re.search(r"/authorize\?nonce=([A-Za-z0-9_\-]+)", form_html)
        if not match:
            raise RuntimeError("Outlook authorize form nonce was not found.")
        sub = c.post(
            f"{endpoint}/authorize",
            params={"nonce": match.group(1)},
            json={"EMAIL_CREDENTIALS": f"{email}:"},
            timeout=120,
        )
        if sub.status_code != 200:
            raise RuntimeError(f"Outlook credential submission failed: HTTP {sub.status_code}")
        data = sub.json()
        if not data.get("ok"):
            raise RuntimeError("Outlook credential submission failed.")
        verification_url, user_code = _parse_outlook_next_step(data)
        redirect_url = data.get("redirect_url")
        if not isinstance(redirect_url, str) or not redirect_url:
            raise RuntimeError("Outlook setup did not return a deferred authorization redirect.")
        authorization_code = urllib.parse.parse_qs(urllib.parse.urlparse(redirect_url).query).get("code", [None])[0]
        if not authorization_code:
            raise RuntimeError("Outlook setup redirect did not contain a deferred authorization code.")

        state = {
            "version": _OUTLOOK_STATE_VERSION,
            "endpoint": endpoint,
            "redirect_uri": ru,
            "client_id": cid,
            "code_verifier": verifier,
            "authorization_code": authorization_code,
            "cookies": _cookie_snapshot(c),
        }
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(_json.dumps(state), encoding="utf-8")
        try:
            os.chmod(state_path, 0o600)
        except OSError:
            pass

    # The caller must see these before the short-lived upstream code can age.
    print(f"verification_url: {verification_url}", flush=True)
    print(f"user_code: {user_code}", flush=True)
    print(f"state_file: {state_path}", flush=True)


def _resume_outlook_token(httpx, endpoint: str, state_path: Path) -> str:
    """Resume one previously-started Outlook flow after the user authorizes."""
    try:
        state = _json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Cannot read Outlook state file: {state_path}") from exc
    if state.get("version") != _OUTLOOK_STATE_VERSION or state.get("endpoint") != endpoint:
        raise RuntimeError("Outlook state file is stale or belongs to another endpoint.")

    with httpx.Client(timeout=120, follow_redirects=False) as c:
        _restore_cookies(c, state.get("cookies", []))
        _poll_outlook_setup_status(httpx, c, endpoint)
        tok = c.post(
            f"{endpoint}/token",
            data={
                "grant_type": "authorization_code",
                "code": state["authorization_code"],
                "redirect_uri": state["redirect_uri"],
                "client_id": state["client_id"],
                "code_verifier": state["code_verifier"],
            },
        )
        if tok.status_code != 200:
            raise RuntimeError(f"Outlook token exchange failed: HTTP {tok.status_code}")
        access_token = tok.json().get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise RuntimeError("Outlook token exchange did not return an access token.")

    state_path.unlink(missing_ok=True)
    return access_token


def _poll_outlook_setup_status(
    httpx,
    client,
    endpoint: str,
    *,
    timeout: float = _OUTLOOK_DEVICE_CODE_TIMEOUT,
    poll_interval: float = _OUTLOOK_POLL_INTERVAL,
    progress_interval: float = _OUTLOOK_PROGRESS_INTERVAL,
) -> None:
    """Wait for the server-side Outlook poller without logging secret fields."""
    started = time.monotonic()
    deadline = started + timeout
    last_progress = started - progress_interval
    status_url = f"{endpoint}/setup-status"

    while time.monotonic() < deadline:
        status = "unavailable"
        try:
            response = client.get(status_url, timeout=5)
            if response.status_code == 200:
                body = response.json()
                outlook_status = body.get("outlook") if isinstance(body, dict) else None
                if outlook_status == "complete":
                    return
                if isinstance(outlook_status, str) and outlook_status.startswith("error:"):
                    raise RuntimeError("Outlook device-code authorization failed on the server.")
                status = outlook_status if isinstance(outlook_status, str) else "unknown"
        except httpx.HTTPError:
            pass
        except ValueError:
            status = "invalid-response"

        now = time.monotonic()
        if now - last_progress >= progress_interval:
            print(
                f"[poll] elapsed={int(now - started)}s "
                f"remaining={max(0, int(deadline - now))}s status={status}",
                file=sys.stderr,
            )
            last_progress = now
        time.sleep(poll_interval)

    raise TimeoutError(
        f"Outlook device-code setup did not complete within {int(timeout)}s ({status_url})"
    )


def get_token(
    endpoint: str,
    creds: dict[str, str],
    *,
    save_retries: int = 8,
    wait_for_device_code: bool = False,
) -> str:
    """Full OAuth flow, retrying on a transient 500 at the credential save step
    (CF Containers outbound-interception race on cold instances; E.1). Each retry
    restarts from DCR so the nonce is fresh. ``creds`` empty => re-mint a token for
    a fresh sub WITHOUT saving (not used by the recreate gate, which replays a dumped
    token instead, since relay-login mints a new sub per /authorize)."""
    import httpx  # lazy: keep --help importable without httpx

    last: Exception | None = None
    for attempt in range(save_retries):
        try:
            return _get_token_once(
                httpx,
                endpoint,
                creds,
                wait_for_device_code=wait_for_device_code,
            )
        except _SaveRetry as e:
            last = e
            print(
                f"get_token: save 500 (interception race), retry {attempt + 1}/{save_retries}"
            )
            time.sleep(3)
    raise RuntimeError(f"get_token failed after {save_retries} retries: {last}")


def _get_token_once(
    httpx,
    endpoint: str,
    creds: dict[str, str],
    *,
    wait_for_device_code: bool = False,
) -> str:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    ru = "http://localhost:9999/cb"
    pw = _password()
    with httpx.Client(timeout=120, follow_redirects=False) as c:
        cid = c.post(
            f"{endpoint}/register",
            json={
                "client_name": "cf-verify",
                "redirect_uris": [ru],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": "offline_access",
            },
        ).json()["client_id"]
        az = c.get(
            f"{endpoint}/authorize",
            params={
                "response_type": "code",
                "client_id": cid,
                "redirect_uri": ru,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "st",
                "scope": "offline_access",
            },
        )
        nxt = urllib.parse.parse_qs(
            urllib.parse.urlparse(az.headers["location"]).query
        )["next"][0]
        lg = c.post(f"{endpoint}/login", data={"next": nxt, "password": pw})
        url = lg.headers["location"]
        url = url if url.startswith("http") else endpoint + url
        form_html = c.get(url).text
        m = re.search(r"/authorize\?nonce=([A-Za-z0-9_\-]+)", form_html)
        assert m, "nonce not found in form"
        nonce = m.group(1)
        sub = c.post(
            f"{endpoint}/authorize", params={"nonce": nonce}, json=creds, timeout=120
        )
        if sub.status_code == 500 and "save credentials" in sub.text:
            raise _SaveRetry("credential save failed")
        if sub.status_code != 200:
            raise RuntimeError(f"Credential save failed: HTTP {sub.status_code}")
        data = sub.json()
        if not data.get("ok"):
            raise RuntimeError("Credential save failed.")
        if wait_for_device_code:
            verification_url, user_code = _parse_outlook_next_step(data)
            # This flow is often launched detached with stdout redirected to a log.
            # Flush the user gate immediately; waiting for process exit makes the
            # short-lived device code appear only after it has expired.
            print(f"verification_url: {verification_url}", flush=True)
            print(f"user_code: {user_code}", flush=True)
            _poll_outlook_setup_status(httpx, c, endpoint)

        redirect_url = data.get("redirect_url")
        if not isinstance(redirect_url, str) or not redirect_url:
            raise RuntimeError("Credential save did not return a local authorization redirect.")
        code = urllib.parse.parse_qs(urllib.parse.urlparse(redirect_url).query).get("code", [None])[0]
        if not code:
            raise RuntimeError("Credential save redirect did not contain a local authorization code.")
        tok = c.post(
            f"{endpoint}/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": ru,
                "client_id": cid,
                "code_verifier": verifier,
            },
        )
        if tok.status_code != 200:
            raise RuntimeError(f"Token exchange failed: HTTP {tok.status_code}")
        token_body = tok.json()
        access_token = token_body.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise RuntimeError("Token exchange did not return an access token.")
        return access_token


def _sub_of(token: str) -> str:
    payload = _json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    return payload.get("sub", "?")


# Substrings (case-insensitive) meaning "credentials not resolved yet" — the
# account is still propagating through KV, or was never saved. Each email tool
# phrases this differently: config(status) -> "awaiting_setup"; folders(list) ->
# "Email credentials are not configured yet.  To set up, open this URL...". _call
# retries on ANY of these (E.2 cross-colo propagation window); the assertion
# FAILS HARD on any of them (a not-ready payload is never a PASS).
_NOT_READY_MARKERS = (
    "awaiting_setup",
    "not configured",  # "Email credentials are not configured yet"
    "no_accounts",
    "no accounts",
    "credentials are required",
    "to set up",  # setup-instruction hint text in the not-configured reply
)


def _not_ready(txt: str | None) -> bool:
    if not txt:
        return True
    low = txt.lower()
    return any(m in low for m in _NOT_READY_MARKERS)


async def _call(s, label, tool, args, *, retries=20, delay=8):
    """Call a tool, retrying while creds are still propagating (KV cross-colo
    eventual consistency after the setup write; E.2)."""
    for i in range(retries):
        try:
            res = await s.call_tool(tool, args)
            txt = "".join(getattr(b, "text", "") for b in res.content)
            if _not_ready(txt):
                print(f"{label}: not ready (KV propagating) try {i + 1}/{retries}")
                await asyncio.sleep(delay)
                continue
            print(f"{label} OK:", txt[:320].replace("\n", " "))
            return txt
        except Exception as e:  # noqa: BLE001 - MCP SDK exposes arbitrary tool errors.
            print(f"{label} ERR:", repr(e)[:300])
            return None
    print(f"{label}: gave up after {retries} tries (still not ready)")
    return None


def _assert_account_resolved(txt: str | None) -> None:
    assert txt is not None, (
        "folders(list) returned no payload (gave up while still not ready)"
    )
    assert not _not_ready(txt), (
        f"account NOT resolved (creds never propagated): {txt[:300]}"
    )
    # Positive proof the IMAP account actually resolved: Gmail always exposes an
    # INBOX folder, so a real folders(list) response contains it. Its absence
    # means the call returned something other than a folder listing.
    assert "inbox" in txt.lower(), (
        f"folders(list) did not return an INBOX folder: {txt[:300]}"
    )
    print("ASSERT OK: account resolved, INBOX folder listed.")


async def _session(endpoint: str, token: str):
    from mcp import ClientSession  # lazy

    try:
        from mcp.client.streamable_http import streamablehttp_client
    except ImportError:
        # MCP SDK 2.0 renamed the client and accepts a configured httpx2 client.
        from contextlib import asynccontextmanager

        import httpx2
        from mcp.client.streamable_http import streamable_http_client

        @asynccontextmanager
        async def authenticated_transport():
            async with httpx2.AsyncClient(
                headers={"Authorization": f"Bearer {token}"}
            ) as client, streamable_http_client(
                f"{endpoint}/mcp", http_client=client
            ) as streams:
                yield streams

        return authenticated_transport(), ClientSession

    return streamablehttp_client(
        f"{endpoint}/mcp", headers={"Authorization": f"Bearer {token}"}
    ), ClientSession


def _client_streams(streams):
    return streams[0], streams[1]


def _token_file() -> Path:
    return Path(__file__).with_name(".email_cf_token")


async def run_full(endpoint: str) -> None:
    token = get_token(endpoint, {"EMAIL_CREDENTIALS": _email_credentials()})
    print("TOKEN OK len=", len(token), "sub=", _sub_of(token))
    transport, ClientSession = await _session(endpoint, token)
    async with transport as streams, ClientSession(*_client_streams(streams)) as s:
        await s.initialize()
        tools = await s.list_tools()
        print("TOOLS:", [t.name for t in tools.tools])
        await _call(s, "CONFIG_STATUS", "config", {"action": "status"})
        txt = await _call(s, "FOLDERS_LIST", "folders", {"action": "list"})
        _assert_account_resolved(txt)
    print("FULL FLOW PASS.")


async def run_outlook(endpoint: str) -> None:
    """Run the Outlook device-code flow and read-only representative tools."""
    email = _outlook_email()
    token = get_token(
        endpoint,
        {"EMAIL_CREDENTIALS": f"{email}:"},
        wait_for_device_code=True,
    )
    transport, ClientSession = await _session(endpoint, token)
    async with transport as streams, ClientSession(*_client_streams(streams)) as s:
        await s.initialize()
        folders = await _call(s, "FOLDERS_LIST", "folders", {"action": "list"})
        _assert_account_resolved(folders)
        search = await _call(
            s,
            "MESSAGES_SEARCH",
            "messages",
            {"action": "search", "query": "ALL", "limit": 2},
        )
        assert search is not None and "error" not in search.lower(), (
            f"messages(search) failed: {search}"
        )
    print("OUTLOOK PASS: folders(list) + messages(search) completed.")


async def run_outlook_resume(endpoint: str, state_path: Path) -> None:
    """Finish a user-authorized Outlook flow and run representative tools."""
    import httpx  # lazy: keep --help importable without httpx

    token = _resume_outlook_token(httpx, endpoint, state_path)
    transport, ClientSession = await _session(endpoint, token)
    async with transport as streams, ClientSession(*_client_streams(streams)) as s:
        await s.initialize()
        folders = await _call(s, "FOLDERS_LIST", "folders", {"action": "list"})
        _assert_account_resolved(folders)
        search = await _call(
            s,
            "MESSAGES_SEARCH",
            "messages",
            {"action": "search", "query": "ALL", "limit": 2},
        )
        assert search is not None and "error" not in search.lower(), (
            f"messages(search) failed: {search}"
        )
    print("OUTLOOK PASS: folders(list) + messages(search) completed.")


async def run_save_only(endpoint: str) -> None:
    token = get_token(endpoint, {"EMAIL_CREDENTIALS": _email_credentials()})
    _token_file().write_text(token)
    print(
        "SAVE-ONLY OK: creds saved for sub=",
        _sub_of(token),
        "len(token)=",
        len(token),
        "(token dumped)",
    )


async def run_auth_only(endpoint: str) -> None:
    tok_path = _token_file()
    if not tok_path.exists():
        raise SystemExit("No dumped token -- run --save-only first.")
    token = tok_path.read_text().strip()
    print("AUTH-ONLY: replaying saved token for sub=", _sub_of(token), "(no re-save)")
    transport, ClientSession = await _session(endpoint, token)
    async with transport as streams, ClientSession(*_client_streams(streams)) as s:
        await s.initialize()
        await _call(s, "CONFIG_STATUS", "config", {"action": "status"})
        txt = await _call(s, "FOLDERS_LIST", "folders", {"action": "list"})
        _assert_account_resolved(txt)
    print("AUTH-ONLY PASS: state survived recreate (KV creds resolved, no re-save).")


async def run_tools(endpoint: str) -> None:
    """Exercise the read-only tool surface end-to-end on the live deployment
    (beyond folders/config): save creds, then drive messages(search), help, and
    config(status) through the real per-sub IMAP path. messages(new/reply/forward)
    and attachments(download) are skipped here -- outbound messages are OUTWARD
    actions and attachments(download) needs a
    real uid; the IMAP read path they share is already exercised by search."""
    token = get_token(endpoint, {"EMAIL_CREDENTIALS": _email_credentials()})
    print("TOKEN OK len=", len(token), "sub=", _sub_of(token))
    transport, ClientSession = await _session(endpoint, token)
    async with transport as streams, ClientSession(*_client_streams(streams)) as s:
        await s.initialize()
        print("TOOLS:", [t.name for t in (await s.list_tools()).tools])
        status = await _call(s, "CONFIG_STATUS", "config", {"action": "status"})
        _assert_account_resolved(
            await _call(s, "FOLDERS_LIST", "folders", {"action": "list"})
        )
        # messages(search): exercises an IMAP SELECT + SEARCH + header FETCH over
        # the KV-resolved account -- the real read path the agent uses most.
        search = await _call(
            s,
            "MESSAGES_SEARCH",
            "messages",
            {"action": "search", "query": "ALL", "limit": 2},
        )
        assert search is not None and "error" not in search.lower(), (
            f"messages(search) failed: {search}"
        )
        # help: docs-resource path, no credentials required.
        helptxt = await _call(s, "HELP", "help", {"tool_name": "messages"})
        assert helptxt is not None and "messages" in helptxt.lower(), (
            f"help failed: {helptxt}"
        )
        assert status is not None and "configured" in status.lower(), (
            f"config(status) not configured: {status}"
        )
    print(
        "TOOLS PASS: config + folders + messages(search) + help all resolved over the per-sub KV path."
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="CF better-email-mcp live OAuth full-flow self-test harness.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--endpoint",
        default=DEFAULT_ENDPOINT,
        help=f"Deployed endpoint (default: {DEFAULT_ENDPOINT})",
    )
    p.add_argument(
        "--outlook-state",
        default="",
        help="local state path for --outlook-start (otherwise a temp path is used).",
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument(
        "--save-only",
        action="store_true",
        help="save creds for one sub + dump token (recreate-gate setup).",
    )
    mode.add_argument(
        "--auth-only",
        action="store_true",
        help="replay dumped token, no re-save (recreate-gate verify).",
    )
    mode.add_argument(
        "--tools",
        action="store_true",
        help="exercise read-only tool surface (messages/help) on the live deploy.",
    )
    mode.add_argument(
        "--outlook",
        action="store_true",
        help="run the Outlook device-code flow and read-only tool checks.",
    )
    mode.add_argument(
        "--outlook-start",
        action="store_true",
        help="start Outlook device-code setup, print the user gate, and exit with resumable state.",
    )
    mode.add_argument(
        "--outlook-resume",
        metavar="STATE_FILE",
        help="resume an Outlook flow after the user authorizes and run read-only tool checks.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.outlook_start:
        import httpx  # lazy: keep --help importable without httpx

        _begin_outlook_device_code(httpx, args.endpoint, Path(args.outlook_state or _default_outlook_state_path()))
    elif args.outlook_resume:
        asyncio.run(run_outlook_resume(args.endpoint, Path(args.outlook_resume)))
    elif args.outlook:
        asyncio.run(run_outlook(args.endpoint))
    elif args.save_only:
        asyncio.run(run_save_only(args.endpoint))
    elif args.auth_only:
        asyncio.run(run_auth_only(args.endpoint))
    elif args.tools:
        asyncio.run(run_tools(args.endpoint))
    else:
        asyncio.run(run_full(args.endpoint))
    return 0


if __name__ == "__main__":
    sys.exit(main())
