/**
 * Reference data from the approved prototype. Every exam configuration is seeded as PENDING_VERIFICATION:
 * the section counts came from the product brief, NOT from an official notification. Prices are seeded INACTIVE.
 * Nothing here is user data and nothing here is demo data.
 */
import type { Queryable } from '../lib/db.js';

const sec = (id: string, name: string, kind: string, role: string, count: number, order: number, pcount: number, pqp: number | null = null) =>
  ({ id, name, kind, role, questionCount: count, marksPerQuestion: 1, negativeMarks: 0, qualifyingPercent: null, order, practiceCount: pcount, practiceQualifyingPercent: pqp });
const treSections = [sec('language', 'Language', 'QUALIFYING', 'LANGUAGE', 30, 1, 3, 30), sec('gs', 'General Studies', 'MERIT', 'GS', 40, 2, 4), sec('subject', 'Concerned Subject', 'MERIT', 'SUBJECT', 80, 3, 8)];
const stetSections = [sec('subject', 'Subject', 'NORMAL', 'SUBJECT', 100, 1, 10), sec('teaching', 'Teaching Aptitude & Related Competencies', 'NORMAL', 'TEACHING', 50, 2, 5)];
const practice = { durationMinutes: 15, negativeMarkingEnabled: false, negativeMarks: 0, passPercent: null };

export const CONFIGS = [
  { id: 'TRE_15_V1', exam_type: 'TRE', level: '1-5', paper: null, status: 'DRAFT', option_count: 5, duration_minutes: null, sections: [], notes: 'Official pattern not entered yet. No mocks can be created until sections are entered and verified.' },
  ...['6-8', '9-10', '11-12'].map(l => ({ id: `TRE_${l.replace('-', '')}_V1`, exam_type: 'TRE', level: l, paper: null, status: 'ACTIVE', option_count: 5, duration_minutes: 150, sections: treSections,
    notes: 'Section counts entered from the product brief (30 + 40 + 80). Not verified against an official notification — language sub-split, qualifying % and marking are unverified.' })),
  ...['P1', 'P2'].map(p => ({ id: `STET_${p}_V1`, exam_type: 'STET', level: null, paper: p, status: 'ACTIVE', option_count: 4, duration_minutes: 150, sections: stetSections,
    notes: 'Structure as entered by admin (100 + 50). Not verified — option count and pass rule are unverified.' })),
];

const SUBJECTS: [string, string, string[], string[], [string, string[]][]][] = [
  ['cs', 'Computer Science', ['P2'], ['9-10', '11-12'], [['Operating Systems', ['Process Scheduling', 'Deadlocks', 'Memory Management']], ['DBMS', ['SQL', 'Normalization', 'Transactions', 'Indexing']], ['Computer Networks', ['OSI Model', 'IP Addressing', 'Protocols']], ['Programming', ['Python Operators', 'C Basics', 'OOP']], ['Data Structures', ['Graphs', 'Trees', 'Stacks & Queues']], ['Computer Fundamentals', ['Number Systems', 'Hardware']]]],
  ['math', 'Mathematics', ['P1', 'P2'], ['6-8', '9-10', '11-12'], [['Algebra', ['Quadratic Equations', 'Sequences']], ['Calculus', ['Limits', 'Derivatives', 'Integrals']], ['Geometry', ['Triangles', 'Circles']], ['Statistics & Probability', ['Mean & Variance', 'Probability']]]],
  ['phy', 'Physics', ['P2'], ['11-12'], [['Mechanics', ['Kinematics', 'Laws of Motion']], ['Electromagnetism', ['Electrostatics', 'Current Electricity']], ['Optics', ['Ray Optics', 'Wave Optics']]]],
  ['chem', 'Chemistry', ['P2'], ['11-12'], [['Physical Chemistry', ['Mole Concept', 'Thermodynamics']], ['Organic Chemistry', ['Hydrocarbons', 'Reactions']], ['Inorganic Chemistry', ['Periodic Table', 'Bonding']]]],
  ['bio', 'Biology', ['P2'], ['11-12'], [['Botany', ['Plant Physiology']], ['Zoology', ['Human Physiology']], ['Genetics', ['Mendelian Genetics']]]],
  ['sci', 'Science', ['P1'], ['6-8', '9-10'], [['Physics Basics', ['Motion']], ['Chemistry Basics', ['Matter']], ['Life Science', ['Cells']]]],
  ['sst', 'Social Science', ['P1'], ['6-8', '9-10'], [['History', ['Modern India']], ['Geography', ['Resources']], ['Civics', ['Constitution']]]],
  ['hin', 'Hindi', ['P1', 'P2'], ['6-8', '9-10', '11-12'], [['व्याकरण (Grammar)', ['संधि', 'समास']], ['साहित्य (Literature)', ['काव्य', 'गद्य']]]],
  ['eng', 'English', ['P1', 'P2'], ['6-8', '9-10', '11-12'], [['Grammar', ['Tenses', 'Voice']], ['Literature', ['Poetry', 'Prose']]]],
  ['his', 'History', ['P2'], ['11-12'], [['Ancient India', ['Mauryas', 'Guptas']], ['Medieval India', ['Mughals']], ['Modern India', ['National Movement']]]],
  ['eco', 'Economics', ['P2'], ['11-12'], [['Microeconomics', ['Demand', 'Supply']], ['Macroeconomics', ['National Income', 'Money']]]],
];
const LANGS = [['hi', 'Hindi', 'हिन्दी', 1], ['ur', 'Urdu', 'اردو', 2], ['bn', 'Bengali', 'বাংলা', 3], ['mai', 'Maithili', 'मैथिली', 4]] as const;
const rule = (sectionId: string, topic: string, subtopic: string, count: number) => ({ sectionId, topic, subtopic, count });
const GS_P = [rule('gs', 'Bihar History', 'Formation of Bihar', 1), rule('gs', 'Indian Polity', 'Fundamental Rights', 1), rule('gs', 'Ancient History', 'Gupta Period', 1), rule('gs', 'Bihar Geography', 'Rivers of Bihar', 1)];
export const BLUEPRINTS = [
  { id: 'BP_TRE_1112_CS_PRACTICE', config_id: 'TRE_1112_V1', subject_id: 'cs', mode: 'PRACTICE', difficulty: { EASY: 40, MEDIUM: 45, HARD: 15 }, rules: [rule('language', '*', '*', 3), ...GS_P, rule('subject', 'Operating Systems', 'Process Scheduling', 1), rule('subject', 'Operating Systems', 'Deadlocks', 1), rule('subject', 'DBMS', 'Normalization', 1), rule('subject', 'DBMS', 'Transactions', 1), rule('subject', 'Computer Networks', 'OSI Model', 1), rule('subject', 'Computer Networks', 'IP Addressing', 1), rule('subject', 'Programming', 'Python Operators', 1), rule('subject', 'Data Structures', 'Graphs', 1)] },
  { id: 'BP_STET_P2_CS_PRACTICE', config_id: 'STET_P2_V1', subject_id: 'cs', mode: 'PRACTICE', difficulty: { EASY: 30, MEDIUM: 50, HARD: 20 }, rules: [rule('subject', 'Operating Systems', 'Process Scheduling', 1), rule('subject', 'Operating Systems', 'Deadlocks', 1), rule('subject', 'DBMS', 'Normalization', 1), rule('subject', 'DBMS', 'Transactions', 1), rule('subject', 'Computer Networks', 'OSI Model', 1), rule('subject', 'Computer Networks', 'IP Addressing', 1), rule('subject', 'Programming', 'Python Operators', 1), rule('subject', 'Data Structures', 'Graphs', 1), rule('subject', 'Computer Fundamentals', 'Number Systems', 1), rule('subject', 'Computer Fundamentals', 'Hardware', 1), rule('teaching', '*', '*', 5)] },
];
// Prices from the prototype, in paise, seeded INACTIVE: the business must confirm and activate them.
const PRICES = [
  ['PL_STET_90', 'STET', null, null, null, 90, 39900, 25], ['PL_TRE_90', 'TRE', null, null, null, 90, 49900, 30], ['PL_TRE_1112_90', 'TRE', '11-12', null, null, 90, 54900, 30],
  ['PL_TRE_1112_CS_90', 'TRE', '11-12', null, 'cs', 90, 59900, 30], ['PL_BOTH_90', 'BOTH', null, null, null, 90, 89900, 40],
] as const;

export async function seedReference(c: Queryable) {
  for (const x of CONFIGS) {
    await c.query(`INSERT INTO exam_configs (id, exam_type, level, paper, version, status, option_count, duration_minutes, negative_marking, sections, practice, verification_status, notes)
      VALUES ($1,$2,$3,$4,1,$5,$6,$7,false,$8,$9,'PENDING_VERIFICATION',$10) ON CONFLICT (id) DO NOTHING`,
      [x.id, x.exam_type, x.level, x.paper, x.status, x.option_count, x.duration_minutes, JSON.stringify(x.sections), JSON.stringify(practice), x.notes]);
  }
  for (const [id, name, stet, tre, topics] of SUBJECTS) {
    await c.query('INSERT INTO subjects (id, code, name, stet_papers, tre_levels) VALUES ($1,$1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [id, name, stet, tre]);
    for (let i = 0; i < topics.length; i++) await c.query('INSERT INTO topics (id, subject_id, name, subtopics, sort) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [`${id}-t${i + 1}`, id, topics[i][0], topics[i][1], i + 1]);
  }
  for (const [code, name, native, sort] of LANGS) await c.query('INSERT INTO tre_languages (code, name, native, sort) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING', [code, name, native, sort]);
  for (const b of BLUEPRINTS) await c.query('INSERT INTO blueprints (id, config_id, subject_id, mode, difficulty, rules) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [b.id, b.config_id, b.subject_id, b.mode, b.difficulty, JSON.stringify(b.rules)]);
  for (const [id, plan, level, paper, subject, days, base, disc] of PRICES)
    await c.query('INSERT INTO pricing_plans (id, plan, level, paper, subject_id, duration_days, base_price_paise, discount_pct, tax_pct, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,18,false) ON CONFLICT (id) DO NOTHING', [id, plan, level, paper, subject, days, base, disc]);
}
