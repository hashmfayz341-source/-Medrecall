/**
 * Model answers for the demo curriculum, shared by the unit and E2E suites so
 * both drive the tutor with exactly the same inputs.
 */
export const CORRECT_ATP =
  "ATP depletion makes the Na/K ATPase pump fail so sodium and water enter the cell and cause swelling";

export const WRONG = "I do not remember this at all";

export const ANSWERS: Record<string, string> = {
  "c-hypoxia":
    "hypoxia is the commonest cause and ischaemia causes it by removing substrate and waste clearance",
  "c-reversible-irreversible":
    "severe membrane damage marks irreversible injury with swelling in reversible",
  "c-atp-depletion": CORRECT_ATP,
  "c-na-k-atpase":
    "three sodium out for two potassium in and it uses lots of atp so it accumulates",
  "c-cellular-swelling": "water follows sodium osmotically so the cell shows swelling",
  "c-cardinal-signs": "rubor calor tumor dolor and functio laesa",
  "c-vasodilation": "vasodilation raises flow and increased permeability makes exudate",
  "c-margination": "selectins roll and integrins adhere which is margination",
  "c-chemotaxis": "c5a and il-8 along a chemical gradient",
};
