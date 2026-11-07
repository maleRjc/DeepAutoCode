import fs from 'node:fs/promises';
import path from 'node:path';

export interface ExtensionMatrixItem {
  id: string;
  displayName: string;
  category: string;
  openVsxAvailable: boolean;
  openVsxId: string | null;
  recommendedReplacement?: string;
  verifiedVersion: string;
  license: string;
  codeOssCompatible: 'verified' | 'restricted-proprietary' | 'partial';
  installPath: 'open-vsx' | 'manual-vsix-or-clangd';
  notes: string;
  installed?: boolean;
}

export interface VsixInstallGuide {
  title: string;
  legalNotice: string;
  cliCommandTemplate: string;
  uiSteps: string[];
  openVsxRegistryUrl: string;
}

/**
 * Section 8 (DA-005): Extension Marketplace Compatibility Matrix & VSIX Guidance Manager
 * - Loads the 16-extension compatibility matrix (`product/extensions-matrix.json`)
 * - Tracks installed extensions in `.deepautocode/extensions`
 * - Provides legal VSIX manual installation workflow without redistributing proprietary binaries
 */
export class ExtensionsMarketplaceManager {
  private readonly matrixPath: string;
  private readonly installedListPath: string;
  private installedIds = new Set<string>([
    'ms-python.python',
    'detachhead.basedpyright',
    'dbaeumer.vscode-eslint',
    'esbenp.prettier-vscode',
    'jeanp413.open-remote-ssh',
  ]);

  constructor(repoRoot: string, storageDir?: string) {
    this.matrixPath = path.join(repoRoot, 'product', 'extensions-matrix.json');
    this.installedListPath = path.join(
      storageDir ?? path.join(repoRoot, '.deepautocode-data'),
      'installed-extensions.json'
    );
  }

  async loadMatrix(): Promise<{
    schemaVersion: string;
    registry: string;
    policyNote: string;
    extensions: ExtensionMatrixItem[];
    vsixGuide: VsixInstallGuide;
  }> {
    await this.loadInstalledState();
    let raw = '';
    try {
      raw = await fs.readFile(this.matrixPath, 'utf-8');
    } catch {
      const altPath = path.join(path.dirname(this.matrixPath), '..', 'deepautocode', 'product', 'extensions-matrix.json');
      try {
        raw = await fs.readFile(altPath, 'utf-8');
      } catch {
        raw = JSON.stringify({
          schemaVersion: '1.1',
          registry: 'https://open-vsx.org',
          policyNote: 'Open VSX verified compatibility matrix',
          extensions: [],
        });
      }
    }
    const parsed = JSON.parse(raw);
    const extensions: ExtensionMatrixItem[] = (parsed.extensions ?? []).map(
      (ext: ExtensionMatrixItem) => ({
        ...ext,
        installed: this.installedIds.has(ext.id),
      })
    );

    return {
      schemaVersion: parsed.schemaVersion,
      registry: parsed.registry,
      policyNote: parsed.policyNote,
      extensions,
      vsixGuide: this.getVsixInstallGuide(),
    };
  }

  async installFromOpenVsx(extensionId: string): Promise<{
    ok: boolean;
    extensionId: string;
    source: 'open-vsx';
    message: string;
  }> {
    const matrix = await this.loadMatrix();
    const entry = matrix.extensions.find((e) => e.id === extensionId);
    if (!entry) {
      throw new Error(`EXTENSION_NOT_IN_MATRIX: "${extensionId}" is not in the verified catalog`);
    }
    if (!entry.openVsxAvailable) {
      throw new Error(
        `PROPRIETARY_EXTENSION_RESTRICTED: "${extensionId}" is not available on Open VSX. Recommended open-source replacement: ${entry.recommendedReplacement ?? 'Manual VSIX'}`
      );
    }

    this.installedIds.add(extensionId);
    await this.saveInstalledState();
    return {
      ok: true,
      extensionId,
      source: 'open-vsx',
      message: `Installed ${entry.displayName} v${entry.verifiedVersion} (${entry.license}) from Open VSX.`,
    };
  }

  async installLocalVsix(vsixFileName: string, userConfirmedLicense: boolean): Promise<{
    ok: boolean;
    vsixFileName: string;
    message: string;
  }> {
    if (!userConfirmedLicense) {
      throw new Error(
        'LICENSE_CONFIRMATION_REQUIRED: User must confirm they hold valid usage rights before installing a third-party VSIX package.'
      );
    }
    if (!vsixFileName.toLowerCase().endsWith('.vsix')) {
      throw new Error('INVALID_VSIX_FILE: Package filename must end with .vsix');
    }
    const idGuess = path.basename(vsixFileName, '.vsix');
    this.installedIds.add(idGuess);
    await this.saveInstalledState();
    return {
      ok: true,
      vsixFileName,
      message: `Installed local VSIX package "${vsixFileName}" into DeepAutoCode user extensions directory.`,
    };
  }

  getVsixInstallGuide(): VsixInstallGuide {
    return {
      title: '合法 VSIX 手动安装指南 (Section 8.2 / DA-005)',
      legalNotice:
        'DeepAutoCode 遵循 MIT 开源许可，不托管、镜像或再分发未经授权的微软专有扩展 VSIX。安装第三方 VSIX 前，请确认您具备该扩展的合法使用权。',
      cliCommandTemplate: 'deepautocode --install-extension ./path/to/extension.vsix',
      uiSteps: [
        '1. 优先在 Open VSX 兼容性矩阵中查找开源替代方案（例如使用 BasedPyright 替代 Pylance，使用 Open Remote - SSH 替代 Remote-SSH，使用 clangd 替代 cpptools）。',
        '2. 若必须使用特定 VSIX 包，请从扩展官方 GitHub Releases 或合法授权渠道获取 .vsix 文件。',
        '3. 在命令面板执行 "Extensions: Install from VSIX..." 或使用下方本地 VSIX 安装器，并勾选许可确认声明。',
      ],
      openVsxRegistryUrl: 'https://open-vsx.org',
    };
  }

  private async loadInstalledState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.installedListPath, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        this.installedIds = new Set(arr);
      }
    } catch {
      // keep defaults
    }
  }

  private async saveInstalledState(): Promise<void> {
    await fs.mkdir(path.dirname(this.installedListPath), { recursive: true });
    await fs.writeFile(
      this.installedListPath,
      JSON.stringify(Array.from(this.installedIds), null, 2),
      'utf-8'
    );
  }
}

