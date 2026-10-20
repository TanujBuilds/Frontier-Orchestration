export class FakeFrontier {
  async plan({ goal }) {
    return {
      summary: `Complete the task: ${goal}`,
      steps: [{
        id: 'step-1',
        objective: goal,
      context: 'Use only the task description provided in this demo.',
      expectedResult: 'A proposed approach and a clear explanation',
      }],
    };
  }

  async review({ attempt }) {
    if (attempt === 1) {
      return { decision: 'revise', feedback: 'Explain the change and its check more clearly.' };
    }
    return { decision: 'accept', feedback: 'The revised result is clear.' };
  }
}

export class FakeLocal {
  async execute({ attempt, feedback }) {
    return {
      status: 'completed',
      answer: attempt === 1 ? 'Draft approach with a short explanation.' : 'Revised approach with a clearer explanation.',
      summary: attempt === 1 ? 'Draft implementation complete.' : 'Revision complete with clearer explanation.',
      artifacts: [],
      checks: [{ name: 'fake-check', passed: true, evidence: 'Simulated success; no code was run.' }],
      feedbackApplied: feedback,
    };
  }
}
