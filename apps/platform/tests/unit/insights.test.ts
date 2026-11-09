import { describe, expect, it } from 'vitest';
import { availableInsights } from '@/components/meet/Copilot';
import { issueJoinToken } from '@/server/livekit';
import { agentInput, meetingReportInput } from '@/server/validation';

const agent = (identity: string, insights: string, access = 'moderators') => ({
  identity,
  attributes: { 'impa.insights': insights, 'impa.insights.access': access },
});
const me = (role: string, org?: string) => ({ attributes: { role, ...(org ? { 'impa.org': org } : {}) } });

describe('who sees the copilot, the metrics and "what did I miss?" in the room', () => {
  it('moderators and managers by default; anyone for the catch-up', () => {
    const agents = [agent('agent-1', 'catchup,copilot,metrics')];
    expect(availableInsights(agents, me('moderator', 'member'))).toEqual({
      catchup: 'agent-1',
      copilot: 'agent-1',
      metrics: 'agent-1',
    });
    expect(availableInsights(agents, me('participant', 'manager'))).toMatchObject({ copilot: 'agent-1' });
    expect(availableInsights(agents, me('participant', 'member'))).toEqual({ catchup: 'agent-1' });
    expect(availableInsights(agents, me('guest'))).toEqual({ catchup: 'agent-1' });
  });

  it('"managers only" leaves room moderators out, and the first agent offering it answers', () => {
    const agents = [
      agent('agent-1', 'metrics', 'managers'),
      agent('agent-2', 'copilot'),
      agent('agent-3', 'copilot,unknown'),
      { identity: 'agent-4' },
    ];
    expect(availableInsights(agents, me('moderator', 'member'))).toEqual({ copilot: 'agent-2' });
    expect(availableInsights(agents, me('moderator', 'admin'))).toEqual({
      copilot: 'agent-2',
      metrics: 'agent-1',
    });
    expect(availableInsights([], me('moderator', 'admin'))).toEqual({});
  });
});

describe('meeting insights validation', () => {
  it('everything is off by default and only known features are accepted', () => {
    const parsed = agentInput.safeParse({ name: 'K', instructions: 'x' });
    if (!parsed.success)
      expect(parsed.error.issues.some((i) => String(i.path[0]).startsWith('insights'))).toBe(false);
    const shape = agentInput.shape;
    expect(shape.insights.parse(undefined)).toEqual([]);
    expect(shape.insights.parse(['minutes', 'minutes', 'metrics'])).toEqual(['minutes', 'metrics']);
    expect(shape.insights.safeParse(['spy']).success).toBe(false);
    expect(shape.insightsAccess.parse(undefined)).toBe('moderators');
    expect(shape.insightsAccess.safeParse('everyone').success).toBe(false);
    expect(shape.minutesWebhook.parse('')).toBeNull();
    expect(shape.minutesWebhook.parse(undefined)).toBeNull();
    expect(shape.minutesWebhook.parse(' https://n8n.example.com/webhook/x ')).toBe(
      'https://n8n.example.com/webhook/x',
    );
    expect(shape.minutesWebhook.safeParse('ftp://x').success).toBe(false);
  });

  it('accepts the agent report and bounds it', () => {
    const report = {
      room: 't1.sala',
      startedAt: 1,
      endedAt: 2,
      participants: [
        { identity: 'g-a', name: 'A', talkSeconds: 3, turns: 1, words: 2, joinedAt: 1, leftAt: null },
      ],
    };
    const parsed = meetingReportInput.parse(report);
    expect(parsed.lines).toEqual([]);
    expect(parsed.participants[0].role).toBe('participant');
    expect(
      meetingReportInput.safeParse({ ...report, participants: [{ ...report.participants[0], turns: -1 }] })
        .success,
    ).toBe(false);
    expect(
      meetingReportInput.safeParse({
        ...report,
        lines: [{ at: 0, identity: 'g-a', name: 'A', text: 'x'.repeat(5001) }],
      }).success,
    ).toBe(false);
  });

  it('puts the organization role in the join token (participants cannot change it)', async () => {
    const token = await issueJoinToken({
      apiKey: 'key',
      apiSecret: 's'.repeat(40),
      tenantId: 't1',
      roomSlug: 'sala',
      identity: 'u-1',
      displayName: 'Ana',
      role: 'participant',
      orgRole: 'manager',
    });
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
      attributes: Record<string, string>;
      video: { canUpdateOwnMetadata: boolean };
    };
    expect(claims.attributes).toEqual({ role: 'participant', 'impa.org': 'manager' });
    expect(claims.video.canUpdateOwnMetadata).toBe(false);
  });
});
