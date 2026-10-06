export const OPTS = ['A', 'B', 'C', 'D', 'E'] as const;
export type OptKey = (typeof OPTS)[number];
export const LANG_KEYS = ['hi', 'en', 'hl'] as const;
export type Lang = (typeof LANG_KEYS)[number];
export type Tr = { hi: string; en: string; hl: string };
export const LANG_NAME: Record<Lang, string> = { hi: 'Hindi', en: 'English', hl: 'Hinglish' };

export interface QuestionContent {
  q: Tr;
  opts: Partial<Record<OptKey, Tr>>;
  why: Partial<Record<OptKey, Tr>>;
  exp: Tr;
  concept: Tr;
  tip: Tr;
  verify?: { kind: 'MATH' | 'CODE'; fn: string; params: Record<string, number> } | null;
}

export type SectionKind = 'QUALIFYING' | 'MERIT' | 'NORMAL';
export type SectionRole = 'LANGUAGE' | 'GS' | 'SUBJECT' | 'TEACHING';
export interface ConfigSection {
  id: string; name: string; kind: SectionKind; role: SectionRole; order: number;
  questionCount: number; marksPerQuestion: number; negativeMarks: number; qualifyingPercent: number | null;
  practiceCount: number; practiceQualifyingPercent: number | null;
}
export interface PracticeSettings { durationMinutes: number; negativeMarkingEnabled: boolean; negativeMarks: number; passPercent?: number | null }

/** Frozen into each mock at creation: scoring never reads the live configuration. */
export interface MockSection {
  id: string; name: string; kind: SectionKind; role: SectionRole; qualifying: boolean;
  marksPerQuestion: number; negativeMarks: number; qualifyingPercent: number | null; qualifyingSource: 'OFFICIAL' | 'PRACTICE' | 'PENDING' | null;
  count: number;
}
export interface ConfigSnapshot {
  configId: string; version: number; verificationStatus: string; mode: 'PRACTICE' | 'OFFICIAL';
  examType: 'TRE' | 'STET'; optionKeys: OptKey[]; durationMinutes: number; negativeMarkingEnabled: boolean;
  passPercent: number | null; sections: MockSection[]; totalQuestions: number;
}

export interface Selection {
  examType: 'TRE' | 'STET'; level?: string | null; paper?: string | null;
  subjectId: string; otherSubjectName?: string | null; treLanguage?: string | null;
}

export const normSubject = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const levelOrPaper = (x: Selection) => (x.examType === 'TRE' ? x.level : x.paper) ?? '';
export const subjectKey = (x: Selection) => (x.subjectId === 'other' ? 'other:' + normSubject(x.otherSubjectName) : x.subjectId);
/** Cohort base = exam | level-or-paper | subject | TRE exam language. One shared daily mock per cohort. */
export const cohortBase = (x: Selection) => [x.examType, levelOrPaper(x), subjectKey(x), x.examType === 'TRE' ? x.treLanguage : '-'].join('|');
