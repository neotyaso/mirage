from server.protocol import AudioMessage, StateMessage


def test_audio_message():
    m = AudioMessage(type="audio", data="xxxx")
    assert m.type == "audio"


def test_state_message():
    m = StateMessage(type="state", state="speaking")
    assert m.state == "speaking"


def test_state_literal():
    m = StateMessage(type="state", state="listening")
    assert m.type == "state"