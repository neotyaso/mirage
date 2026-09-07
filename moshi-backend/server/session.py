import time
from dataclasses import dataclass, field


@dataclass
class Session:
    session_id: str
    created_at: float = field(default_factory=time.time)
    state: str = "listening"