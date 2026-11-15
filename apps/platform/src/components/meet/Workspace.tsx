'use client';

import type { Participant, Room } from 'livekit-client';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

export const WORKSPACE_TOPIC = 'impa.workspace';
const INSIGHTS_ATTRIBUTE = 'impa.insights';

export interface WorkspaceTask {
  task: string;
  owner: string;
  due: string;
}

export interface WorkspaceSnapshot {
  title: string;
  plan: string[];
  decisions: string[];
  tasks: WorkspaceTask[];
  notes: string;
}

const EMPTY: WorkspaceSnapshot = {
  title: '',
  plan: [],
  decisions: [],
  tasks: [],
  notes: '',
};

function parseSnapshot(raw: string): WorkspaceSnapshot | null {
  try {
    const data = JSON.parse(raw) as Partial<WorkspaceSnapshot>;
    if (!data || typeof data !== 'object') return null;
    return {
      title: typeof data.title === 'string' ? data.title : '',
      plan: Array.isArray(data.plan) ? data.plan.map(String) : [],
      decisions: Array.isArray(data.decisions) ? data.decisions.map(String) : [],
      tasks: Array.isArray(data.tasks)
        ? (data.tasks as unknown[])
            .map((t) => {
              const x = (t ?? {}) as Record<string, unknown>;
              return {
                task: String(x.task ?? ''),
                owner: String(x.owner ?? ''),
                due: String(x.due ?? ''),
              };
            })
            .filter((t) => t.task)
        : [],
      notes: typeof data.notes === 'string' ? data.notes : '',
    };
  } catch {
    return null;
  }
}

export function workspaceOffered(participants: Participant[]): boolean {
  return participants.some((p) =>
    (p.attributes?.[INSIGHTS_ATTRIBUTE] ?? '').split(',').includes('workspace'),
  );
}

/** Live shared work board published by the agent. */
export function useWorkspace(room: Room): WorkspaceSnapshot {
  const [snap, setSnap] = useState<WorkspaceSnapshot>(EMPTY);
  useEffect(() => {
    room.registerTextStreamHandler(WORKSPACE_TOPIC, async (reader, sender) => {
      const from = room.remoteParticipants.get(sender.identity);
      if (!from?.isAgent) return;
      const next = parseSnapshot(await reader.readAll());
      if (next) setSnap(next);
    });
    return () => room.unregisterTextStreamHandler(WORKSPACE_TOPIC);
  }, [room]);
  return snap;
}

function hasContent(s: WorkspaceSnapshot): boolean {
  return Boolean(s.title || s.plan.length || s.decisions.length || s.tasks.length || s.notes.trim());
}

/** The meeting's shared AI work board (plan, decisions, tasks, notes). */
export function WorkspaceView(props: { snapshot: WorkspaceSnapshot }) {
  const t = useT();
  const s = props.snapshot;
  if (!hasContent(s)) {
    return <p className="muted">{t('room.workspace.empty')}</p>;
  }
  return (
    <div className="workspace-view">
      {s.title ? <h3>{s.title}</h3> : null}
      {s.plan.length > 0 && (
        <>
          <h4>{t('room.workspace.plan')}</h4>
          <ol>
            {s.plan.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </>
      )}
      {s.decisions.length > 0 && (
        <>
          <h4>{t('room.workspace.decisions')}</h4>
          <ul>
            {s.decisions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {s.tasks.length > 0 && (
        <>
          <h4>{t('room.workspace.tasks')}</h4>
          <ul>
            {s.tasks.map((task) => (
              <li key={task.task}>
                {task.task}
                {task.owner ? ` — ${task.owner}` : ''}
                {task.due ? ` (${task.due})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {s.notes.trim() ? (
        <>
          <h4>{t('room.workspace.notes')}</h4>
          <p className="workspace-notes">{s.notes}</p>
        </>
      ) : null}
    </div>
  );
}
