import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EgressStatus } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { egressState } from '@/server/recordings/egress';
import { openRecording, recordingFileName, recordingPath, removeRecording } from '@/server/recordings/files';

const TENANT = '11111111-1111-4111-8111-111111111111';
const REC = '22222222-2222-4222-8222-222222222222';
const FILE = recordingFileName(TENANT, REC);

describe('egressState', () => {
  it.each([
    [EgressStatus.EGRESS_STARTING, 'recording'],
    [EgressStatus.EGRESS_ACTIVE, 'recording'],
    [EgressStatus.EGRESS_ENDING, 'processing'],
    [EgressStatus.EGRESS_COMPLETE, 'ready'],
    [EgressStatus.EGRESS_FAILED, 'failed'],
    [EgressStatus.EGRESS_ABORTED, 'failed'],
    [EgressStatus.EGRESS_LIMIT_REACHED, 'failed'],
  ])('maps %s to %s', (status, state) => {
    expect(egressState(status)).toBe(state);
  });
});

describe('recording files', () => {
  it('only resolves names the platform writes', () => {
    expect(FILE).toBe(`${TENANT}_${REC}.mp4`);
    expect(recordingPath('/rec', FILE)).toBe(path.join('/rec', FILE));
    for (const bad of [
      '../etc/passwd',
      `${TENANT}/${REC}.mp4`,
      `../${FILE}`,
      `/abs/${FILE}`,
      `${TENANT}_${REC}.mkv`,
      '',
    ]) {
      expect(() => recordingPath('/rec', bad)).toThrow(AppError);
    }
  });

  it('streams, reports size and removes files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rec-'));
    await writeFile(path.join(dir, FILE), 'video-bytes');
    const { body, size } = await openRecording(dir, FILE);
    expect(size).toBe(11);
    expect(await new Response(body).text()).toBe('video-bytes');
    await removeRecording(dir, FILE);
    await expect(readFile(path.join(dir, FILE))).rejects.toThrow();
    await removeRecording(dir, FILE);
    await expect(openRecording(dir, FILE)).rejects.toThrow(/não está disponível/);
  });
});
