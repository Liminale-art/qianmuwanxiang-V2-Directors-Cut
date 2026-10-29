import test from 'node:test';
import assert from 'node:assert/strict';
import { recallCandidateScore, recallCandidates, recallSynonymGroups } from '../yimu/recall.mjs';

const hash = 'a'.repeat(64);
const entry = (id, patch = {}) => ({ id, kind: 'summary', revision: 1, text: '旧剧情里有人在港口等待消息。', title: '港口等待', scenes: [{ world: '主世界', timeline: '冬线', date: '第三日', period: '夜', place: '港口', characters: ['秦铎'], event: '等待消息', nature: 'present', evidence: { floors: [1] } }], source: { start: 1, end: 1, hashes: [hash] }, status: 'active', history: [], conflicts: [], ...patch });

test('explicit alias and synonym groups expand conservatively and score scene anchors', () => {
    const groups = recallSynonymGroups({ 秦铎: ['char', '琮'] });
    assert.deepEqual(groups, [['秦铎', 'char', '琮']]);
    const match = recallCandidateScore(entry('one'), 'char 在冬线的港口等候', { recallSynonyms: { 秦铎: ['char', '琮'] } });
    assert.ok(match.score >= 4);
    assert.ok(match.reasons.includes('别名／同义词'));
    assert.ok(match.reasons.includes('时空线索'));
});

test('recall candidates retain bounded lexical fallback and expose the match reason', () => {
    const document = { entries: [entry('scene'), entry('recent', { source: { start: 3, end: 3, hashes: [hash] } })] };
    const result = recallCandidates(document, { recall: true, recent: 1, batch: 6000, recallSynonyms: { 秦铎: ['char'] } }, [{ mes: '旧事', is_user: false }, { mes: '新的剧情', is_user: false }, { mes: 'char 在港口等待', is_user: false }], { start: 3, end: 3 }, [hash, hash, hash]);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'scene');
    assert.match(result[0].reason, /别名／同义词|时空线索|关键词/);
    assert.equal(result[0].title, '港口等待');
});
