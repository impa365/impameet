"""Publishes browser frames into a LiveKit room as a screen share."""

from __future__ import annotations

import asyncio
import contextlib
import io
import time
from datetime import timedelta

from livekit import api, rtc
from PIL import Image

from .config import Settings

SCREEN_IDENTITY = "ai-screen"
KEEPALIVE_S = 0.5
ALONE_GRACE_S = 60.0
MAX_BITRATE = 2_000_000
MAX_FPS = 15
TOKEN_TTL = timedelta(hours=8)


def screen_token(settings: Settings, room: str) -> str:
    """Publish-only grant: the screen can show a share and nothing else."""
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=False,
        can_publish_data=False,
        can_publish_sources=["screen_share"],
    )
    return (
        api.AccessToken(
            settings.livekit_api_key.get_secret_value(),
            settings.livekit_api_secret.get_secret_value(),
        )
        .with_identity(SCREEN_IDENTITY)
        .with_name(settings.display_name)
        .with_kind("agent")
        .with_ttl(TOKEN_TTL)
        .with_grants(grants)
        .to_jwt()
    )


def jpeg_to_frame(data: bytes, width: int, height: int) -> rtc.VideoFrame:
    with Image.open(io.BytesIO(data)) as img:
        rgba = img.convert("RGBA")
    if rgba.size != (width, height):
        canvas = Image.new("RGBA", (width, height), (22, 24, 29, 255))
        rgba.thumbnail((width, height))
        canvas.paste(rgba, ((width - rgba.width) // 2, (height - rgba.height) // 2))
        rgba = canvas
    return rtc.VideoFrame(width, height, rtc.VideoBufferType.RGBA, rgba.tobytes())


class LiveKitScreen:
    def __init__(self, width: int, height: int) -> None:
        self._width = width
        self._height = height
        self._source = rtc.VideoSource(width, height, is_screencast=True)
        self._room = rtc.Room()
        self._last: rtc.VideoFrame | None = None
        self._keepalive: asyncio.Task[None] | None = None
        self._alone_since: float | None = None
        self._disconnected = False

    async def connect(self, url: str, token: str) -> None:
        self._room.on("disconnected", self._on_disconnected)
        self._room.on("participant_connected", self._on_presence)
        self._room.on("participant_disconnected", self._on_presence)
        await self._room.connect(url, token)
        track = rtc.LocalVideoTrack.create_video_track("ai-screen", self._source)
        options = rtc.TrackPublishOptions(
            source=rtc.TrackSource.SOURCE_SCREENSHARE,
            # Text on a page: viewers start on the lowest simulcast layer, which is blurry.
            simulcast=False,
            video_encoding=rtc.VideoEncoding(max_bitrate=MAX_BITRATE, max_framerate=MAX_FPS),
        )
        await self._room.local_participant.publish_track(track, options)
        self._on_presence()
        self._keepalive = asyncio.create_task(self._repeat_last_frame())

    def _on_disconnected(self, *_: object) -> None:
        self._disconnected = True

    def _on_presence(self, *_: object) -> None:
        alone = len(self._room.remote_participants) == 0
        if not alone:
            self._alone_since = None
        elif self._alone_since is None:
            self._alone_since = time.monotonic()

    def push_jpeg(self, data: bytes) -> None:
        with contextlib.suppress(Exception):
            self._last = jpeg_to_frame(data, self._width, self._height)
            self._source.capture_frame(self._last)

    async def _repeat_last_frame(self) -> None:
        """Static pages emit no new frames; repeating keeps late joiners from a black tile."""
        while True:
            await asyncio.sleep(KEEPALIVE_S)
            if self._last is not None:
                self._source.capture_frame(self._last)

    def expired(self, now: float) -> bool:
        if self._disconnected:
            return True
        return self._alone_since is not None and now - self._alone_since >= ALONE_GRACE_S

    async def close(self) -> None:
        if self._keepalive:
            self._keepalive.cancel()
        with contextlib.suppress(Exception):
            await self._room.disconnect()
