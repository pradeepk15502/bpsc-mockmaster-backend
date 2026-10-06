import { z } from 'zod';
import { OPTS, type OptKey, type QuestionContent } from './types.js';

/** JSON contract the generation worker accepts from Claude. Anything else is rejected and the batch retried. */
const Tri = z.object({ hi: z.string().min(1).max(4000), en: z.string().min(1).max(4000), hinglish: z.string().min(1).max(4000) }).strict();
export const GeneratedItem = z.object({
  slot: z.number().int().positive(),
  topic: z.string().min(1).max(200),
  subtopic: z.string().min(1).max(200),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
  question: Tri,
  options: z.record(z.enum(OPTS), Tri),
  correctOption: z.enum(OPTS),
  concept: Tri,
  explanation: Tri,
  optionReasons: z.record(z.enum(OPTS), Tri),
  examTip: Tri,
}).strict();
export const GeneratedBatch = z.object({ items: z.array(GeneratedItem).min(1).max(20) }).strict();
export type GeneratedItemT = z.infer<typeof GeneratedItem>;

const tri = (t: { hi: string; en: string; hinglish: string }) => ({ hi: t.hi.trim(), en: t.en.trim(), hl: t.hinglish.trim() });

/** Converts a validated contract item to stored content. Throws if the option set does not match the config. */
export function toContent(item: GeneratedItemT, optionKeys: OptKey[]): QuestionContent {
  const got = Object.keys(item.options).sort().join('');
  if (got !== optionKeys.slice().sort().join('')) throw new Error(`option set ${got} does not match configured ${optionKeys.join('')}`);
  if (Object.keys(item.optionReasons).sort().join('') !== got) throw new Error('every option needs a reason');
  if (!optionKeys.includes(item.correctOption)) throw new Error('correct option is not one of the configured options');
  const opts: QuestionContent['opts'] = {}; const why: QuestionContent['why'] = {};
  for (const k of optionKeys) { opts[k] = tri(item.options[k]!); why[k] = tri(item.optionReasons[k]!); }
  return { q: tri(item.question), opts, why, exp: tri(item.explanation), concept: tri(item.concept), tip: tri(item.examTip) };
}

/** JSON Schema given to Claude as a forced tool, generated for the configured option keys. */
export function toolSchema(optionKeys: OptKey[]) {
  const tri = { type: 'object', additionalProperties: false, required: ['hi', 'en', 'hinglish'], properties: { hi: { type: 'string' }, en: { type: 'string' }, hinglish: { type: 'string' } } };
  const perOpt = { type: 'object', additionalProperties: false, required: optionKeys, properties: Object.fromEntries(optionKeys.map(k => [k, tri])) };
  return {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['slot', 'topic', 'subtopic', 'difficulty', 'question', 'options', 'correctOption', 'concept', 'explanation', 'optionReasons', 'examTip'],
          properties: {
            slot: { type: 'integer' }, topic: { type: 'string' }, subtopic: { type: 'string' },
            difficulty: { type: 'string', enum: ['EASY', 'MEDIUM', 'HARD'] },
            question: tri, options: perOpt, correctOption: { type: 'string', enum: optionKeys },
            concept: tri, explanation: tri, optionReasons: perOpt, examTip: tri,
          },
        },
      },
    },
  };
}
