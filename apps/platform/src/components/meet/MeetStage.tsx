'use client';

import {
  CarouselLayout,
  FocusLayoutContainer,
  GridLayout,
  LayoutContextProvider,
  ParticipantTile,
  type TrackReferenceOrPlaceholder,
  isTrackReference,
  useCreateLayoutContext,
  usePinnedTracks,
  useTracks,
} from '@livekit/components-react';
import { RoomEvent, Track } from 'livekit-client';
import { useEffect, useRef } from 'react';
import { CAPTIONER_ATTRIBUTE } from '@/lib/captions';
import { MeetTile } from './MeetTile';

function sameTrack(a: TrackReferenceOrPlaceholder | undefined, b: TrackReferenceOrPlaceholder | undefined) {
  if (!a || !b) return false;
  return a.participant.identity === b.participant.identity && a.source === b.source;
}

/**
 * Meet's stage: an even grid of people, or the pinned/shared screen large with everyone else
 * in a strip beside it. A new screen share takes the stage on its own, as in Meet.
 */
export function MeetStage() {
  const layout = useCreateLayoutContext();
  const autoPinned = useRef<TrackReferenceOrPlaceholder | null>(null);
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  ).filter((t) => t.participant.attributes?.[CAPTIONER_ATTRIBUTE] !== 'captions');

  const screens = tracks
    .filter(isTrackReference)
    .filter((t) => t.publication.source === Track.Source.ScreenShare);
  const focus = usePinnedTracks(layout)?.[0];
  const others = tracks.filter((t) => !sameTrack(t, focus));
  const screenKey = screens.map((t) => `${t.publication.trackSid}_${t.publication.isSubscribed}`).join();

  useEffect(() => {
    const pin = layout.pin.dispatch;
    if (!pin) return;
    if (screens.some((t) => t.publication.isSubscribed) && autoPinned.current === null) {
      pin({ msg: 'set_pin', trackReference: screens[0] });
      autoPinned.current = screens[0];
    } else if (
      autoPinned.current &&
      !screens.some((t) => t.publication.trackSid === autoPinned.current?.publication?.trackSid)
    ) {
      pin({ msg: 'clear_pin' });
      autoPinned.current = null;
    }
    if (focus && !isTrackReference(focus)) {
      const updated = tracks.find((t) => sameTrack(t, focus));
      if (updated !== focus && isTrackReference(updated)) pin({ msg: 'set_pin', trackReference: updated });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the share list, like LiveKit's VideoConference
  }, [screenKey, focus?.publication?.trackSid, tracks]);

  return (
    <LayoutContextProvider value={layout}>
      <div className="meet-stage">
        {!focus ? (
          <GridLayout tracks={tracks} className="meet-grid">
            <ParticipantTile className="meet-tile">
              <MeetTile />
            </ParticipantTile>
          </GridLayout>
        ) : (
          <FocusLayoutContainer className="meet-focus">
            <div className="meet-focus-main">
              <ParticipantTile trackRef={focus} className="meet-tile">
                <MeetTile />
              </ParticipantTile>
            </div>
            {others.length > 0 && (
              <CarouselLayout tracks={others} orientation="vertical" className="meet-strip">
                <ParticipantTile className="meet-tile">
                  <MeetTile />
                </ParticipantTile>
              </CarouselLayout>
            )}
          </FocusLayoutContainer>
        )}
      </div>
    </LayoutContextProvider>
  );
}
