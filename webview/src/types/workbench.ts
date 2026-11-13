export interface OpenTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  kind: 'code' | 'diff' | 'settings' | 'preview' | 'guide' | 'image';
  diffRecord?: any;
}

export interface TerminalEntry {
  id: string;
  cmd: string;
  output: string;
  exitCode: number;
  durationMs: number;
  ts: string;
}

export type SettingsCategory =
  | 'general'
  | 'models'
  | 'security'
  | 'rules'
  | 'mcp'
  | 'extensions';

export type GuideSectionId =
  | 'quickstart'
  | 'workbench'
  | 'modes'
  | 'workflows'
  | 'inline'
  | 'artifacts'
  | 'agent'
  | 'preview-ssh'
  | 'shortcuts';

export interface SplitDiffRow {
  leftLine?: number;
  leftText?: string;
  leftType?: 'del' | 'normal' | 'empty' | 'hdr';
  rightLine?: number;
  rightText?: string;
  rightType?: 'add' | 'normal' | 'empty' | 'hdr';
}

export interface SshFormState {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'agent-or-default-key' | 'identity-file' | 'local-loopback';
  password: string;
  identityFile: string;
  remotePath: string;
}

