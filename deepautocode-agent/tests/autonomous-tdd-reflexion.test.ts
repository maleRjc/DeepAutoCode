import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReproFirstTddLoop } from '../src/core/ReproFirstTddLoop.js';
import { ReflexionBacktracker } from '../src/core/ReflexionBacktracker.js';
import { CrashTraceAnalyzer } from '../src/core/CrashTraceAnalyzer.js';

describe('Autonomous Engineering: TDD Loop, Reflexion, & Crash Analyzer', () => {
  let tmpSandbox: string;

  beforeAll(async () => {
    tmpSandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-reflexion-test-'));
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpSandbox, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('ReproFirstTddLoop', () => {
    it('executes full state machine flow from Red to Green to Regression', () => {
      const loop = new ReproFirstTddLoop();
      expect(loop.getPhase()).toBe('IDENTIFY_REPRO');

      // 1. Identify repro
      loop.setReproCommand('npm test tests/bug.test.ts');
      expect(loop.getPhase()).toBe('CONFIRM_RED');

      // 2. Confirm Red (must fail on unfixed code)
      const redRes = loop.recordRedExecution(1, 'AssertionError: expected false to be true');
      expect(redRes.validRed).toBe(true);
      expect(loop.getPhase()).toBe('APPLY_FIX');

      // 3. Confirm Green (must pass after fix)
      loop.setRegressionCommand('npm test');
      const greenRes = loop.recordGreenExecution(0, 'Tests: 1 passed, 1 total');
      expect(greenRes.validGreen).toBe(true);
      expect(loop.getPhase()).toBe('REGRESSION_GATE');

      // 4. Regression Gate
      const regRes = loop.recordRegressionExecution(0, 'All 50 tests passed');
      expect(regRes.passed).toBe(true);
      expect(loop.getPhase()).toBe('COMPLETED');
    });

    it('rejects false-positive repro when test unexpectedly passes in CONFIRM_RED', () => {
      const loop = new ReproFirstTddLoop();
      loop.setReproCommand('npm test tests/bug.test.ts');

      const falsePositive = loop.recordRedExecution(0, 'Tests: 1 passed');
      expect(falsePositive.validRed).toBe(false);
      expect(falsePositive.message).toContain('WARNING: The reproduction test passed on unfixed code');
      expect(loop.getPhase()).toBe('CONFIRM_RED'); // Remains in CONFIRM_RED
    });
  });

  describe('ReflexionBacktracker', () => {
    it('tracks attempts and generates Reflexion Note when reaching maxAttempts', async () => {
      const backtracker = new ReflexionBacktracker({
        workspaceRoot: tmpSandbox,
        maxAttemptsPerHypothesis: 2,
        isWorktreeSandbox: true,
      });

      backtracker.startHypothesis('Off-by-one error in buffer indexing');

      // Attempt 1 fails
      const r1 = backtracker.recordFailure('IndexOutOfBoundsException at line 45');
      expect(r1.shouldBacktrack).toBe(false);

      // Attempt 2 fails -> reaches limit -> triggers backtrack
      const r2 = backtracker.recordFailure('IndexOutOfBoundsException at line 45');
      expect(r2.shouldBacktrack).toBe(true);

      const btResult = await backtracker.backtrack('Indexing buffer overflow');
      expect(btResult.ok).toBe(true);
      expect(btResult.reflexionPrompt).toContain('REFLEXION & BACKTRACK TRIGGERED');
      expect(btResult.reflexionPrompt).toContain('alternative hypothesis (Plan B)');
    });

    it('refuses to perform git reset on non-sandbox main directory', async () => {
      const backtracker = new ReflexionBacktracker({
        workspaceRoot: 'C:\\Users\\ProductionProject',
        maxAttemptsPerHypothesis: 1,
        isWorktreeSandbox: false, // explicitly non-sandbox
      });

      backtracker.startHypothesis('Dangerous hypothesis');
      const r = backtracker.recordFailure('Failed');
      expect(r.shouldBacktrack).toBe(true);

      const btResult = await backtracker.backtrack();
      expect(btResult.reverted).toBe(false); // rollback blocked by safety guard
    });
  });

  describe('CrashTraceAnalyzer', () => {
    it('analyzes SIGSEGV (139) and extracts GDB frame location', () => {
      const output = [
        'Program received signal SIGSEGV, Segmentation fault.',
        '#0  0x00007ffff7dd5234 in ncclSend (sendbuff=0x0, count=1024) at src/sendrecv.cc:42',
        '#1  0x0000555555555189 in main () at test/main.cc:88',
      ].join('\n');

      const report = CrashTraceAnalyzer.analyze(139, output);
      expect(report.isCrash).toBe(true);
      expect(report.signal).toBe('SIGSEGV');
      expect(report.crashLocation?.file).toBe('src/sendrecv.cc');
      expect(report.crashLocation?.line).toBe(42);
      expect(report.crashLocation?.functionName).toBe('ncclSend');
      expect(report.frames.length).toBeGreaterThanOrEqual(1);
    });

    it('analyzes SIGABRT (134) and extracts failed assertion expression', () => {
      const output = 'test_app: src/buffer.cc:105: void flush(): Assertion `count > 0` failed.\nAborted';
      const report = CrashTraceAnalyzer.analyze(134, output);

      expect(report.isCrash).toBe(true);
      expect(report.signal).toBe('SIGABRT');
      expect(report.summary).toContain("Assertion 'count > 0' failed");
      expect(report.crashLocation?.file).toBe('src/buffer.cc');
      expect(report.crashLocation?.line).toBe(105);
    });

    it('analyzes Python Uncaught Traceback', () => {
      const output = [
        'Traceback (most recent call last):',
        '  File "/app/service/runner.py", line 58, in execute',
        '    result = compute_matrix(data)',
        '  File "/app/service/math_ops.py", line 12, in compute_matrix',
        '    return 1 / denominator',
        'ZeroDivisionError: division by zero',
      ].join('\n');

      const report = CrashTraceAnalyzer.analyze(1, output);
      expect(report.isCrash).toBe(true);
      expect(report.signal).toBe('PYTHON_EXCEPTION');
      expect(report.summary).toContain('ZeroDivisionError: division by zero');
      expect(report.crashLocation?.file).toBe('/app/service/math_ops.py');
      expect(report.crashLocation?.line).toBe(12);
    });
  });
});
