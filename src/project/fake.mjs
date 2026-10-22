export class FakeProjectFrontier {
  identity = 'FAKE-frontier';
  async planProject({ permissions }) {
    const checks = permissions.checks.map(check => check.id);
    const common = { writePaths: permissions.writePaths, checks, acceptance: ['Approved checks pass; this is a fake provider exercise'] };
    return { summary: 'FAKE staged coding exercise', stages: [
      { ...common, id: 'implementation', kind: 'implementation', objective: 'Write a fake provider marker', deliverable: 'A marker file' },
      { ...common, id: 'verification', kind: 'verification', objective: 'Verify the final workspace', deliverable: 'Check evidence' },
    ] };
  }
  async reviewCode({ evidence }) { return { decision: evidence.checks.every(check => check.passed) ? 'accept' : 'revise', feedback: 'Fake review; no real model judgment', unverified: ['All semantic assessment is simulated'] }; }
  async guideStage() { return { guidance: 'FAKE guidance: follow the approved stage and its checks.' }; }
}
export class FakeProjectLocal {
  identity = 'FAKE-local';
  async planProject({ permissions }) {
    const checks = permissions.checks.map(check => check.id);
    const common = { writePaths: permissions.writePaths, checks, acceptance: ['Approved checks pass; this is a fake provider exercise'] };
    return { plan: { summary: 'FAKE staged coding exercise', stages: [
      { ...common, id: 'implementation', kind: 'implementation', objective: 'Write a fake provider marker', deliverable: 'A marker file' },
      { ...common, id: 'verification', kind: 'verification', objective: 'Verify the final workspace', deliverable: 'Check evidence' },
    ] } };
  }
  async reply({ stage, inventory }) {
    const scope = stage.writePaths[0];
    const file = scope.endsWith('/') ? `${scope}fake-marker.txt` : scope;
    return { model: 'FAKE', reply: { type: 'submit_changes', paths: [], summary: 'Simulated implementation', edits: stage.kind === 'verification' ? [] : [
      { path: file, action: 'write', baseHash: inventory.find(item => item.path === file)?.hash ?? null, content: 'FAKE provider generated this marker.\n' },
    ] } };
  }
}
