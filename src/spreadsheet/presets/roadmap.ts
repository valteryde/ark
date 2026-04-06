import { createInMemoryDataStore, type InMemoryDataInitValue } from '../data-store.ts';
import type { SpreadsheetConfig } from '../types.ts';

const roadmapInitial: Record<string, InMemoryDataInitValue> = {
  '1:1': {
    value: 'Launch Q1 marketing campaign',
    style: { 'background-color': '#fef3c7' },
    comment: 'Kickoff sync with sales next week.',
  },
  '1:2': 'HIGH',
  '1:3': 'In Progress',
  '1:4': 'Alex Morgan',
  '1:5': 'Jan 12, 2026',
  '2:1': 'API documentation refresh',
  '2:2': 'MEDIUM',
  '2:3': 'Not Started',
  '2:4': 'Jordan Lee',
  '2:5': 'Feb 3, 2026',
  '3:1': 'Security audit remediation',
  '3:2': 'URGENT',
  '3:3': 'In Progress',
  '3:4': 'Sam Rivera',
  '3:5': 'Jan 28, 2026',
  '4:1': 'Design system v2 rollout',
  '4:2': 'MEDIUM',
  '4:3': 'Completed',
  '4:4': 'Taylor Kim',
  '4:5': 'Dec 8, 2025',
  '1:11': 'Apr 1, 2026 09:12',
  '1:12': 'svc-cron',
  '1:13': 'tsk_8f2a01',
  '1:14': 'locked',
  '1:15': '0.94',
  '1:16': 'JIRA',
  '2:11': 'Mar 28, 2026 14:40',
  '2:12': 'jordan.lee',
  '2:13': 'tsk_9c11ab',
  '2:14': 'draft',
  '2:15': '0.12',
  '2:16': 'Linear',
  '3:11': 'Mar 30, 2026 08:05',
  '3:12': 'security-bot',
  '3:13': 'tsk_44ee90',
  '3:14': 'review',
  '3:15': '0.67',
  '3:16': 'GitHub',
  '4:11': 'Feb 2, 2026 11:22',
  '4:12': 'taylor.kim',
  '4:13': 'tsk_221bff',
  '4:14': 'shipped',
  '4:15': '1.00',
  '4:16': 'Notion',
};

const roadmapColumnsAndChrome = (): Omit<SpreadsheetConfig, 'data'> => ({
  columns: [
    { id: 'title', header: 'TASK NAME', widthPx: 240 },
    {
      id: 'priority',
      header: 'PRIORITY',
      widthPx: 108,
      valueType: 'select',
      selectOptions: [
        {
          value: 'HIGH',
          backgroundColor: '#d8f3dc',
          color: '#1b4332',
          icon: 'arrow-up',
        },
        {
          value: 'MEDIUM',
          backgroundColor: '#fde8d4',
          color: '#9a3412',
          icon: 'equals',
        },
        {
          value: 'URGENT',
          backgroundColor: '#ffd6e0',
          color: '#9d174d',
          icon: 'warning',
        },
        {
          value: 'LOW',
          backgroundColor: '#e4e4e7',
          color: '#52525b',
          icon: 'arrow-down',
        },
      ],
    },
    {
      id: 'status',
      header: 'STATUS',
      widthPx: 128,
      valueType: 'select',
      selectOptions: [
        {
          value: 'In Progress',
          label: 'In progress',
          backgroundColor: '#dbeafe',
          color: '#1d4ed8',
          icon: 'circle-notch',
        },
        {
          value: 'Not Started',
          label: 'Not started',
          backgroundColor: '#f4f4f5',
          color: '#71717a',
          icon: 'circle-dashed',
        },
        {
          value: 'Completed',
          backgroundColor: '#d1fae5',
          color: '#047857',
          icon: 'check-circle',
        },
      ],
    },
    { id: 'assignee', header: 'ASSIGNEE', widthPx: 188 },
    { id: 'dueDate', header: 'DATE', widthPx: 118 },
    { id: 'notes', header: 'NOTES', widthPx: 100 },
    { id: 'g', header: 'G', widthPx: 88 },
    { id: 'h', header: 'H', widthPx: 88 },
    { id: 'i', header: 'I', widthPx: 88 },
    { id: 'j', header: 'J', widthPx: 88 },
    { id: 'updatedAt', header: 'UPDATED', widthPx: 132, readOnly: true },
    { id: 'updatedBy', header: 'BY', widthPx: 96, readOnly: true },
    { id: 'recordId', header: 'RECORD ID', widthPx: 120, readOnly: true },
    { id: 'flags', header: 'FLAGS', widthPx: 88, readOnly: true },
    { id: 'score', header: 'SCORE', widthPx: 72, readOnly: true },
    { id: 'source', header: 'SOURCE', widthPx: 88, readOnly: true },
  ],
  rowCount: 100,
  defaultRowHeightPx: 28,
  enabledUiCapabilities: [
    'undo',
    'redo',
    'format-bold',
    'format-italic',
    'format-strikethrough',
    'fill',
    'borders',
    'align',
    'link',
    'comment',
    'functions',
  ],
});

/** Example preset matching the Product Roadmap demo; build real configs from your API JSON. */
export function createRoadmapPreset(): SpreadsheetConfig {
  return {
    ...roadmapColumnsAndChrome(),
    data: createInMemoryDataStore(roadmapInitial),
  };
}

/** Same grid as the roadmap; empty cells for triage / unprioritized work. */
export function createRoadmapBacklogPreset(): SpreadsheetConfig {
  return {
    ...roadmapColumnsAndChrome(),
    data: createInMemoryDataStore({}),
  };
}

const archiveInitial: Record<string, InMemoryDataInitValue> = {
  '1:1': 'Legacy billing export tool',
  '1:2': 'LOW',
  '1:3': 'Completed',
  '1:4': 'Alex Morgan',
  '1:5': 'Sep 30, 2025',
  '2:1': 'Mobile v1 sunsetting',
  '2:2': 'MEDIUM',
  '2:3': 'Completed',
  '2:4': 'Jordan Lee',
  '2:5': 'Nov 1, 2025',
  '3:1': 'Hackathon prototype — archived',
  '3:2': 'LOW',
  '3:3': 'Completed',
  '3:4': 'Sam Rivera',
  '3:5': 'Aug 12, 2025',
};

/** Completed-style sample rows for a read-only-feeling archive sheet. */
export function createRoadmapArchivePreset(): SpreadsheetConfig {
  return {
    ...roadmapColumnsAndChrome(),
    data: createInMemoryDataStore(archiveInitial),
  };
}
