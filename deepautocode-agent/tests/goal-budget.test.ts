import { describe, expect, it } from 'vitest';
import {
  createGoalState,
  DEFAULT_GOAL_TOKEN_BUDGET,
  isGoalTokenBudgetExceeded,
  buildGoalBudgetLimitPrompt,
} from '../src/core/GoalSteering.js';

describe('Goal token budget defaults', () => {
  it('assigns default budget on createGoalState', () => {
    const goal = createGoalState('fix the flaky test');
    expect(goal.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
    expect(DEFAULT_GOAL_TOKEN_BUDGET).toBeGreaterThan(50_000);
  });

  it('allows explicit unlimited budget via null', () => {
    const goal = createGoalState('explore forever', null);
    expect(goal.tokenBudget).toBeNull();
    expect(isGoalTokenBudgetExceeded(goal)).toBe(false);
  });

  it('detects budget exceeded and builds limit prompt', () => {
    const goal = createGoalState('ship feature', 1000);
    goal.tokensUsed = 950;
    expect(isGoalTokenBudgetExceeded(goal)).toBe(true);
    const prompt = buildGoalBudgetLimitPrompt(goal);
    expect(prompt).toMatch(/budget_limit|Token Budget/i);
    expect(prompt).toContain('1000');
  });
});
