/**
 * Reproduction-First TDD Verification Loop
 * Inspired by SWE-bench state-of-the-art methodology (Red -> Green -> Regression).
 * Enforces that before modifying any business logic, an autonomous agent must:
 * 1. Locate or author a reproduction test case.
 * 2. Confirm the test fails on unfixed code (CONFIRM_RED).
 * 3. Apply the targeted code fix (APPLY_FIX).
 * 4. Confirm the test now passes (CONFIRM_GREEN).
 * 5. Run broader regression tests to guarantee zero regressions (REGRESSION_GATE).
 */

export type TddPhase =
  | 'IDENTIFY_REPRO'
  | 'CONFIRM_RED'
  | 'APPLY_FIX'
  | 'CONFIRM_GREEN'
  | 'REGRESSION_GATE'
  | 'COMPLETED';

export interface TddStateSnapshot {
  phase: TddPhase;
  reproCommand?: string;
  regressionCommand?: string;
  isRedConfirmed: boolean;
  isGreenConfirmed: boolean;
  isRegressionPassed: boolean;
  redOutput?: string;
  greenOutput?: string;
  regressionOutput?: string;
  startedAt: number;
  completedAt?: number;
}

export class ReproFirstTddLoop {
  private phase: TddPhase = 'IDENTIFY_REPRO';
  private reproCommand?: string;
  private regressionCommand?: string;
  private isRedConfirmed = false;
  private isGreenConfirmed = false;
  private isRegressionPassed = false;
  private redOutput?: string;
  private greenOutput?: string;
  private regressionOutput?: string;
  private readonly startedAt: number = Date.now();
  private completedAt?: number;

  public getPhase(): TddPhase {
    return this.phase;
  }

  public setReproCommand(cmd: string): void {
    this.reproCommand = cmd.trim();
    if (this.phase === 'IDENTIFY_REPRO') {
      this.phase = 'CONFIRM_RED';
    }
  }

  public setRegressionCommand(cmd: string): void {
    this.regressionCommand = cmd.trim();
  }

  /**
   * Record the outcome of executing the reproduction test on unfixed code.
   */
  public recordRedExecution(exitCode: number, output: string): {
    validRed: boolean;
    message: string;
  } {
    this.redOutput = output;
    // An exit code != 0 or explicit failure string confirms the bug is successfully reproduced
    const failed = exitCode !== 0 || /FAIL|assert|error|exception/i.test(output);

    if (failed) {
      this.isRedConfirmed = true;
      this.phase = 'APPLY_FIX';
      return {
        validRed: true,
        message: 'CONFIRM_RED SUCCESS: Bug successfully reproduced! Proceed to APPLY_FIX in worktree.',
      };
    } else {
      return {
        validRed: false,
        message:
          'CONFIRM_RED WARNING: The reproduction test passed on unfixed code! Your test does NOT reproduce the issue or the bug is already absent. Refine the reproduction test before editing code.',
      };
    }
  }

  /**
   * Record the outcome of executing the reproduction test after the code fix.
   */
  public recordGreenExecution(exitCode: number, output: string): {
    validGreen: boolean;
    message: string;
  } {
    this.greenOutput = output;
    const passed = exitCode === 0 && !/FAIL/i.test(output);

    if (passed) {
      this.isGreenConfirmed = true;
      this.phase = this.regressionCommand ? 'REGRESSION_GATE' : 'COMPLETED';
      if (this.phase === 'COMPLETED') {
        this.completedAt = Date.now();
      }
      return {
        validGreen: true,
        message: `CONFIRM_GREEN SUCCESS: Reproduction test now passes! Proceeding to ${this.phase}.`,
      };
    } else {
      return {
        validGreen: false,
        message: 'CONFIRM_GREEN FAILED: The reproduction test is still failing after your fix. Re-examine the code edit.',
      };
    }
  }

  /**
   * Record the outcome of the full regression test suite.
   */
  public recordRegressionExecution(exitCode: number, output: string): {
    passed: boolean;
    message: string;
  } {
    this.regressionOutput = output;
    const passed = exitCode === 0;

    if (passed) {
      this.isRegressionPassed = true;
      this.phase = 'COMPLETED';
      this.completedAt = Date.now();
      return {
        passed: true,
        message: 'REGRESSION_GATE SUCCESS: 0 regressions detected. Task completed successfully.',
      };
    } else {
      return {
        passed: false,
        message: 'REGRESSION_GATE FAILED: Broader test suite broke! Your fix introduced a regression.',
      };
    }
  }

  /**
   * Get active guidance prompt for the LLM based on the current TDD phase.
   */
  public getPhaseGuidance(): string {
    switch (this.phase) {
      case 'IDENTIFY_REPRO':
        return 'TDD Protocol: Please locate or author a targeted reproduction script/test first (e.g. `python repro.py` or unit test). Do NOT edit business code yet.';
      case 'CONFIRM_RED':
        return `TDD Protocol: Run reproduction command (\`${this.reproCommand}\`) via \`run_command\` and confirm it FAILS on current code (RED state).`;
      case 'APPLY_FIX':
        return 'TDD Protocol: Bug is confirmed reproduced (RED). Now apply the minimal, surgical fix via `edit_file` in the workspace/worktree.';
      case 'CONFIRM_GREEN':
        return `TDD Protocol: Code edit applied. Now re-run \`${this.reproCommand}\` to confirm it passes (GREEN state).`;
      case 'REGRESSION_GATE':
        return `TDD Protocol: Fix verified. Now run the broader regression test suite (\`${this.regressionCommand || 'npm test'}\`) to guarantee zero regressions.`;
      case 'COMPLETED':
        return 'TDD Protocol: All phases completed! Reproduction test passed and regression gate verified.';
    }
  }

  public getSnapshot(): TddStateSnapshot {
    return {
      phase: this.phase,
      reproCommand: this.reproCommand,
      regressionCommand: this.regressionCommand,
      isRedConfirmed: this.isRedConfirmed,
      isGreenConfirmed: this.isGreenConfirmed,
      isRegressionPassed: this.isRegressionPassed,
      redOutput: this.redOutput,
      greenOutput: this.greenOutput,
      regressionOutput: this.regressionOutput,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }
}

