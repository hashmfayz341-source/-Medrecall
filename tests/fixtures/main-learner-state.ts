/**
 * Learner state exactly as main@482824c (before card study existed) saves it.
 *
 * Captured by running that commit's own engine — `markChunkTaught("chunk-ci-1")`,
 * then a WRONG Tutor INITIAL answer on c-hypoxia at 2026-06-01T09:00Z, then
 * (for REMEDIATED) a correct IMMEDIATE_REMEDIATION answer a minute later — and
 * serialising the result. Nothing here was written by hand: these are the
 * shapes a learner who used main has in localStorage today, so they carry no
 * `pendingTutorRemediation` field and no `cards`.
 */

/** A Tutor INITIAL failure awaiting immediate remediation. */
export const MAIN_PENDING_REMEDIATION = {
  "version": 1,
  "progress": {
    "c-hypoxia": {
      "conceptId": "c-hypoxia",
      "mastery": "WEAK",
      "consecutiveSpacedSuccesses": 0,
      "totalAttempts": 1,
      "totalCorrect": 0,
      "everWrong": true,
      "immediateRemediationPassed": false,
      "lastAttemptAt": "2026-06-01T09:00:00.000Z",
      "schedule": {
        "due": "2026-06-01T09:01:00.000Z",
        "stability": 0.212,
        "difficulty": 6.4133,
        "elapsed_days": 0,
        "scheduled_days": 0,
        "learning_steps": 0,
        "reps": 1,
        "lapses": 0,
        "state": 1,
        "last_review": "2026-06-01T09:00:00.000Z"
      }
    }
  },
  "taughtChunkIds": [
    "chunk-ci-1"
  ],
  "completedChunkIds": [],
  "completedLectureIds": [],
  "injectedByChunk": {}
};

/** The same failure after the Tutor's remediation was answered correctly. */
export const MAIN_REMEDIATED = {
  "version": 1,
  "progress": {
    "c-hypoxia": {
      "conceptId": "c-hypoxia",
      "mastery": "WEAK",
      "consecutiveSpacedSuccesses": 0,
      "totalAttempts": 2,
      "totalCorrect": 1,
      "everWrong": true,
      "immediateRemediationPassed": true,
      "lastAttemptAt": "2026-06-01T09:01:00.000Z",
      "schedule": {
        "due": "2026-06-01T09:07:00.000Z",
        "stability": 0.212,
        "difficulty": 7.60420977,
        "elapsed_days": 0,
        "scheduled_days": 0,
        "learning_steps": 0,
        "reps": 2,
        "lapses": 0,
        "state": 1,
        "last_review": "2026-06-01T09:01:00.000Z"
      }
    }
  },
  "taughtChunkIds": [
    "chunk-ci-1"
  ],
  "completedChunkIds": [],
  "completedLectureIds": [],
  "injectedByChunk": {}
};
