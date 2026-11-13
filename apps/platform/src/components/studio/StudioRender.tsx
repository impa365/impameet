'use client';

import {
  AudioTrack,
  LiveKitRoom,
  isTrackReference,
  useConnectionState,
  useTracks,
} from '@livekit/components-react';
import { ConnectionState, Track } from 'livekit-client';
import { useEffect, useRef } from 'react';
import { StudioCanvas, useStudioState, useStudioTracks } from './StudioCanvas';

/** Egress starts recording when the page says so, and the stage needs a moment to show. */
const SETTLE_MS = 1500;

function Stage() {
  const state = useStudioState();
  const tracks = useStudioTracks();
  const connection = useConnectionState();
  const started = useRef(false);
  // Only the stage is heard: people backstage stay out of the recording.
  const audio = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio]).filter(
    (t) =>
      isTrackReference(t) &&
      (t.source === Track.Source.Microphone
        ? state.stage.includes(t.participant.identity)
        : state.screen === t.participant.identity),
  );

  useEffect(() => {
    if (connection !== ConnectionState.Connected || started.current) return;
    const timer = setTimeout(() => {
      started.current = true;
      // eslint-disable-next-line no-console -- the recorder (LiveKit Egress) waits for this exact line
      console.log('START_RECORDING');
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [connection]);

  return (
    <>
      <StudioCanvas state={state} tracks={tracks} fill />
      {audio.filter(isTrackReference).map((t) => (
        <AudioTrack key={t.publication.trackSid} trackRef={t} />
      ))}
    </>
  );
}

export function StudioRender(props: { serverUrl: string; token: string }) {
  return (
    <LiveKitRoom
      className="studio-render"
      serverUrl={props.serverUrl}
      token={props.token}
      connect
      audio={false}
      video={false}
      options={{ adaptiveStream: false, dynacast: false }}
    >
      <Stage />
    </LiveKitRoom>
  );
}
