from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from typing import TypeVar

T = TypeVar("T")
R = TypeVar("R")


async def run_jobs_concurrently(
    jobs: Iterable[T],
    concurrency: int,
    worker: Callable[[T], Awaitable[R]],
    on_result: Callable[[R], None] | None = None,
) -> list[R]:
    limit = max(1, min(concurrency, 5))
    semaphore = asyncio.Semaphore(limit)

    async def guarded(job: T) -> R:
        async with semaphore:
            return await worker(job)

    tasks = [asyncio.create_task(guarded(job)) for job in jobs]
    results: list[R] = []
    for task in asyncio.as_completed(tasks):
        result = await task
        results.append(result)
        if on_result is not None:
            on_result(result)
    return results
