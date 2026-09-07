import time


class LatencyTracker:
    def __init__(self):
        self._marks: dict[str, float] = {}
        self._starts: dict[str, float] = {}

    def start(self, label: str) -> None:
        self._starts[label] = time.perf_counter()

    def stop(self, label: str) -> float:
        elapsed = (time.perf_counter() - self._starts[label]) * 1000
        self._marks[label] = elapsed
        return elapsed

    def mark(self, label: str) -> None:
        self._marks[label] = time.perf_counter()

    def since_mark_ms(self, start: str, end: str) -> float:
        return (self._marks[end] - self._marks[start]) * 1000

    def elapsed_ms(self, label: str) -> float:
        return self._marks[label]

    def reset(self) -> None:
        self._marks.clear()
        self._starts.clear()