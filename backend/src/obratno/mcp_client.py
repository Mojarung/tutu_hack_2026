"""Тонкий клиент Tutu MCP.

RU: Сервер stateless, initialize не нужен. Две ловушки, проверенные живьём: без заголовка
    MCP-Protocol-Version приходит HTTP 500, и тело обязано уходить UTF-8 байтами.
EN: The server is stateless, no initialize needed. Two live-verified traps: a missing
    MCP-Protocol-Version header returns HTTP 500, and the body must be sent as UTF-8 bytes.
"""

from __future__ import annotations

import asyncio
import json
import random
from typing import Any

import httpx

MCP_URL = "https://mcp.tutu.ru/mcp"
MCP_PROTOCOL = "2025-06-18"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL,
}


class TutuMcpError(RuntimeError):
    """Ошибка вызова инструмента MCP. / MCP tool call failure."""


class TutuMcp:
    def __init__(self, concurrency: int = 10, timeout: float = 60.0) -> None:
        self._client = httpx.AsyncClient(timeout=timeout)
        self._sem = asyncio.Semaphore(concurrency)
        self._id = 0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def call(self, name: str, arguments: dict[str, Any], attempts: int = 3) -> dict[str, Any]:
        """Вызывает инструмент MCP. / Calls one MCP tool."""
        self._id += 1
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": self._id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
            ensure_ascii=False,
        ).encode("utf-8")

        last: Exception | None = None
        for attempt in range(attempts):
            try:
                async with self._sem:
                    response = await self._client.post(MCP_URL, content=body, headers=HEADERS)
                if response.status_code >= 500 or response.status_code == 429:
                    raise TutuMcpError(f"HTTP {response.status_code}")
                payload = response.json()
                if "error" in payload:
                    raise TutuMcpError(str(payload["error"]))
                text = payload["result"]["content"][0]["text"]
                return json.loads(text)
            except Exception as exc:  # ретрай с бэкоффом / retry with backoff
                last = exc
                if attempt < attempts - 1:
                    await asyncio.sleep(0.6 * (2**attempt) + random.random() * 0.3)
        raise TutuMcpError(f"{name} failed: {last}")
