"""音声出力 stub"""


class SpeakerOutput:
    def __init__(self, device=None, sample_rate: int = 24000):
        self.device = device
        self.sample_rate = sample_rate

    def start(self): pass
    def stop(self): pass
    def write(self, pcm: bytes) -> None: pass