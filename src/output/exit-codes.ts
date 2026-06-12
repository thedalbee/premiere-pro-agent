// Exit codes are part of the agent contract: each number marks a boundary
// where the caller's next action changes (see design doc, section 6).
export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  NO_CONNECTION: 3,
  MISSING_DEPENDENCY: 4,
  VALIDATION: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
