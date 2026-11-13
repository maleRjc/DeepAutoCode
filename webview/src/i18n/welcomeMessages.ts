import type { AppLocale } from './types.js';

type Dict = Record<string, string>;

export const WELCOME_MESSAGES: Record<AppLocale, Dict> = {
  en: {
    'welcome.version': 'v1.1 Agentic IDE',
    'welcome.subtitle.empty':
      'AI-Native Agentic IDE — Open a local folder or connect to a remote SSH host to start building',
    'welcome.subtitle.active':
      'Active Workspace: {name} — Select a file from Explorer or press Ctrl+P to jump to code',
    'welcome.openFolder': 'Open Folder',
    'welcome.openFolder.desc': 'Open a local repository or project directory',
    'welcome.ssh': 'Connect via SSH',
    'welcome.ssh.desc': 'Develop on a remote Linux server or GPU cluster',
    'welcome.models': 'Configure AI Models',
    'welcome.models.desc': 'Set up DeepSeek, OpenAI-Compatible, or Claude keys',
    'welcome.recent': 'Recent Workspaces & Remote Hosts',
    'welcome.recent.empty':
      'No recent workspaces yet. Choose Open Folder or Connect via SSH above to open your first project.',
    'welcome.local': 'LOCAL',
    'welcome.sshBadge': 'SSH',
    'welcome.shortcuts': 'Quick Shortcuts & Navigation',
    'welcome.shortcut.palette': 'Command Palette',
    'welcome.shortcut.ai': 'Toggle AI Agent Dock',
    'welcome.shortcut.terminal': 'Toggle Terminal & Output',
    'welcome.shortcut.explorer': 'Toggle Project Explorer',
    'welcome.noFolder': 'No Folder Opened',
    'welcome.lang': 'Language',
    'welcome.explorer.empty': 'You have not yet opened a folder.',
    'welcome.explorer.ssh': 'Connect to SSH Host...',
    'welcome.explorer.recent': 'RECENT FOLDERS',
  },
  'zh-CN': {
    'welcome.version': 'v1.1 Agentic IDE',
    'welcome.subtitle.empty':
      'AI 原生 Agent 工作台 — 打开本地文件夹，或连接远程 SSH 主机开始编码',
    'welcome.subtitle.active':
      '当前工作区：{name} — 从资源管理器选择文件，或按 Ctrl+P 跳转代码',
    'welcome.openFolder': '打开文件夹',
    'welcome.openFolder.desc': '打开本地仓库或项目目录',
    'welcome.ssh': '通过 SSH 连接',
    'welcome.ssh.desc': '在远程 Linux 服务器或 GPU 集群上开发',
    'welcome.models': '配置 AI 模型',
    'welcome.models.desc': '设置 DeepSeek、OpenAI 兼容或 Claude 密钥',
    'welcome.recent': '最近工作区与远程主机',
    'welcome.recent.empty':
      '暂无最近工作区。请选择上方的「打开文件夹」或「通过 SSH 连接」打开第一个项目。',
    'welcome.local': '本地',
    'welcome.sshBadge': 'SSH',
    'welcome.shortcuts': '快捷键与导航',
    'welcome.shortcut.palette': '命令面板',
    'welcome.shortcut.ai': '切换 AI Agent 面板',
    'welcome.shortcut.terminal': '切换终端与输出',
    'welcome.shortcut.explorer': '切换项目资源管理器',
    'welcome.noFolder': '未打开文件夹',
    'welcome.lang': '界面语言',
    'welcome.explorer.empty': '尚未打开文件夹。',
    'welcome.explorer.ssh': '连接到 SSH 主机...',
    'welcome.explorer.recent': '最近文件夹',
  },
  'zh-TW': {
    'welcome.version': 'v1.1 Agentic IDE',
    'welcome.subtitle.empty':
      'AI 原生 Agent 工作台 — 開啟本機資料夾，或連線遠端 SSH 主機開始編碼',
    'welcome.subtitle.active':
      '目前工作區：{name} — 從檔案總管選擇檔案，或按 Ctrl+P 跳轉程式碼',
    'welcome.openFolder': '開啟資料夾',
    'welcome.openFolder.desc': '開啟本機存放庫或專案目錄',
    'welcome.ssh': '透過 SSH 連線',
    'welcome.ssh.desc': '在遠端 Linux 伺服器或 GPU 叢集上開發',
    'welcome.models': '組態 AI 模型',
    'welcome.models.desc': '設定 DeepSeek、OpenAI 相容或 Claude 金鑰',
    'welcome.recent': '最近工作區與遠端主機',
    'welcome.recent.empty':
      '尚無最近工作區。請選擇上方的「開啟資料夾」或「透過 SSH 連線」開啟第一個專案。',
    'welcome.local': '本機',
    'welcome.sshBadge': 'SSH',
    'welcome.shortcuts': '快速鍵與導覽',
    'welcome.shortcut.palette': '命令選擇區',
    'welcome.shortcut.ai': '切換 AI Agent 面板',
    'welcome.shortcut.terminal': '切換終端機與輸出',
    'welcome.shortcut.explorer': '切換專案檔案總管',
    'welcome.noFolder': '未開啟資料夾',
    'welcome.lang': '介面語言',
    'welcome.explorer.empty': '尚未開啟資料夾。',
    'welcome.explorer.ssh': '連線到 SSH 主機...',
    'welcome.explorer.recent': '最近資料夾',
  },
};
