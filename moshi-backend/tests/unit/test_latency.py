from monitoring.latency import LatencyTracker
import time


def test_mark_and_since():
    t = LatencyTracker()
    t.mark("a")
    time.sleep(0.01)
    t.mark("b")
    diff = t.since_mark_ms("a", "b")
    assert diff >= 10


def test_start_stop():
    t = LatencyTracker()
    t.start("x")
    time.sleep(0.005)
    elapsed = t.stop("x")
    assert elapsed >= 5