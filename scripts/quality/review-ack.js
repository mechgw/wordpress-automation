#!/usr/bin/env node
'use strict';

/**
 * Bramka review-ack: czy PR może zostać zmergowany od strony review botów.
 *
 * Werdykt jest zielony tylko gdy:
 *   1. Copilot nie jest w trakcie review (nie figuruje na liście oczekujących
 *      recenzentów; GitHub trzyma go tam od prośby do zakończenia).
 *   2. Istnieje komentarz do PR-a zaczynający się od `/reviewed`, napisany przez
 *      właściciela/członka/współpracownika (albo aplikację Claude), nowszy niż
 *      commit HEAD i nowszy niż ostatnia MERYTORYCZNA recenzja bota.
 *
 * Merytoryczna recenzja bota to obiekt review albo komentarz w kodzie (review
 * comment). Zwykłe komentarze do PR-a od botów (np. komunikat Codexa o limicie
 * użycia) NIE unieważniają potwierdzenia. To jest sedno #50.
 *
 * Moduł eksportuje czystą funkcję `evaluate()` (testowaną jednostkowo) oraz
 * tryb CLI, który pobiera dane przez `gh` i kończy się kodem 1 przy czerwonym
 * werdykcie:
 *   node scripts/quality/review-ack.js --pr <numer> [--repo owner/name]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

const DEFAULT_CONFIG = {
  // GraphQL zwraca `copilot-pull-request-reviewer`, REST `…[bot]`.
  copilotLogins: ['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]'],
  botLogins: ['copilot-pull-request-reviewer[bot]', 'chatgpt-codex-connector[bot]'],
  ackAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  ackAuthorsExtra: ['claude[bot]'],
  ackPattern: /^\s*\/reviewed\b/
};

function maxDate(values) {
  return values.filter(Boolean).sort().pop() || '';
}

/**
 * @param {object} input
 * @param {string} input.headSha
 * @param {string} input.headDate            ISO date of the head commit
 * @param {string[]} input.requestedReviewers logins/names still requested
 * @param {Array}  input.reviews             REST pulls/:n/reviews
 * @param {Array}  input.issueComments       REST issues/:n/comments
 * @param {Array}  input.reviewComments      REST pulls/:n/comments (inline)
 * @param {object} [config]
 */
function evaluate(input, config = {}) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config);
  const isBot = user => Boolean(user) && cfg.botLogins.includes(user.login);

  const copilotInProgress = (input.requestedReviewers || []).some(r => cfg.copilotLogins.includes(r));
  const copilotReviews = (input.reviews || []).filter(r => r.user && r.user.login === 'copilot-pull-request-reviewer[bot]').length;

  // Tylko recenzje i komentarze w kodzie; komentarze do PR-a od botów nie liczą się.
  const lastBotReview = maxDate([
    ...(input.reviews || []).filter(r => isBot(r.user)).map(r => r.submitted_at || r.created_at),
    ...(input.reviewComments || []).filter(c => isBot(c.user)).map(c => c.created_at)
  ]);
  const threshold = maxDate([input.headDate, lastBotReview]);

  const mayAck = c => cfg.ackAssociations.includes(c.author_association) ||
    (c.user && cfg.ackAuthorsExtra.includes(c.user.login));
  const ack = (input.issueComments || [])
    .filter(c => c.created_at > threshold && mayAck(c) && cfg.ackPattern.test(String(c.body || '')))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .pop() || null;

  const lines = [];
  let ok = true;
  if (copilotInProgress) {
    ok = false;
    lines.push('⏳ Copilot code review is still in progress (listed as requested reviewer).');
  } else {
    lines.push(`✅ Copilot code review is not running (${copilotReviews} review(s) posted so far).`);
  }
  if (ack) {
    lines.push(`✅ Acknowledged by ${ack.user.login} at ${ack.created_at}: ${ack.html_url || ''}`.trim());
  } else {
    ok = false;
    lines.push(`❌ No \`/reviewed\` comment newer than the head commit (${String(input.headSha || '').slice(0, 7)}, ${input.headDate}) and the last bot review (${lastBotReview || 'none'}).`);
  }
  lines.push('');
  lines.push('To unblock: read the bot reviews, then post a PR comment starting with `/reviewed`. Plain bot comments (e.g. usage-limit notices) do not reset the acknowledgment; a new bot review or inline comment does.');

  return { ok, copilotInProgress, copilotReviews, lastBotReview, threshold, ack, summary: lines.join('\n') };
}

// --- CLI ---------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fetchInput(repo, pr) {
  const [owner, name] = repo.split('/');
  const pull = JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}`]));
  const headSha = pull.head.sha;
  const headDate = JSON.parse(gh(['api', `repos/${repo}/commits/${headSha}`])).commit.committer.date;
  let requestedReviewers;
  try {
    const q = 'query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewRequests(first:50){ nodes{ requestedReviewer{ ... on Bot{login} ... on User{login} ... on Mannequin{login} ... on Team{name} } } } } } }';
    const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${pr}`]));
    requestedReviewers = data.data.repository.pullRequest.reviewRequests.nodes
      .map(n => n.requestedReviewer && (n.requestedReviewer.login || n.requestedReviewer.name))
      .filter(Boolean);
  } catch {
    requestedReviewers = []; // nieudane zapytanie nie może blokować merge'a
  }
  const paginate = p => JSON.parse(gh(['api', '--paginate', '--slurp', p])).flat();
  return {
    headSha,
    headDate,
    requestedReviewers,
    reviews: paginate(`repos/${repo}/pulls/${pr}/reviews`),
    issueComments: paginate(`repos/${repo}/issues/${pr}/comments`),
    reviewComments: paginate(`repos/${repo}/pulls/${pr}/comments`)
  };
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pr') args.pr = argv[++i];
    else if (argv[i] === '--repo') args.repo = argv[++i];
  }
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  if (!args.pr || !repo) {
    console.error('Usage: node scripts/quality/review-ack.js --pr <number> [--repo owner/name]');
    process.exit(2);
  }
  const result = evaluate(fetchInput(repo, args.pr));
  console.log(result.summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary + '\n');
  if (!result.ok) {
    console.error('::error::review-ack not satisfied; see the job summary.');
    process.exit(1);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { evaluate, DEFAULT_CONFIG };
