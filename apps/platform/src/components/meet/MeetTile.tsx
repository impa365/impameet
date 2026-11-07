'use client';

import {
  VideoTrack,
  isTrackReference,
  useEnsureTrackRef,
  useIsMuted,
  useIsSpeaking,
  useParticipantAttributes,
} from '@livekit/components-react';
import { LocalParticipant, Track } from 'livekit-client';
import { useT } from '@/i18n/client';
import { displayName } from '@/lib/a11y';
import { Icon } from '../ui/Icon';
import { avatarColor, initial } from './Avatar';

export const HAND_ATTRIBUTE = 'hand';
export const AGENT_MUTED_ATTRIBUTE = 'impa.muted';

export { displayName };

/** One person (or one shared screen) on the stage, drawn the way Meet draws it. */
export function MeetTile() {
  const t = useT();
  const trackRef = useEnsureTrackRef();
  const { participant } = trackRef;
  const screen = trackRef.source === Track.Source.ScreenShare;
  const speaking = useIsSpeaking(participant);
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const { attributes } = useParticipantAttributes({ participant });
  const name = displayName(participant, t('room.aiAssistant'));
  const label = participant.isLocal ? t('room.nameYou', { name }) : name;
  const agent = participant.isAgent;
  const agentSilent = agent && attributes?.[AGENT_MUTED_ATTRIBUTE] === 'true';
  const hand = Boolean(attributes?.[HAND_ATTRIBUTE]);

  if (screen && participant instanceof LocalParticipant) {
    return (
      <div className="tile-presenting">
        <Icon name="present_to_all" size={40} />
        <strong>{t('room.tile.presenting')}</strong>
        <button
          className="btn tonal small"
          onClick={() => void participant.setScreenShareEnabled(false).catch(() => undefined)}
        >
          {t('room.bar.stopPresenting')}
        </button>
      </div>
    );
  }

  const spoken = screen
    ? t('room.tile.presentationOf', { name })
    : [
        label,
        agent ? (agentSilent ? t('room.tile.aiSilent') : t('room.tile.ai')) : '',
        agent ? (attributes?.['impa.about'] ?? '') : '',
        micMuted ? t('room.tile.micOff') : t('room.tile.micOn'),
        speaking && !micMuted ? t('room.tile.speaking') : '',
        hand ? t('room.tile.hand') : '',
      ]
        .filter(Boolean)
        .join(', ');

  return (
    <>
      <span className="sr-only">{spoken}</span>
      {isTrackReference(trackRef) && <VideoTrack trackRef={trackRef} aria-hidden />}
      <div className="lk-participant-placeholder tile-avatar-wrap">
        <span
          className={agent ? 'tile-avatar agent' : 'tile-avatar'}
          style={agent ? undefined : { background: avatarColor(name) }}
          data-speaking={speaking && !micMuted ? '' : undefined}
        >
          {agent ? <Icon name="smart_toy" size={44} /> : initial(name)}
        </span>
      </div>
      {!screen && (
        <span className="tile-status">
          {micMuted ? (
            <span className="tile-badge" title={t('room.status.micOff')}>
              <Icon name="mic_off" size={18} />
            </span>
          ) : speaking ? (
            <span className="tile-badge speaking" title={t('room.status.speaking')}>
              <Icon name="graphic_eq" size={18} />
            </span>
          ) : null}
        </span>
      )}
      <span className="tile-name">
        {hand && <Icon name="back_hand" size={16} className="tile-hand" />}
        {screen && <Icon name="present_to_all" size={16} />}
        {screen ? t('room.tile.presentationOf', { name }) : label}
        {agent && (
          <span className="tile-chip">{agentSilent ? t('room.status.aiSilent') : t('room.status.ai')}</span>
        )}
      </span>
    </>
  );
}
