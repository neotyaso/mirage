import os
from server.factory import create_app


def test_factory_with_mock():
    os.environ["ENGINE_BACKEND"] = "mock"
    app = create_app()
    assert app.title == "Moshi Local Realtime"