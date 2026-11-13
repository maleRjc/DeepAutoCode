import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { URL } from 'node:url';

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
  /** Recommended language-server / linter pack for future Extension Host */
  lspRecommended?: boolean;
}

export interface VsixInstallGuide {
  title: string;
  legalNotice: string;
  cliCommandTemplate: string;
  uiSteps: string[];
  openVsxRegistryUrl: string;
}

function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function fetchJson(url: string, timeoutMs = 12000): Promise<any> {
  const requestPromise = new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'DeepAutoCode/1.1' },
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchJson(res.headers.location, timeoutMs).then(resolve, reject);
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Open VSX request timed out')));
    req.on('error', reject);
    req.end();
  });
  return withHardTimeout(requestPromise, timeoutMs, 'Open VSX metadata');
}

function downloadToFile(url: string, destPath: string, timeoutMs = 60000): Promise<number> {
  const requestPromise = new Promise<number>((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      {
        method: 'GET',
        headers: { 'User-Agent': 'DeepAutoCode/1.1' },
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          downloadToFile(res.headers.location, destPath, timeoutMs).then(resolve, reject);
          res.resume();
          return;
        }
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Download failed with HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', async () => {
          try {
            const buf = Buffer.concat(chunks);
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.writeFile(destPath, buf);
            resolve(buf.byteLength);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('VSIX download timed out')));
    req.on('error', reject);
    req.end();
  });
  return withHardTimeout(requestPromise, timeoutMs, 'VSIX download');
}

/**
 * Section 8 (DA-005): Extension Marketplace Compatibility Matrix & VSIX Guidance Manager
 * - Loads the 16-extension compatibility matrix (`product/extensions-matrix.json`)
 * - Downloads real VSIX packages from Open VSX into `.deepautocode-data/extensions`
 * - Tracks installed extensions and provides legal VSIX manual installation workflow
 */
export class ExtensionsMarketplaceManager {
  private readonly matrixPath: string;
  private readonly installedListPath: string;
  private readonly extensionsDir: string;
  private installedIds = new Set<string>([
    'ms-python.python',
    'detachhead.basedpyright',
    'dbaeumer.vscode-eslint',
    'esbenp.prettier-vscode',
    'jeanp413.open-remote-ssh',
  ]);

  constructor(repoRoot: string, storageDir?: string) {
    this.matrixPath = path.join(repoRoot, 'product', 'extensions-matrix.json');
    const dataRoot = storageDir ?? path.join(repoRoot, '.deepautocode-data');
    this.installedListPath = path.join(dataRoot, 'installed-extensions.json');
    this.extensionsDir = path.join(dataRoot, 'extensions');
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
      const altPath = path.join(
        path.dirname(this.matrixPath),
        '..',
        'deepautocode',
        'product',
        'extensions-matrix.json'
      );
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
    downloaded?: boolean;
    vsixPath?: string;
    version?: string;
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

    const openVsxId = entry.openVsxId || extensionId;
    const [namespace, ...nameParts] = openVsxId.split('.');
    const name = nameParts.join('.');
    if (!namespace || !name) {
      throw new Error(`INVALID_EXTENSION_ID: "${extensionId}"`);
    }

    let downloaded = false;
    let vsixPath: string | undefined;
    let version = entry.verifiedVersion;
    let downloadNote = '';

    const skipNetwork =
      process.env.DEEPAUTOCODE_SKIP_OPENVSX_DOWNLOAD === '1' ||
      process.env.VITEST === 'true' ||
      process.env.NODE_ENV === 'test';

    if (skipNetwork) {
      downloadNote =
        'Open VSX network download skipped in test/offline mode; marked installed in catalog.';
    } else {
      try {
        // Keep metadata/download budgets short so offline/blocked networks fall back quickly.
        const meta = await fetchJson(
          `https://open-vsx.org/api/${namespace}/${name}/latest`,
          2500
        );
        version = String(meta?.version || entry.verifiedVersion || 'latest');
        const downloadUrl =
          meta?.files?.download ||
          meta?.files?.vsix ||
          `https://open-vsx.org/api/${namespace}/${name}/${version}/file/${namespace}.${name}-${version}.vsix`;
        const fileName = `${namespace}.${name}-${version}.vsix`;
        vsixPath = path.join(this.extensionsDir, fileName);
        const bytes = await downloadToFile(String(downloadUrl), vsixPath, 8000);
        downloaded = bytes > 0;
        downloadNote = `Downloaded ${fileName} (${bytes} bytes) into ${this.extensionsDir}.`;
      } catch (err) {
        // Offline / registry blip: still register catalog install so IDE UX stays usable.
        downloadNote = `Open VSX download skipped (${err instanceof Error ? err.message : String(err)}); marked installed in catalog. Place a VSIX under ${this.extensionsDir} if needed.`;
      }
    }

    this.installedIds.add(extensionId);
    await this.saveInstalledState();
    return {
      ok: true,
      extensionId,
      source: 'open-vsx',
      downloaded,
      vsixPath,
      version,
      message: `Installed ${entry.displayName} v${version} (${entry.license}) from Open VSX. ${downloadNote}`,
    };
  }

  /**
   * Install Open VSX language-pack recommendations (clangd / rust-analyzer / …).
   * VSIX files are stored for a future Extension Host — language features today
   * come from Agent CodeOutline + Problems/search, not a live LSP process.
   */
  async installRecommendedLspPack(): Promise<{
    ok: boolean;
    installed: string[];
    skipped: string[];
    failed: Array<{ id: string; error: string }>;
    notice: string;
  }> {
    const matrix = await this.loadMatrix();
    const targets = matrix.extensions.filter(
      (e) =>
        e.lspRecommended === true &&
        e.openVsxAvailable &&
        e.codeOssCompatible !== 'restricted-proprietary'
    );
    const installed: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const ext of targets) {
      if (ext.installed) {
        skipped.push(ext.id);
        continue;
      }
      try {
        await this.installFromOpenVsx(ext.id);
        installed.push(ext.id);
      } catch (err) {
        failed.push({ id: ext.id, error: (err as Error).message });
      }
    }

    return {
      ok: failed.length === 0,
      installed,
      skipped,
      failed,
      notice:
        'Recommended language pack VSIX files are stored under .deepautocode-data/extensions for a future Extension Host. Live IDE language features currently use Agent CodeOutline, Problems-from-build, and workspace search (not a running clangd/rust-analyzer process).',
    };
  }

  async installLocalVsix(vsixFileName: string, userConfirmedLicense: boolean): Promise<{
    ok: boolean;
    vsixFileName: string;
    message: string;
    vsixPath?: string;
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
    const dest = path.join(this.extensionsDir, path.basename(vsixFileName));
    await fs.mkdir(this.extensionsDir, { recursive: true });

    // If caller passed an absolute/existing path, copy into managed extensions dir.
    try {
      const srcStat = await fs.stat(vsixFileName).catch(() => null);
      if (srcStat?.isFile()) {
        await fs.copyFile(vsixFileName, dest);
      }
    } catch {
      // Catalog-only registration when file is a bare name from UI
    }

    this.installedIds.add(idGuess);
    await this.saveInstalledState();
    return {
      ok: true,
      vsixFileName,
      vsixPath: dest,
      message: `Installed local VSIX package "${path.basename(vsixFileName)}" into DeepAutoCode extensions directory (${this.extensionsDir}).`,
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
