import Anthropic from '@anthropic-ai/sdk';
import { toolSchema } from '../domain/contract.js';
import type { OptKey } from '../domain/types.js';

export interface GenSlot { slot: number; section: string; topic: string; subtopic: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD' }
export interface GenRequest {
  exam: string; levelOrPaper: string; subject: string; sectionName: string; sectionRole: string;
  treLanguage: string | null; optionKeys: OptKey[]; slots: GenSlot[];
}
export interface GenResult { raw: unknown; usage: { inputTokens: number; outputTokens: number } }
export interface QuestionGenerator { generate(req: GenRequest): Promise<GenResult> }

export const SYSTEM_PROMPT = [
  'You write multiple-choice questions for Bihar teacher-recruitment exam practice (BPSC TRE / Bihar STET).',
  'Use ONLY the syllabus nodes, difficulty and slot numbers given. Do not add topics.',
  'Rules:',
  '- exactly one correct option; distractors must be plausible but clearly wrong',
  '- write every text in Hindi (hi), English (en) and Hinglish (hinglish, Roman script) with the same meaning and the same numbers',
  '- give a one-line concept, a full explanation, a reason for EVERY option (start the correct one with "Correct —" in English and wrong ones with "Wrong —"), and a short exam tip',
  '- never claim a question is from a previous year paper and never cite an exam year',
  '- no current-affairs claims (dates/events after your training data) unless the slot says so',
  '- avoid "all of the above" / "none of the above"',
  'Return the questions only through the emit_questions tool.',
].join('\n');

export class ClaudeQuestionGenerator implements QuestionGenerator {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) { this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000 }); }
  async generate(req: GenRequest): Promise<GenResult> {
    const user = JSON.stringify({
      exam: req.exam, levelOrPaper: req.levelOrPaper, subject: req.subject, section: req.sectionName, sectionRole: req.sectionRole,
      languageSectionLanguage: req.sectionRole === 'LANGUAGE' ? req.treLanguage : null, optionLabels: req.optionKeys, slots: req.slots,
    });
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      tools: [{ name: 'emit_questions', description: 'Return the generated questions, one item per requested slot.', input_schema: toolSchema(req.optionKeys) as any }],
      tool_choice: { type: 'tool', name: 'emit_questions' },
      messages: [{ role: 'user', content: user }],
    });
    const block = msg.content.find((b: any) => b.type === 'tool_use') as any;
    return { raw: block ? block.input : null, usage: { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 } };
  }
}
