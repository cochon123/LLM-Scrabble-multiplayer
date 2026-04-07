from __future__ import annotations

import asyncio
import unittest

from benchmarks.scrabble_toolcall.concurrency import run_jobs_concurrently


class ConcurrencyTests(unittest.TestCase):
    def test_never_exceeds_five_workers(self) -> None:
        async def scenario() -> None:
            active = 0
            peak = 0

            async def worker(job: int) -> int:
                nonlocal active, peak
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1
                return job

            jobs = list(range(20))
            results = await run_jobs_concurrently(jobs, 99, worker)
            self.assertEqual(sorted(results), jobs)
            self.assertLessEqual(peak, 5)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
