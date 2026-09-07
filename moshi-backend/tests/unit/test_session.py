from server.session import Session
import time


def test_session_creation():
    s = Session(session_id="s1")
    assert s.session_id == "s1"
    assert s.state == "listening"


def test_session_state_change():
    s = Session(session_id="s2")
    s.state = "speaking"
    assert s.state == "speaking"