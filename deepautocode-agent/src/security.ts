import fs from 'node:fs';
import path from 'node:path';
import type { AgentExecutionMode, RiskLevel } from './types.js';

/**
 * Section 9.1: Secret Redaction & Credential Store Interface
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{12,}/g,
  /Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi,
  /(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*["']?([^"'\s,}]{6,})["']?/gi,
];

export function redactSensitiveText(input: string): string {
  if (!input) return input;
  let result = input;
  result = result.replace(/sk-[a-zA-Z0-9_-]{8,}/g, (match) => {
    const prefix = match.slice(0, 5);
    return `${prefix}***REDACTED***`;
  });
  result = result.replace(/Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer ***REDACTED***');
  result = result.replace(
    /(api[_-]?key|secret|token|password|authorization)(\s*[:=]\s*["']?)([^"'\s,}]{4,})(["']?)/gi,
    (_full, key, sep, _val, tail) => `${key}${sep}***REDACTED***${tail}`
  );
  return result;
}

export function sanitizeObjectForLog<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactSensitiveText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObjectForLog(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api[_-]?key|secret|token|password|authorization|credential)$/i.test(k)) {
        output[k] = typeof v === 'string' && v.length > 0 ? '***REDACTED***' : null;
      } else {
        output[k] = sanitizeObjectForLog(v);
      }
    }
    return output as T;
  }
  return value;
}

/**
 * Section 9.2: Path Canonicalization & Symlink Escape Protection
 */
export interface PathValidationResult {
  valid: boolean;
  canonicalPath: string;
  relativePath: string;
  reason?: string;
}

export function validateWorkspacePath(
  targetPath: string,
  workspaceRoot: string,
  options: { allowNonExistent?: boolean } = { allowNonExistent: true }
): PathValidationResult {
  if (!targetPath || typeof targetPath !== 'string') {
    return {
      valid: false,
      canonicalPath: '',
      relativePath: '',
      reason: 'Target path must be a non-empty string',
    };
  }

  if (targetPath.includes('\0')) {
    return {
      valid: false,
      canonicalPath: '',
      relativePath: '',
      reason: 'Null byte injection detected in path',
    };
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  let realRoot = resolvedRoot;
  try {
    if (fs.existsSync(resolvedRoot)) {
      realRoot = fs.realpathSync(resolvedRoot);
    }
  } catch {
    realRoot = resolvedRoot;
  }

  let normalizedTarget = targetPath.trim();
  const rootBaseName = path.basename(realRoot);

  // If running on Windows and targetPath is a remote Linux absolute path (e.g. "/home/renjc01/Bug/fhccl/nccl-test/src/sendrecv.cc")
  // that contains the active workspace folder name ("/fhccl/"), map it to the workspace-relative path ("nccl-test/src/sendrecv.cc").
  if (
    process.platform === 'win32' &&
    normalizedTarget.startsWith('/') &&
    !normalizedTarget.startsWith('//') &&
    rootBaseName
  ) {
    const marker = `/${rootBaseName}/`;
    const lastIdx = normalizedTarget.lastIndexOf(marker);
    if (lastIdx >= 0) {
      normalizedTarget = normalizedTarget.slice(lastIdx + marker.length);
    } else if (normalizedTarget.endsWith(`/${rootBaseName}`)) {
      normalizedTarget = '.';
    }
  }

  // If relative path accidentally prefixes the workspace folder name (e.g. "fhccl/src/init.cc" inside ".../fhccl"),
  // strip the redundant prefix when the unprefixed path exists or the prefixed one does not.
  if (!path.isAbsolute(normalizedTarget) && rootBaseName) {
    const slashNorm = normalizedTarget.replace(/\\/g, '/').replace(/^\.\//, '');
    if (slashNorm.startsWith(`${rootBaseName}/`)) {
      const withoutPrefix = slashNorm.slice(rootBaseName.length + 1);
      if (
        withoutPrefix &&
        !fs.existsSync(path.resolve(realRoot, normalizedTarget))
      ) {
        normalizedTarget = withoutPrefix;
      }
    }
  }

  const candidateAbs = path.isAbsolute(normalizedTarget)
    ? path.resolve(normalizedTarget)
    : path.resolve(realRoot, normalizedTarget);

  // Check lexical traversal first
  const lexicalRel = path.relative(realRoot, candidateAbs);
  if (lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel)) {
    return {
      valid: false,
      canonicalPath: candidateAbs,
      relativePath: lexicalRel,
      reason: `Path traversal outside workspace root (${realRoot}) is forbidden`,
    };
  }

  // Resolve real path to block symlink escape
  try {
    if (fs.existsSync(candidateAbs)) {
      const realTarget = fs.realpathSync(candidateAbs);
      const realRel = path.relative(realRoot, realTarget);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return {
          valid: false,
          canonicalPath: realTarget,
          relativePath: realRel,
          reason: `Symlink escape outside workspace root (${realRoot}) detected`,
        };
      }
      return {
        valid: true,
        canonicalPath: realTarget,
        relativePath: realRel.replace(/\\/g, '/'),
      };
    } else {
      if (!options.allowNonExistent) {
        return {
          valid: false,
          canonicalPath: candidateAbs,
          relativePath: lexicalRel,
          reason: `Target path does not exist: ${candidateAbs}`,
        };
      }
      // Walk up to nearest existing parent to check parent symlink escapes
      let parentDir = path.dirname(candidateAbs);
      while (parentDir !== path.dirname(parentDir) && !fs.existsSync(parentDir)) {
        parentDir = path.dirname(parentDir);
      }
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        const parentRel = path.relative(realRoot, realParent);
        if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
          return {
            valid: false,
            canonicalPath: candidateAbs,
            relativePath: parentRel,
            reason: `Parent directory symlink escape outside workspace root (${realRoot}) detected`,
          };
        }
      }
      return {
        valid: true,
        canonicalPath: candidateAbs,
        relativePath: lexicalRel.replace(/\\/g, '/'),
      };
    }
  } catch (err) {
    return {
      valid: false,
      canonicalPath: candidateAbs,
      relativePath: lexicalRel,
      reason: `Failed to validate realpath: ${(err as Error).message}`,
    };
  }
}

/**
 * Section 9.2: Command Risk Classification & Execution Policy
 */
const CRITICAL_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\s+(\/|~|\*|\.\.)/i,
  /\b(mkfs|dd\s+if=|format\s+[a-zA-Z]:|shutdown|reboot)\b/i,
  /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|pwsh|powershell)/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bRemove-Item\b.*-Recurse.*-Force/i,
];

const HIGH_RISK_COMMAND_PATTERNS: RegExp[] = [
  /\b(rm|del|rmdir|Remove-Item)\b/i,
  /\b(npm|pnpm|yarn|pip)\s+(publish|install\s+-g)\b/i,
  /\bgit\s+(push|clean|checkout\s+--)\b/i,
  /\b(chmod|chown|icacls)\b/i,
  /\b(docker|kubectl)\s+(run|exec|delete|rm)\b/i,
];

const ALLOWLIST_SAFE_COMMAND_PREFIXES: RegExp[] = [
  /^(npm|pnpm|yarn)\s+(test|run\s+lint|run\s+typecheck|run\s+build)\b/i,
  /^git\s+(status|diff|log|branch|show)\b/i,
  /^(node|tsc|vitest)\s+(--version|-v)\b/i,
  /^(ls|pwd|echo|cat|type|Get-ChildItem)\b/i,
];

export interface PolicyEvaluation {
  allowedToProceed: boolean;
  requiresApproval: boolean;
  risk: RiskLevel;
  reason: string;
}

export function classifyCommandRisk(command: string): RiskLevel {
  const trimmed = command.trim();
  for (const pattern of CRITICAL_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) return 'critical';
  }
  for (const pattern of HIGH_RISK_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) return 'high';
  }
  for (const pattern of ALLOWLIST_SAFE_COMMAND_PREFIXES) {
    if (pattern.test(trimmed)) return 'low';
  }
  return 'medium';
}

export function evaluateToolPolicy(params: {
  toolName: string;
  executionMode: AgentExecutionMode;
  isReadOnlyTool: boolean;
  command?: string;
  targetPath?: string;
  workspaceRoot: string;
}): PolicyEvaluation {
  const { toolName, executionMode, isReadOnlyTool, command, targetPath, workspaceRoot } = params;

  // Validate workspace path if targetPath is supplied
  if (targetPath) {
    const isSshMirrorWorkspace =
      typeof workspaceRoot === 'string' && workspaceRoot.includes('ssh-mirrors');
    const pathCheck = validateWorkspacePath(targetPath, workspaceRoot, {
      allowNonExistent: !isReadOnlyTool || toolName === 'reveal-diff' || isSshMirrorWorkspace,
    });
    if (!pathCheck.valid) {
      return {
        allowedToProceed: false,
        requiresApproval: false,
        risk: 'critical',
        reason: pathCheck.reason || 'Workspace path boundary violation',
      };
    }
  }

  // Section 9.2: Plan mode strictly stays read-only
  if (executionMode === 'plan' && !isReadOnlyTool) {
    return {
      allowedToProceed: false,
      requiresApproval: false,
      risk: 'high',
      reason: `Plan mode is strictly read-only. Tool "${toolName}" is blocked until switched to Auto or Manual mode.`,
    };
  }

  if (isReadOnlyTool) {
    return {
      allowedToProceed: true,
      requiresApproval: false,
      risk: 'low',
      reason: 'Read-only operation within workspace boundary',
    };
  }

  if (command) {
    const risk = classifyCommandRisk(command);
    if (executionMode === 'auto' && risk !== 'critical') {
      return {
        allowedToProceed: true,
        requiresApproval: false,
        risk,
        reason: 'Command matches Auto mode autonomous execution policy',
      };
    }
    return {
      allowedToProceed: true,
      requiresApproval: true,
      risk,
      reason: `Command execution requires user approval (risk=${risk}, mode=${executionMode})`,
    };
  }

  // File write / diff apply operations
  if (
    executionMode === 'auto' &&
    (toolName === 'open-file' || toolName === 'reveal-diff' || toolName === 'write-file')
  ) {
    return {
      allowedToProceed: true,
      requiresApproval: false,
      risk: toolName === 'write-file' ? 'medium' : 'low',
      reason: 'Workspace-scoped file edit or UI capability allowed in Auto mode',
    };
  }

  return {
    allowedToProceed: true,
    requiresApproval: true,
    risk: toolName === 'write-file' ? 'medium' : 'medium',
    reason: `Mutating tool "${toolName}" requires user approval`,
  };
}

