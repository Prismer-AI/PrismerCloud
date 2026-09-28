from prismer.types import ENVIRONMENTS


def test_production_environment_uses_current_origin() -> None:
    assert ENVIRONMENTS["production"] == "https://prod.docbrew.cn"
