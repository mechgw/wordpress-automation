'use strict';

/**
 * Semantyka bramki review-ack (#50): potwierdzenie `/reviewed` unieważnia tylko
 * nowy commit albo nowa merytoryczna recenzja bota (review / komentarz w
 * kodzie), nigdy zwykły komentarz bota do PR-a.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../scripts/quality/review-ack');

const T = {
  head: '2026-09-05T10:00:00Z',
  copilotReview: '2026-09-05T10:03:00Z',
  ack: '2026-09-05T10:10:00Z',
  later: '2026-09-05T10:20:00Z',
  evenLater: '2026-09-05T10:30:00Z'
};
const COPILOT = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
const CODEX = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' };
const OWNER = { login: 'mechgw', type: 'User' };
const STRANGER = { login: 'random-user', type: 'User' };

const ack = (at = T.ack, user = OWNER, association = 'OWNER', body = '/reviewed accepted both') =>
  ({ user, author_association: association, created_at: at, body, html_url: 'https://example/pr#c' });
const codexLimit = at => ({ user: CODEX, author_association: 'NONE', created_at: at, body: 'You have reached your Codex usage limits for code reviews.' });

function input(overrides = {}) {
  return Object.assign({
    headSha: 'abcdef1234567',
    headDate: T.head,
    requestedReviewers: [],
    reviews: [{ user: COPILOT, submitted_at: T.copilotReview, state: 'COMMENTED' }],
    issueComments: [],
    reviewComments: []
  }, overrides);
}

describe('review-ack: acknowledgment', () => {
  test('no /reviewed comment → red with the threshold explained', () => {
    const r = evaluate(input());
    assert.equal(r.ok, false);
    assert.equal(r.ack, null);
    assert.match(r.summary, /❌ No `\/reviewed` comment newer than the head commit \(abcdef1, 2026-09-05T10:00:00Z\) and the last bot review \(2026-09-05T10:03:00Z\)/);
  });

  test('/reviewed after the head commit and after the Copilot review → green', () => {
    const r = evaluate(input({ issueComments: [ack()] }));
    assert.equal(r.ok, true);
    assert.equal(r.ack.user.login, 'mechgw');
    assert.match(r.summary, /✅ Acknowledged by mechgw at 2026-09-05T10:10:00Z/);
  });

  test('/reviewed posted before the Copilot review does not count', () => {
    const r = evaluate(input({ issueComments: [ack('2026-09-05T10:01:00Z')] }));
    assert.equal(r.ok, false);
  });

  test('a new commit after /reviewed invalidates it', () => {
    const r = evaluate(input({ headDate: T.later, issueComments: [ack()] }));
    assert.equal(r.ok, false);
  });

  test('only owner/member/collaborator or the Claude app may acknowledge', () => {
    assert.equal(evaluate(input({ issueComments: [ack(T.ack, STRANGER, 'NONE')] })).ok, false);
    assert.equal(evaluate(input({ issueComments: [ack(T.ack, STRANGER, 'CONTRIBUTOR')] })).ok, false);
    assert.equal(evaluate(input({ issueComments: [ack(T.ack, { login: 'claude[bot]', type: 'Bot' }, 'NONE')] })).ok, true);
    assert.equal(evaluate(input({ issueComments: [ack(T.ack, { login: 'someone', type: 'User' }, 'COLLABORATOR')] })).ok, true);
  });

  test('the marker must start the comment', () => {
    assert.equal(evaluate(input({ issueComments: [ack(T.ack, OWNER, 'OWNER', 'I have /reviewed this')] })).ok, false);
    assert.equal(evaluate(input({ issueComments: [ack(T.ack, OWNER, 'OWNER', '  /reviewed')] })).ok, true);
    assert.equal(evaluate(input({ issueComments: [ack(T.ack, OWNER, 'OWNER', '/reviewedx')] })).ok, false);
  });

  test('the latest qualifying /reviewed is reported', () => {
    const r = evaluate(input({ issueComments: [ack(T.ack), ack(T.later, OWNER, 'OWNER', '/reviewed again')] }));
    assert.equal(r.ack.created_at, T.later);
  });
});

describe('review-ack: what resets the acknowledgment (#50)', () => {
  test('a plain bot comment after /reviewed (Codex usage limit) does NOT reset it', () => {
    const r = evaluate(input({ issueComments: [ack(), codexLimit(T.later)] }));
    assert.equal(r.ok, true, 'usage-limit notice is not a review');
    assert.equal(r.lastBotReview, T.copilotReview);
  });

  test('a new bot review after /reviewed resets it', () => {
    const r = evaluate(input({
      reviews: [{ user: COPILOT, submitted_at: T.copilotReview }, { user: CODEX, submitted_at: T.later }],
      issueComments: [ack()]
    }));
    assert.equal(r.ok, false);
    assert.equal(r.lastBotReview, T.later);
  });

  test('a new inline bot comment after /reviewed resets it', () => {
    const r = evaluate(input({ issueComments: [ack()], reviewComments: [{ user: COPILOT, created_at: T.later }] }));
    assert.equal(r.ok, false);
  });

  test('a human review after /reviewed does not reset it', () => {
    const r = evaluate(input({
      reviews: [{ user: COPILOT, submitted_at: T.copilotReview }, { user: OWNER, submitted_at: T.later }],
      issueComments: [ack()]
    }));
    assert.equal(r.ok, true);
  });

  test('/reviewed after the new bot review makes it green again', () => {
    const r = evaluate(input({
      reviews: [{ user: COPILOT, submitted_at: T.copilotReview }, { user: COPILOT, submitted_at: T.later }],
      issueComments: [ack(), ack(T.evenLater)]
    }));
    assert.equal(r.ok, true);
    assert.equal(r.ack.created_at, T.evenLater);
  });
});

describe('review-ack: Copilot in progress', () => {
  test('Copilot still requested → red even with a valid /reviewed', () => {
    for (const login of ['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]']) {
      const r = evaluate(input({ requestedReviewers: [login], issueComments: [ack()] }));
      assert.equal(r.ok, false);
      assert.equal(r.copilotInProgress, true);
      assert.match(r.summary, /⏳ Copilot code review is still in progress/);
    }
  });

  test('a requested human reviewer does not count as Copilot', () => {
    const r = evaluate(input({ requestedReviewers: ['someone'], issueComments: [ack()] }));
    assert.equal(r.ok, true);
  });

  test('no reviews at all (Copilot never requested) is fine once acknowledged', () => {
    const r = evaluate(input({ reviews: [], issueComments: [ack()] }));
    assert.equal(r.ok, true);
    assert.equal(r.copilotReviews, 0);
    assert.equal(r.lastBotReview, '');
  });
});
