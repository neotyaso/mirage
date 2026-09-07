from dataclasses import dataclass
from typing import Literal

State = Literal["listening", "thinking", "speaking"]


@dataclass
class AudioMessage:
    type: Literal["audio"]
    data: str


@dataclass
class StateMessage:
    type: Literal["state"]
    state: State