'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { priorGameBuild, SYSTEMS, GAMES, jobName } = require('../scripts/prior-game-build');

const job = (system, conclusion = 'success', game = 'colosseum') => ({ name: jobName(game, system), conclusion });
const passed = GAMES.flatMap(game => SYSTEMS.map(system => job(system, 'success', game)));
function world({ pulls = [{ number: 6, merged_at: 'now', merge_commit_sha: 'merge', head: { sha: 'head' } }], runs = [{ id: 1 }], jobs = passed } = {}) {
  return async resource => {
    if (resource === 'commits/merge/pulls') return pulls;
    if (resource.startsWith('actions/workflows/game-build.yml/runs?head_sha=head&')) return { workflow_runs: runs };
    if (resource.startsWith('actions/runs/')) return { jobs: typeof jobs === 'function' ? jobs(resource) : jobs };
    throw new Error(`unexpected ${resource}`);
  };
}
const sameTree = () => 'tree';
const check = (api, tree = sameTree) => priorGameBuild({ sha: 'merge', api, tree });

test('a release skips its game build when its pull request built the same files on every system', async () => {
  assert.equal(await check(world()), true);
});

test('a later run of the pull request can be the one that passed everywhere', async () => {
  const jobs = resource => resource.startsWith('actions/runs/1/') ? passed.slice(1) : passed;
  assert.equal(await check(world({ runs: [{ id: 1 }, { id: 2 }], jobs })), true);
});

test('a release builds the game when the commit is not a merged pull request', async () => {
  assert.equal(await check(world({ pulls: [] })), false);
  assert.equal(await check(world({ pulls: [{ number: 6, merged_at: null, merge_commit_sha: 'merge', head: { sha: 'head' } }] })), false);
  assert.equal(await check(world({ pulls: [{ number: 6, merged_at: 'now', merge_commit_sha: 'other', head: { sha: 'head' } }] })), false);
});

test('a release builds the game when main moved on before the merge', async () => {
  assert.equal(await check(world(), commit => commit === 'head' ? 'older' : 'newer'), false);
});

test('a release builds the game when no run passed on every system', async () => {
  assert.equal(await check(world({ runs: [] })), false);
  assert.equal(await check(world({ jobs: passed.slice(1) })), false);
  assert.equal(await check(world({ jobs: [...passed.slice(1), job(SYSTEMS[0], 'failure')] })), false);
  assert.equal(await check(world({ jobs: [...passed.slice(1), job(SYSTEMS[0], 'skipped')] })), false);
});

test('a release builds the game when one game passed everywhere but the other did not', async () => {
  assert.equal(await check(world({ jobs: SYSTEMS.map(system => job(system, 'success', 'colosseum')) })), false);
  assert.equal(await check(world({ jobs: passed.map(each => each.name === jobName('xd', 'windows-2025') ? { ...each, conclusion: 'failure' } : each) })), false);
});
