import os
from pathlib import Path

import uvicorn


def _load_dotenv() -> None:
    """moshi-backend/.env を読んで未設定の env のみ補完 (依存なしの簡易版)。
    GEMINI_API_KEY はここか環境変数で供給する。"""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv()

from server.gemini_factory import create_gemini_app

app = create_gemini_app()


def main():
    port = int(os.environ.get("PORT", "8002"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
