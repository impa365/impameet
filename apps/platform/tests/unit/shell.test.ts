import { describe, expect, it } from 'vitest';
import { adminTabsFor, pickAdminTab, pickDashboardView } from '@/components/admin/tabs';
import { roomFromInput } from '@/lib/room-code';
import { parseTheme } from '@/lib/theme';

describe('parseTheme', () => {
  it('accepts only light and dark', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('blue')).toBeUndefined();
    expect(parseTheme(undefined)).toBeUndefined();
  });
});

describe('admin navigation', () => {
  it('gives managers only users and live rooms', () => {
    expect(adminTabsFor('manager')).toEqual(['users', 'live']);
    expect(adminTabsFor('member')).toEqual([]);
    expect(adminTabsFor('admin')).toContain('integrations');
  });

  it('falls back to the first allowed tab', () => {
    expect(pickAdminTab('admin', 'integrations')).toBe('integrations');
    expect(pickAdminTab('admin', undefined)).toBe('agents');
    expect(pickAdminTab('manager', 'integrations')).toBe('users');
  });

  it('falls back to rooms for an unknown dashboard view', () => {
    expect(pickDashboardView('recordings')).toBe('recordings');
    expect(pickDashboardView('nope')).toBe('rooms');
    expect(pickDashboardView(undefined)).toBe('rooms');
  });
});

describe('roomFromInput', () => {
  it('reads a bare code or a meeting link', () => {
    expect(roomFromInput('  Abc-123 ')).toBe('abc-123');
    expect(roomFromInput('https://meet.example.com/r/abc-123?x=1')).toBe('abc-123');
  });

  it('rejects anything else', () => {
    expect(roomFromInput('')).toBeNull();
    expect(roomFromInput('../admin')).toBeNull();
    expect(roomFromInput('two words')).toBeNull();
  });
});
