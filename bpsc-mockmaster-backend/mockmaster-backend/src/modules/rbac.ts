/** Server-side admin permissions. Hidden buttons are never the control — every admin route checks one of these. */
export const ROLES = ['SUPER_ADMIN', 'CONTENT_ADMIN', 'QUESTION_REVIEWER', 'FINANCE_ADMIN', 'SUPPORT_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = {
  'mock.view': ['SUPER_ADMIN', 'CONTENT_ADMIN', 'QUESTION_REVIEWER', 'SUPPORT_ADMIN'],
  'mock.manage': ['SUPER_ADMIN', 'CONTENT_ADMIN'],
  'mock.publish': ['SUPER_ADMIN', 'CONTENT_ADMIN'],
  'question.view': ['SUPER_ADMIN', 'CONTENT_ADMIN', 'QUESTION_REVIEWER'],
  'question.review': ['SUPER_ADMIN', 'CONTENT_ADMIN', 'QUESTION_REVIEWER'],
  'question.edit': ['SUPER_ADMIN', 'CONTENT_ADMIN', 'QUESTION_REVIEWER'],
  'question.validate': ['SUPER_ADMIN', 'CONTENT_ADMIN', 'QUESTION_REVIEWER'],
  'question.generate': ['SUPER_ADMIN', 'CONTENT_ADMIN'],
  'question.publish': ['SUPER_ADMIN', 'CONTENT_ADMIN'],
  'syllabus.edit': ['SUPER_ADMIN', 'CONTENT_ADMIN'],
  'config.view': ['SUPER_ADMIN', 'CONTENT_ADMIN'],
  'config.edit': ['SUPER_ADMIN'],
  'config.submit': ['SUPER_ADMIN', 'CONTENT_ADMIN'],
  'config.verify': ['SUPER_ADMIN'],
  'sales.edit': ['SUPER_ADMIN'],
  'pricing.edit': ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  'payment.view': ['SUPER_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN'],
  'payment.refund': ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  'payment.reconcile': ['SUPER_ADMIN', 'FINANCE_ADMIN'],
  'student.view': ['SUPER_ADMIN', 'SUPPORT_ADMIN'],
  'student.suspend': ['SUPER_ADMIN', 'SUPPORT_ADMIN'],
  'deletion.process': ['SUPER_ADMIN', 'SUPPORT_ADMIN'],
  'waitlist.view': ['SUPER_ADMIN', 'CONTENT_ADMIN', 'SUPPORT_ADMIN'],
  'support.view': ['SUPER_ADMIN', 'SUPPORT_ADMIN'],
  'audit.view': ['SUPER_ADMIN'],
  'admin.manage': ['SUPER_ADMIN'],
} as const satisfies Record<string, readonly Role[]>;
export type Action = keyof typeof ACTIONS;
export const can = (role: string, action: Action) => (ACTIONS[action] as readonly string[]).includes(role);
