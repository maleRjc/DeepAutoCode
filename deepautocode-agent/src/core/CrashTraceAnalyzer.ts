/**
 * Runtime Crash & Stack Trace Analyzer
 * Analyzes process crash output, Segmentation Faults (SIGSEGV), Assertion Failures (SIGABRT),
 * GDB backtraces, and Python Tracebacks to provide structured root-cause diagnostics to the Agent.
 */

export type CrashSignal = 'SIGSEGV' | 'SIGABRT' | 'SIGBUS' | 'PYTHON_EXCEPTION' | 'NODE_EXCEPTION' | 'UNKNOWN_CRASH';

export interface StackFrame {
  file?: string;
  line?: number;
  column?: number;
  functionName?: string;
  rawText: string;
}

export interface CrashReport {
  isCrash: boolean;
  signal?: CrashSignal;
  exitCode?: number;
  summary: string;
  crashLocation?: {
    file: string;
    line?: number;
    functionName?: string;
  };
  frames: StackFrame[];
  actionableHint: string;
}

export class CrashTraceAnalyzer {
  /**
   * Analyze command stdout/stderr and exit code for crash indicators.
   */
  public static analyze(exitCode: number, output: string): CrashReport {
    const text = String(output || '').trim();

    // 1. Check for Segmentation Fault (SIGSEGV, 128 + 11 = 139)
    if (exitCode === 139 || /Segmentation fault|SIGSEGV/i.test(text)) {
      const gdbFrames = this.extractGdbOrAddr2lineFrames(text);
      const topFrame = gdbFrames[0];
      return {
        isCrash: true,
        signal: 'SIGSEGV',
        exitCode,
        summary: 'Segmentation fault (SIGSEGV): process attempted to access illegal or unmapped memory.',
        crashLocation: topFrame?.file ? { file: topFrame.file, line: topFrame.line, functionName: topFrame.functionName } : undefined,
        frames: gdbFrames,
        actionableHint: topFrame?.file
          ? `Crash occurred in ${topFrame.file}:${topFrame.line ?? '?'}. Inspect null pointer dereferences, array buffer overflows, or dangling pointer accesses.`
          : 'Inspect recent memory allocations, pointer accesses, or run with `gdb -batch -ex "run" -ex "bt"` / Valgrind to locate exact crash point.',
      };
    }

    // 2. Check for Assertion Failure / Abort (SIGABRT, 128 + 6 = 134)
    if (exitCode === 134 || /Assertion [`'].*['`] failed|SIGABRT|abort\(\) has been called/i.test(text)) {
      const assertMatch = text.match(/Assertion [`']([^'`]+)['`] failed/i) || text.match(/assert\(([^)]+)\)/i);
      const assertExpr = assertMatch ? assertMatch[1] : undefined;
      const fileLineMatch = text.match(/([a-zA-Z0-9_\-./\\]+\.(?:cc|cpp|c|h|hpp)):(\d+)/i);

      return {
        isCrash: true,
        signal: 'SIGABRT',
        exitCode,
        summary: `Assertion failure / Abort: ${assertExpr ? `Assertion '${assertExpr}' failed` : 'Process aborted'}.`,
        crashLocation: fileLineMatch ? { file: fileLineMatch[1], line: parseInt(fileLineMatch[2], 10) } : undefined,
        frames: [],
        actionableHint: fileLineMatch
          ? `Assertion broken at ${fileLineMatch[1]}:${fileLineMatch[2]}. Check preconditions leading up to this invariant check.`
          : 'Check assertion statements and preconditions.',
      };
    }

    // 3. Check for Python Traceback
    if (/Traceback \(most recent call last\):/i.test(text)) {
      const pyFrames = this.extractPythonFrames(text);
      const errLineMatch = text.match(/([A-Z][a-zA-Z0-9_]+Error):\s*(.*)/);
      const errName = errLineMatch ? errLineMatch[1] : 'Python Exception';
      const errMsg = errLineMatch ? errLineMatch[2] : '';
      const topFrame = pyFrames[pyFrames.length - 1]; // In Python, root cause is the last frame!

      return {
        isCrash: true,
        signal: 'PYTHON_EXCEPTION',
        exitCode,
        summary: `${errName}: ${errMsg || 'Unhandled Python exception'}`,
        crashLocation: topFrame?.file ? { file: topFrame.file, line: topFrame.line, functionName: topFrame.functionName } : undefined,
        frames: pyFrames,
        actionableHint: topFrame?.file
          ? `Exception thrown at ${topFrame.file}:${topFrame.line} in ${topFrame.functionName || 'unknown'}. Check: ${topFrame.rawText}`
          : 'Inspect the stack trace frames above for the error origin.',
      };
    }

    // 4. Check for Node.js / JavaScript Unhandled Error
    if (/(?:ReferenceError|TypeError|SyntaxError|RangeError):\s+/i.test(text)) {
      const jsFrames = this.extractNodeFrames(text);
      const topFrame = jsFrames[0];
      const match = text.match(/([A-Za-z]+Error):\s*(.*)/);
      const errName = match ? match[1] : 'JavaScript Error';
      const errMsg = match ? match[2] : '';

      return {
        isCrash: true,
        signal: 'NODE_EXCEPTION',
        exitCode,
        summary: `${errName}: ${errMsg}`,
        crashLocation: topFrame?.file ? { file: topFrame.file, line: topFrame.line, functionName: topFrame.functionName } : undefined,
        frames: jsFrames,
        actionableHint: topFrame?.file
          ? `Error triggered at ${topFrame.file}:${topFrame.line}.`
          : 'Inspect recent JavaScript/TypeScript edits.',
      };
    }

    return {
      isCrash: false,
      exitCode,
      summary: exitCode === 0 ? 'Process completed cleanly' : `Process exited with code ${exitCode}`,
      frames: [],
      actionableHint: '',
    };
  }

  private static extractPythonFrames(text: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const frameRegex = /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+([a-zA-Z0-9_<>]+))?\r?\n\s*(.*)/g;
    let match: RegExpExecArray | null;
    while ((match = frameRegex.exec(text)) !== null) {
      frames.push({
        file: match[1],
        line: parseInt(match[2], 10),
        functionName: match[3],
        rawText: match[4]?.trim() || '',
      });
    }
    return frames;
  }

  private static extractNodeFrames(text: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const frameRegex = /at\s+(?:([a-zA-Z0-9_$.<>]+)\s+\()?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+):(\d+):(\d+)\)?/g;
    let match: RegExpExecArray | null;
    while ((match = frameRegex.exec(text)) !== null) {
      frames.push({
        functionName: match[1],
        file: match[2],
        line: parseInt(match[3], 10),
        column: parseInt(match[4], 10),
        rawText: match[0],
      });
    }
    return frames;
  }

  private static extractGdbOrAddr2lineFrames(text: string): StackFrame[] {
    const frames: StackFrame[] = [];
    // Matches GDB frames: #0  0x00007fff in func () at file.cc:123
    const gdbRegex = /#\d+\s+(?:0x[0-9a-fA-F]+\s+in\s+)?([a-zA-Z0-9_:]+)?\s*(?:\([^)]*\))?\s+at\s+([a-zA-Z0-9_\-./\\]+):(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = gdbRegex.exec(text)) !== null) {
      frames.push({
        functionName: match[1],
        file: match[2],
        line: parseInt(match[3], 10),
        rawText: match[0],
      });
    }
    return frames;
  }
}

