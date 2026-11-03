import pytest

from app.floating_image import (
    FloatingImageError,
    merge_floating_images,
    parse_floating_images,
)

PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def test_parse_requires_src_on_a_full_document_and_allows_a_move():
    stored = parse_floating_images(
        [{"id": "pic", "x": 1, "y": 2, "width": 40, "height": 24, "src": PNG}],
        require_src=True,
    )
    assert stored[0]["src"] == PNG
    moved = parse_floating_images(
        [{"id": "pic", "x": 8, "y": 2, "width": 40, "height": 24}],
        require_src=False,
    )
    assert "src" not in moved[0]
    with pytest.raises(FloatingImageError, match="src"):
        parse_floating_images(
            [{"id": "pic", "x": 0, "y": 0, "width": 40, "height": 24}],
            require_src=True,
        )
    with pytest.raises(FloatingImageError, match="src"):
        parse_floating_images(
            [{"id": "pic", "x": 0, "y": 0, "width": 40, "height": 24, "src": "https://example.com/a.png"}],
            require_src=True,
        )


def test_merge_keeps_bytes_when_src_is_omitted_and_rejects_unknown_ids():
    previous = [{"id": "pic", "x": 0, "y": 0, "width": 40, "height": 24, "src": PNG}]
    incoming = parse_floating_images(
        [{"id": "pic", "x": 12, "y": 4, "width": 48, "height": 24}],
        require_src=False,
    )
    stored, wire = merge_floating_images(previous, incoming)
    assert stored[0]["src"] == PNG
    assert stored[0]["x"] == 12
    assert "src" not in wire[0]
    with pytest.raises(FloatingImageError, match="unknown"):
        merge_floating_images(
            previous,
            parse_floating_images(
                [{"id": "other", "x": 0, "y": 0, "width": 40, "height": 24}],
                require_src=False,
            ),
        )
