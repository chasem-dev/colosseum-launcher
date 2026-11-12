'use strict';

// Whether a release can skip its game build (release.yml): true only when the pull request merged as this commit
// already built exactly these files on every system. Anything else, or any doubt, runs the full build.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SYSTEMS = ['ubuntu-24.04', 'windows-2025', 'macos-15-intel', 'macos-15'];
// each game the workflow builds (game-build.yml's matrix): a release ships both pins
const GAMES = ['colosseum', 'xd'];
const jobName = (game, system) => `compile-port (${game}, ${system})`;

async function priorGameBuild({ sha, api, tree, log = () => {} }) {
  const pull = (await api(`commits/${sha}/pulls`)).find(item => item.merged_at && item.merge_commit_sha === sha);
  if (!pull) return log(`${sha} is not a pull request's merge.`), false;
  const head = pull.head.sha;
  // Main moved on while the pull request waited: the merge holds files its build never saw.
  if (tree(head) !== tree(sha)) return log(`Pull request #${pull.number} does not hold exactly the files of ${sha}.`), false;
  const { workflow_runs: runs } = await api(`actions/workflows/game-build.yml/runs?head_sha=${head}&event=pull_request&status=success&per_page=20`);
  for (const run of runs) {
    const { jobs } = await api(`actions/runs/${run.id}/jobs?per_page=100`);
    if (GAMES.every(game => SYSTEMS.every(system => jobs.some(job => job.name === jobName(game, system) && job.conclusion === 'success')))) {
      log(`Run ${run.id} of pull request #${pull.number} built these files on every system.`);
      return true;
    }
  }
  return log(`Pull request #${pull.number} has no passed game build on every system.`), false;
}

async function main() {
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: output } = process.env;
  const api = async resource => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${resource}`], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const tree = commit => execFileSync('git', ['rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).trim();
  let built = false;
  try {
    built = await priorGameBuild({ sha, api, tree, log: text => console.log(text) });
  } catch (error) {
    console.log(`Running the full game build: ${error.message}`);
  }
  if (output) fs.appendFileSync(output, `game-built=${built}\n`);
}

if (require.main === module) main();
module.exports = { priorGameBuild, SYSTEMS, GAMES, jobName };
