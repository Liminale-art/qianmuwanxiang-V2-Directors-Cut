// Hand-authored contract examples, NOT real model output or semantic gold labels.
import {getStillPromptCase} from '../../evaluation/still-prompts/cases.mjs';
import {STORYBOARD_NARRATIVE_SCHEMA, STORYBOARD_EXPRESSION_SCHEMA} from '../../qianmu-storyboard-focused-extraction.js';

export function authoredNarrative(id) {
  const sample = getStillPromptCase(id), paragraphs = sample.texts.at(-1).split('\n\n');
  const noImage = ['uncertain-person', 'stream-wait'].includes(id);
  const selections = id === 'kitchen-six' ? [[1, ['A', 'B']], [2, ['A', 'B']], [3, ['B']], [4, ['B', 'M'], 'memory'], [5, ['A', 'B']], [6, ['A', 'B']]]
    : id === 'kitchen-three' ? [[2, ['A', 'B']], [4, ['B', 'M'], 'memory'], [6, ['A', 'B']]]
    : id === 'memory-branches' ? [[1, ['A']], [2, ['A'], 'memory'], [3, ['A']]]
      : [[1, id === 'landscape' ? [] : id === 'contact' ? ['A', 'B'] : ['A']]];
  const shots = noImage ? [] : selections.map(([p, ids, layer = 'present'], index) => {
    const description = paragraphs[p - 1], branchId = layer === 'memory' ? 'then' : 'now';
    const shot = {source_paragraph_ids: [`P${p}`], insert_after: `P${p}`, narrative_layer: layer, narrative_purpose: description,
      shot_role: index ? 'reaction' : 'establishing', shot_scale: ids.length ? 'medium_shot' : 'wide_shot', subject: description,
      scene: {location: id === 'landscape' ? '雨后街巷' : '室内', time: layer === 'memory' ? '往事' : '当下', lighting: ['soft light'], environment: []},
      characters: ids.map((character_id, i) => ({character_id, name: {A: '阿岚', B: '柏宁', M: '母亲'}[character_id], fixed_identity: [],
        current_state: {outfit: [], expression: [], pose: [], action: [description], gaze: [], props: []},
        spatial: {order: i + 1, region: ids.length === 1 ? 'center' : i ? 'right' : 'left', center: {x: ids.length === 1 ? 0.5 : i ? 0.7 : 0.3, y: 0.5}, visible_crop: 'waist'}})),
      shared_relations: [], composition: {ratio_id: '3:2', orientation: 'landscape', camera_side: 'axis-neutral', angle: 'eye-level', focus: description,
        negative_space: '', intent: description, continuity_key: branchId}, sensitive: false, safety_notes: [],
      state_point: {branchId, paragraphId: `P${p}`, evidence: description}};
    if (sample.stream) {
      const source = {floor: sample.texts.length - 1, branch_id: branchId, paragraph_id: `P${p}`, quote: description};
      shot.stream_support = {scene: source, content: source, presence: ids.map(character_id => ({character_id, source}))};
    }
    return shot;
  });
  const narrative = {schema: STORYBOARD_NARRATIVE_SCHEMA, should_generate: !noImage, skip_reason: noImage ? '人物身份和场景尚不明确，等待正文' : '', shots,
    source_states: sample.texts.map((_, floor) => ({floor, roster: {branches: [{id: 'now', layer: 'present'}, ...(shots.some(shot => shot.narrative_layer === 'memory') ? [{id: 'then', layer: 'memory'}] : [])],
      subjectIds: ['A', 'B', 'M']}, events: []})), continuity_links: [], decisions: []};
  if (id === 'continuity') {
    narrative.source_states[0].events = [{id: 'coat', branchId: 'now', paragraphId: 'P1', subjectId: 'A', category: 'outfit', key: 'coat', value: 'removed', persistence: 'persistent', evidence: '阿岚在厨房脱下黑外套，只穿白衬衫。'},
      {id: 'cup', branchId: 'now', paragraphId: 'P1', subjectId: 'A', category: 'prop', key: 'cup', value: 'blue cup in right hand', persistence: 'persistent', evidence: '他用右手拿起蓝瓷杯，靠在窗边。'}];
    narrative.continuity_links = [{from_floor: 0, from_branch: 'now', to_floor: 2, to_branch: 'now', evidence: {paragraph_id: 'P1', quote: '仍在这间厨房，阿岚继续握着那只蓝瓷杯'},
      facts: ['coat', 'cup'].map(event_id => ({source_floor: 0, event_id, subject_id: 'A'}))}];
  }
  return narrative;
}

export function authoredExpression(id, narrative = authoredNarrative(id)) {
  return {schema: STORYBOARD_EXPRESSION_SCHEMA, shots: narrative.shots.map((shot, i) => ({shot_id: `S${i + 1}`,
    prompt_atoms: {global: [shot.subject], character_ids: shot.characters.map(row => row.character_id), scene_negative: ['extra people']},
    prompt_renderings: Object.fromEntries(getStillPromptCase(id).promptFormats.map(format => [format, {global: shot.subject,
      characters: shot.characters.map(row => ({character_id: row.character_id, positive: row.current_state.action.join(', ')})), negative: 'extra people'}]))}))};
}
