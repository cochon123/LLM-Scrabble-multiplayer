from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

import requests


@dataclass
class ProviderResponse:
    raw_text: str
    latency_ms: int
    usage: dict[str, Any] | None


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


class OpenAICompatibleClient:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout_seconds: int = 60,
    ) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.is_openrouter = "openrouter.ai" in base_url

    def complete(self, model: str, prompt: str, temperature: float = 0.0) -> ProviderResponse:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.is_openrouter:
            headers["HTTP-Referer"] = "https://local.scrabble-toolcall-bench"
            headers["X-Title"] = "Scrabble Toolcall Benchmark"

        body = {
            "model": model,
            "temperature": temperature,
            "max_tokens": 1200,
            "messages": [
                {
                    "role": "system",
                    "content": "JSON brut uniquement.",
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
        }

        started = time.perf_counter()
        response = requests.post(
            self.base_url,
            headers=headers,
            json=body,
            timeout=(10, self.timeout_seconds),
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        if response.status_code >= 400:
            retryable = response.status_code in {408, 409, 425, 429, 500, 502, 503, 504}
            raise ProviderError(
                f"HTTP {response.status_code}: {response.text[:500]}",
                status_code=response.status_code,
                retryable=retryable,
            )

        try:
            payload = response.json()
        except requests.JSONDecodeError as error:
            raise ProviderError(f"JSON fournisseur invalide: {response.text[:500]}") from error
        if payload.get("error"):
            message = payload["error"]
            if isinstance(message, dict):
                message = json.dumps(message, ensure_ascii=False)
            raise ProviderError(f"Erreur fournisseur: {str(message)[:500]}", retryable=True)
        choices = payload.get("choices") or []
        if not choices:
            if isinstance(payload.get("message"), str):
                return ProviderResponse(raw_text=payload["message"], latency_ms=latency_ms, usage=payload.get("usage"))
            raise ProviderError(
                f"Reponse fournisseur sans choices. Payload={json.dumps(payload, ensure_ascii=False)[:500]}",
                retryable=True,
            )

        message = choices[0].get("message") or {}
        content = message.get("content")
        if content is None and isinstance(choices[0].get("text"), str):
            content = choices[0]["text"]
        raw_text = _coerce_content(content)
        if not raw_text.strip():
            raise ProviderError(
                f"Reponse fournisseur vide. Payload={json.dumps(payload, ensure_ascii=False)[:500]}",
                retryable=True,
            )
        return ProviderResponse(raw_text=raw_text, latency_ms=latency_ms, usage=payload.get("usage"))


class GoogleGenerativeAIClient:
    def __init__(
        self,
        api_key: str,
        base_url: str | None = None,
        timeout_seconds: int = 60,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url or "https://generativelanguage.googleapis.com/v1beta"
        self.timeout_seconds = timeout_seconds

    def complete(self, model: str, prompt: str, temperature: float = 0.0) -> ProviderResponse:
        url = f"{self.base_url}/models/{model}:generateContent?key={self.api_key}"
        body = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}],
                }
            ],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": 1200,
            },
        }
        if "gemma" in model.lower():
            body["contents"][0]["parts"][0]["text"] = f"JSON brut uniquement.\n{prompt}"
        else:
            body["generationConfig"]["responseMimeType"] = "application/json"
            body["systemInstruction"] = {
                "parts": [
                    {
                        "text": "JSON brut uniquement.",
                    }
                ]
            }

        started = time.perf_counter()
        response = requests.post(
            url,
            headers={"Content-Type": "application/json"},
            data=json.dumps(body).encode("utf8"),
            timeout=self.timeout_seconds,
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        if response.status_code >= 400:
            raise ProviderError(f"HTTP {response.status_code}: {response.text[:500]}")

        payload = response.json()
        candidates = payload.get("candidates") or []
        if not candidates:
            raise ProviderError("Reponse fournisseur sans candidates.")

        content = (candidates[0].get("content") or {}).get("parts") or []
        raw_text = _coerce_content(content)
        return ProviderResponse(raw_text=raw_text, latency_ms=latency_ms, usage=payload.get("usageMetadata"))


def _coerce_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return ""
