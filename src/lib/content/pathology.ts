import type { Concept, Curriculum, Lecture, SourceDocument } from "@/lib/domain/types";

/**
 * Milestone 1 demo curriculum: Pathology.
 *
 * Authored deterministically so the whole tutor runs with no AI key. When a
 * provider is wired up it produces exactly this shape — DRAFT concepts carrying
 * a SourceRef — and the rest of the system is unchanged.
 *
 * Two concepts are intentionally left DRAFT to exercise the approval gate.
 */

const COURSE_ID = "course-pathology";
const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const DOC1 = "doc-cell-injury-slides";
const DOC2 = "doc-inflammation-slides";

const cellInjuryDoc: SourceDocument = {
  id: DOC1,
  lectureId: L1,
  title: "Cell Injury — Lecture Slides",
  pages: [
    {
      number: 1,
      title: "Cell injury: an overview",
      text: "Cells maintain a narrow steady state. When stress exceeds the cell's adaptive capacity, injury results. Injury is reversible up to a point; beyond that point the cell dies. The clinically important question is always: which side of that threshold is this cell on?",
    },
    {
      number: 2,
      title: "Hypoxia and ischaemia",
      text: "Hypoxia — reduced oxygen availability — is the most common cause of cell injury. Ischaemia, the loss of blood supply, is the most common cause of hypoxia, and injures faster than hypoxia alone because it also removes substrate delivery and waste clearance.",
    },
    {
      number: 3,
      title: "Reversible vs irreversible injury",
      text: "Reversible injury features cellular swelling and fatty change; the cell recovers if the stress is removed. Irreversible injury is marked by severe membrane damage and mitochondrial dysfunction. Membrane integrity is the practical dividing line.",
    },
    {
      number: 4,
      title: "Hypoxia lowers ATP",
      text: "Oxygen is the terminal electron acceptor of oxidative phosphorylation. Without it, mitochondrial ATP production falls sharply. The cell switches to anaerobic glycolysis, which yields far less ATP and lowers intracellular pH through lactate accumulation.",
    },
    {
      number: 5,
      title: "Failure of the Na+/K+ ATPase",
      text: "The Na+/K+ ATPase consumes a large share of the cell's ATP budget, exporting three sodium ions for every two potassium ions imported. It is therefore among the first processes to fail as ATP falls. When the pump fails, sodium is no longer exported.",
    },
    {
      number: 6,
      title: "Cellular swelling",
      text: "Sodium accumulates intracellularly and water follows it osmotically. The cell and its organelles swell — the earliest morphological change of reversible injury, visible as hydropic change and as blebbing of the plasma membrane.",
    },
  ],
};

const inflammationDoc: SourceDocument = {
  id: DOC2,
  lectureId: L2,
  title: "Acute Inflammation — Lecture Slides",
  pages: [
    {
      number: 1,
      title: "Acute inflammation: purpose",
      text: "Acute inflammation is the rapid, stereotyped response of vascularised tissue to injury or infection. Its purpose is to deliver leucocytes and plasma proteins to the site of damage. It follows injury — including the ATP-depletion injury covered in the previous lecture.",
    },
    {
      number: 2,
      title: "The cardinal signs",
      text: "Four cardinal signs were described by Celsus: rubor (redness), calor (heat), tumor (swelling) and dolor (pain). Virchow added functio laesa, loss of function. Each maps onto an underlying vascular or cellular event.",
    },
    {
      number: 3,
      title: "Vascular response",
      text: "After transient vasoconstriction, arteriolar vasodilation increases blood flow, producing redness and heat. Increased vascular permeability then allows protein-rich fluid to escape into the tissue, producing exudate and swelling.",
    },
    {
      number: 4,
      title: "Leucocyte margination and adhesion",
      text: "As flow slows through the dilated vessel, neutrophils move out of the central axial stream to the endothelial surface — margination. Selectins mediate rolling; integrins mediate firm adhesion before the cell transmigrates between endothelial cells.",
    },
    {
      number: 5,
      title: "Chemotaxis",
      text: "Once in the tissue, neutrophils migrate along a chemical gradient toward the injury. Classic chemoattractants include C5a, leukotriene B4, bacterial N-formyl peptides and IL-8.",
    },
  ],
};

function src(
  lectureId: string,
  documentId: string,
  pageNumber: number,
  excerpt: string,
) {
  return { courseId: COURSE_ID, lectureId, documentId, pageNumber, excerpt };
}

export const concepts: Concept[] = [
  /* ---------------- Lecture 1: Cell Injury ---------------- */
  {
    id: "c-hypoxia",
    courseId: COURSE_ID,
    lectureId: L1,
    title: "Hypoxia is the most common cause of cell injury",
    summary:
      "Hypoxia means reduced oxygen availability; ischaemia is its most common cause and injures faster because substrate delivery also stops.",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: [],
    source: src(L1, DOC1, 2, "Hypoxia — reduced oxygen availability — is the most common cause of cell injury."),
    retrievalItems: [
      {
        id: "c-hypoxia-1",
        conceptId: "c-hypoxia",
        kind: "BASIC",
        prompt: "What is the most common cause of cell injury, and what is the most common cause of that?",
        requiredKeywords: [["hypoxia"], ["ischaemia", "ischemia", "loss of blood supply", "blood supply"]],
        acceptableAnswers: [],
        explanation:
          "Hypoxia is the most common cause of cell injury, and ischaemia — loss of blood supply — is the most common cause of hypoxia.",
      },
      {
        id: "c-hypoxia-2",
        conceptId: "c-hypoxia",
        kind: "MECHANISM",
        prompt: "Why does ischaemia injure a cell faster than hypoxia alone?",
        requiredKeywords: [["substrate", "glucose", "nutrients", "nutrient"], ["waste", "metabolites", "clearance"]],
        acceptableAnswers: [],
        explanation:
          "Ischaemia removes substrate delivery and waste clearance as well as oxygen, so glycolysis cannot be sustained either.",
      },
    ],
  },
  {
    id: "c-reversible-irreversible",
    courseId: COURSE_ID,
    lectureId: L1,
    title: "Reversible vs irreversible injury",
    summary:
      "Reversible injury shows swelling and fatty change; irreversible injury is defined by severe membrane damage and mitochondrial dysfunction.",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: [],
    source: src(L1, DOC1, 3, "Irreversible injury is marked by severe membrane damage and mitochondrial dysfunction."),
    retrievalItems: [
      {
        id: "c-rev-1",
        conceptId: "c-reversible-irreversible",
        kind: "BASIC",
        prompt: "Which structural change marks the transition from reversible to irreversible cell injury?",
        requiredKeywords: [["membrane"], ["damage", "injury", "rupture", "loss", "integrity"]],
        acceptableAnswers: [],
        explanation:
          "Severe membrane damage marks irreversibility — membrane integrity is the practical dividing line.",
      },
      {
        id: "c-rev-2",
        conceptId: "c-reversible-irreversible",
        kind: "CLOZE",
        prompt: "Reversible injury features cellular ___ and fatty change.",
        requiredKeywords: [["swelling", "swell", "swells"]],
        acceptableAnswers: ["swelling"],
        explanation: "Cellular swelling and fatty change are the hallmarks of reversible injury.",
      },
    ],
  },
  {
    id: "c-atp-depletion",
    courseId: COURSE_ID,
    lectureId: L1,
    title: "ATP depletion",
    summary:
      "Without oxygen, oxidative phosphorylation stops and ATP falls; the cell switches to anaerobic glycolysis and pH drops.",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: ["c-hypoxia"],
    source: src(L1, DOC1, 4, "Without it, mitochondrial ATP production falls sharply."),
    retrievalItems: [
      {
        id: "c-atp-1",
        conceptId: "c-atp-depletion",
        kind: "MECHANISM",
        prompt:
          "Hypoxia lowers cellular ATP. Which membrane pump fails first as a result, and what does the cell then accumulate?",
        requiredKeywords: [
          ["na+/k+ atpase", "na/k atpase", "na k atpase", "sodium potassium pump", "sodium-potassium pump", "atpase"],
          ["sodium", "na+", "na"],
          ["water"],
        ],
        acceptableAnswers: [],
        explanation:
          "The Na+/K+ ATPase fails first because it consumes a large share of the ATP budget. Sodium is no longer exported, so sodium accumulates intracellularly and water follows osmotically.",
      },
      {
        id: "c-atp-2",
        conceptId: "c-atp-depletion",
        kind: "FREE_RECALL",
        prompt:
          "Write out the ATP-depletion cascade in order, from the loss of ATP to the visible change in the cell.",
        requiredKeywords: [
          ["atp"],
          ["atpase", "pump"],
          ["swelling", "swell", "swells", "oedema", "edema"],
        ],
        acceptableAnswers: [],
        explanation:
          "ATP depletion → Na+/K+ ATPase failure → intracellular sodium and water accumulation → cellular swelling.",
      },
      {
        id: "c-atp-3",
        conceptId: "c-atp-depletion",
        kind: "CLOZE",
        prompt:
          "Failure of the ___ pump after ATP depletion is what drives intracellular sodium and water accumulation.",
        requiredKeywords: [
          ["na+/k+ atpase", "na/k atpase", "na k atpase", "sodium potassium pump", "sodium-potassium pump", "atpase"],
        ],
        acceptableAnswers: ["na+/k+ atpase", "na/k atpase", "sodium potassium pump"],
        explanation: "The Na+/K+ ATPase pump. It is the first major consumer of ATP to fail.",
      },
    ],
  },
  {
    id: "c-na-k-atpase",
    courseId: COURSE_ID,
    lectureId: L1,
    title: "Na+/K+ ATPase failure",
    summary:
      "The pump exports 3 Na+ for every 2 K+ imported and consumes a large share of cellular ATP, so it fails early when ATP falls.",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: ["c-atp-depletion"],
    source: src(L1, DOC1, 5, "The Na+/K+ ATPase consumes a large share of the cell's ATP budget, exporting three sodium ions for every two potassium ions imported."),
    retrievalItems: [
      {
        id: "c-nak-1",
        conceptId: "c-na-k-atpase",
        kind: "BASIC",
        prompt: "What is the stoichiometry of the Na+/K+ ATPase, and why does it fail early in hypoxia?",
        requiredKeywords: [["three", "3"], ["two", "2"], ["atp"]],
        acceptableAnswers: [],
        explanation:
          "Three sodium out for every two potassium in. It consumes a large share of the cell's ATP, so falling ATP hits it first.",
      },
      {
        id: "c-nak-2",
        conceptId: "c-na-k-atpase",
        kind: "MECHANISM",
        prompt: "When the Na+/K+ ATPase fails, what happens to intracellular sodium?",
        requiredKeywords: [["accumulates", "rises", "increases", "builds", "accumulate", "increase", "high"]],
        acceptableAnswers: [],
        explanation: "Sodium is no longer exported, so it accumulates inside the cell.",
      },
    ],
  },
  {
    id: "c-cellular-swelling",
    courseId: COURSE_ID,
    lectureId: L1,
    title: "Cellular swelling",
    summary:
      "Water follows accumulated intracellular sodium osmotically, swelling the cell and its organelles — the earliest morphological change of reversible injury.",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: ["c-na-k-atpase"],
    source: src(L1, DOC1, 6, "Sodium accumulates intracellularly and water follows it osmotically."),
    retrievalItems: [
      {
        id: "c-swell-1",
        conceptId: "c-cellular-swelling",
        kind: "MECHANISM",
        prompt: "Why does the cell swell once sodium accumulates inside it?",
        requiredKeywords: [["water"], ["osmotic", "osmotically", "osmosis", "follows", "follow"]],
        acceptableAnswers: [],
        explanation: "Water follows sodium osmotically, so the cell and its organelles swell.",
      },
      {
        id: "c-swell-2",
        conceptId: "c-cellular-swelling",
        kind: "BASIC",
        prompt: "What is the earliest morphological change of reversible cell injury?",
        requiredKeywords: [["swelling", "swell", "swells", "hydropic"]],
        acceptableAnswers: ["cellular swelling", "swelling"],
        explanation: "Cellular swelling — seen as hydropic change and membrane blebbing.",
      },
    ],
  },
  {
    id: "c-draft-lysosomal",
    courseId: COURSE_ID,
    lectureId: L1,
    title: "Lysosomal enzyme leakage (candidate)",
    summary:
      "Extracted candidate concept awaiting review: lysosomal membrane rupture releases hydrolases that digest cellular components.",
    importance: "SUPPORTING",
    status: "DRAFT",
    prerequisiteIds: ["c-reversible-irreversible"],
    source: src(L1, DOC1, 3, "Irreversible injury is marked by severe membrane damage and mitochondrial dysfunction."),
    retrievalItems: [
      {
        id: "c-draft-lyso-1",
        conceptId: "c-draft-lysosomal",
        kind: "BASIC",
        prompt: "What do ruptured lysosomes release into the cytoplasm?",
        requiredKeywords: [["hydrolases", "enzymes", "hydrolase", "enzyme"]],
        acceptableAnswers: [],
        explanation: "Acid hydrolases, which digest cellular components.",
      },
    ],
  },

  /* ---------------- Lecture 2: Inflammation ---------------- */
  {
    id: "c-cardinal-signs",
    courseId: COURSE_ID,
    lectureId: L2,
    title: "The cardinal signs of acute inflammation",
    summary:
      "Rubor, calor, tumor and dolor (Celsus), plus functio laesa (Virchow) — each maps onto a vascular or cellular event.",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: [],
    source: src(L2, DOC2, 2, "Four cardinal signs were described by Celsus: rubor (redness), calor (heat), tumor (swelling) and dolor (pain)."),
    retrievalItems: [
      {
        id: "c-signs-1",
        conceptId: "c-cardinal-signs",
        kind: "FREE_RECALL",
        prompt: "Name the four cardinal signs described by Celsus.",
        requiredKeywords: [
          ["rubor", "redness"],
          ["calor", "heat"],
          ["tumor", "swelling"],
          ["dolor", "pain"],
        ],
        acceptableAnswers: [],
        explanation: "Rubor, calor, tumor, dolor — redness, heat, swelling and pain.",
      },
      {
        id: "c-signs-2",
        conceptId: "c-cardinal-signs",
        kind: "BASIC",
        prompt: "Which fifth sign did Virchow add?",
        requiredKeywords: [["functio laesa", "loss of function"]],
        acceptableAnswers: ["functio laesa", "loss of function"],
        explanation: "Functio laesa — loss of function.",
      },
    ],
  },
  {
    id: "c-vasodilation",
    courseId: COURSE_ID,
    lectureId: L2,
    title: "Vasodilation and increased permeability",
    summary:
      "Arteriolar vasodilation raises blood flow (redness, heat); increased permeability lets protein-rich exudate escape (swelling).",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: ["c-cardinal-signs"],
    source: src(L2, DOC2, 3, "After transient vasoconstriction, arteriolar vasodilation increases blood flow, producing redness and heat."),
    retrievalItems: [
      {
        id: "c-vaso-1",
        conceptId: "c-vasodilation",
        kind: "MECHANISM",
        prompt: "Which two vascular changes produce redness/heat and swelling respectively?",
        requiredKeywords: [
          ["vasodilation", "vasodilatation", "dilation", "dilatation"],
          ["permeability"],
        ],
        acceptableAnswers: [],
        explanation:
          "Vasodilation increases flow (redness and heat); increased vascular permeability produces exudate and swelling.",
      },
      {
        id: "c-vaso-2",
        conceptId: "c-vasodilation",
        kind: "CLOZE",
        prompt: "Protein-rich fluid escaping into the tissue is called ___.",
        requiredKeywords: [["exudate"]],
        acceptableAnswers: ["exudate"],
        explanation: "Exudate — protein-rich, unlike a transudate.",
      },
    ],
  },
  {
    id: "c-margination",
    courseId: COURSE_ID,
    lectureId: L2,
    title: "Leucocyte margination and adhesion",
    summary:
      "Slowed flow lets neutrophils leave the axial stream; selectins mediate rolling and integrins mediate firm adhesion.",
    importance: "CORE",
    status: "ACTIVE",
    prerequisiteIds: ["c-vasodilation"],
    source: src(L2, DOC2, 4, "Selectins mediate rolling; integrins mediate firm adhesion before the cell transmigrates between endothelial cells."),
    retrievalItems: [
      {
        id: "c-marg-1",
        conceptId: "c-margination",
        kind: "MECHANISM",
        prompt: "Which molecules mediate neutrophil rolling, and which mediate firm adhesion?",
        requiredKeywords: [["selectins", "selectin"], ["integrins", "integrin"]],
        acceptableAnswers: [],
        explanation: "Selectins mediate rolling; integrins mediate firm adhesion.",
      },
      {
        id: "c-marg-2",
        conceptId: "c-margination",
        kind: "CLOZE",
        prompt: "Neutrophils moving out of the central axial stream to the endothelial surface is called ___.",
        requiredKeywords: [["margination"]],
        acceptableAnswers: ["margination"],
        explanation: "Margination.",
      },
    ],
  },
  {
    id: "c-chemotaxis",
    courseId: COURSE_ID,
    lectureId: L2,
    title: "Chemotaxis",
    summary:
      "Neutrophils migrate along a chemical gradient toward injury; classic chemoattractants are C5a, LTB4, f-Met peptides and IL-8.",
    importance: "SUPPORTING",
    status: "ACTIVE",
    prerequisiteIds: ["c-margination"],
    source: src(L2, DOC2, 5, "Classic chemoattractants include C5a, leukotriene B4, bacterial N-formyl peptides and IL-8."),
    retrievalItems: [
      {
        id: "c-chemo-1",
        conceptId: "c-chemotaxis",
        kind: "FREE_RECALL",
        prompt: "Name two classic neutrophil chemoattractants.",
        requiredKeywords: [["c5a", "leukotriene b4", "ltb4", "il-8", "il8", "n-formyl", "formyl"]],
        acceptableAnswers: [],
        explanation: "C5a, leukotriene B4, bacterial N-formyl peptides and IL-8.",
      },
      {
        id: "c-chemo-2",
        conceptId: "c-chemotaxis",
        kind: "BASIC",
        prompt: "What guides neutrophil movement once they are in the tissue?",
        requiredKeywords: [["gradient", "chemical gradient", "chemotactic"]],
        acceptableAnswers: [],
        explanation: "A chemical (chemotactic) gradient.",
      },
    ],
  },
  {
    id: "c-draft-chronic",
    courseId: COURSE_ID,
    lectureId: L2,
    title: "Transition to chronic inflammation (candidate)",
    summary:
      "Extracted candidate concept awaiting review: persistent injury shifts the infiltrate from neutrophils to macrophages and lymphocytes.",
    importance: "SUPPORTING",
    status: "DRAFT",
    prerequisiteIds: ["c-margination"],
    source: src(L2, DOC2, 1, "Acute inflammation is the rapid, stereotyped response of vascularised tissue to injury or infection."),
    retrievalItems: [
      {
        id: "c-draft-chronic-1",
        conceptId: "c-draft-chronic",
        kind: "BASIC",
        prompt: "Which cells dominate the infiltrate in chronic inflammation?",
        requiredKeywords: [["macrophages", "macrophage", "lymphocytes", "lymphocyte"]],
        acceptableAnswers: [],
        explanation: "Macrophages and lymphocytes.",
      },
    ],
  },
];

const cellInjury: Lecture = {
  id: L1,
  courseId: COURSE_ID,
  title: "Cell Injury",
  order: 1,
  documents: [cellInjuryDoc],
  chunks: [
    {
      id: "chunk-ci-1",
      lectureId: L1,
      order: 1,
      title: "Causes and reversibility",
      documentId: DOC1,
      pageNumbers: [1, 2, 3],
      conceptIds: ["c-hypoxia", "c-reversible-irreversible", "c-draft-lysosomal"],
      explanation:
        "Start with the threshold idea: a cell copes with stress until it cannot, and injury below that threshold is recoverable. Hypoxia is the commonest stressor, and ischaemia is the commonest cause of hypoxia — worse than hypoxia alone because blood carries substrate in and waste out, not just oxygen. The practical marker of irreversibility is membrane integrity: swelling and fatty change are recoverable, severe membrane damage is not.",
    },
    {
      id: "chunk-ci-2",
      lectureId: L1,
      order: 2,
      title: "The ATP depletion cascade",
      documentId: DOC1,
      pageNumbers: [4, 5, 6],
      conceptIds: ["c-atp-depletion", "c-na-k-atpase", "c-cellular-swelling"],
      explanation:
        "This is the single most examinable chain in cell injury, so learn it as a chain rather than as three facts. Oxygen is the terminal electron acceptor, so hypoxia collapses oxidative phosphorylation and ATP falls. The Na+/K+ ATPase is one of the largest consumers of that ATP — three sodium out for every two potassium in — so it fails early. Once it fails, sodium is no longer exported and accumulates; water follows it osmotically; the cell and its organelles swell. ATP depletion → Na+/K+ ATPase failure → sodium and water accumulation → cellular swelling.",
    },
  ],
};

const inflammation: Lecture = {
  id: L2,
  courseId: COURSE_ID,
  title: "Inflammation",
  order: 2,
  documents: [inflammationDoc],
  chunks: [
    {
      id: "chunk-inf-1",
      lectureId: L2,
      order: 1,
      title: "Cardinal signs and the vascular response",
      documentId: DOC2,
      pageNumbers: [1, 2, 3],
      conceptIds: ["c-cardinal-signs", "c-vasodilation", "c-draft-chronic"],
      explanation:
        "Acute inflammation follows injury — including the ATP-depletion injury from the last lecture — and exists to deliver leucocytes and plasma proteins to damaged tissue. Do not memorise the cardinal signs as a list; attach each to its mechanism. Vasodilation raises blood flow, giving rubor and calor. Increased vascular permeability lets protein-rich exudate into the tissue, giving tumor. Dolor comes from mediators and from pressure on nerve endings.",
    },
    {
      id: "chunk-inf-2",
      lectureId: L2,
      order: 2,
      title: "Leucocyte recruitment",
      documentId: DOC2,
      pageNumbers: [4, 5],
      conceptIds: ["c-margination", "c-chemotaxis"],
      explanation:
        "Recruitment is a sequence with a molecular partner at each step. Slowed flow through the dilated vessel pushes neutrophils out of the central axial stream to the endothelial surface — margination. Selectins then mediate rolling, integrins mediate firm adhesion, and the cell transmigrates between endothelial cells. In the tissue it follows a chemical gradient — C5a, LTB4, N-formyl peptides, IL-8 — to the source of injury.",
    },
  ],
};

export const pathologyCurriculum: Curriculum = {
  course: {
    id: COURSE_ID,
    title: "Pathology",
    description:
      "General pathology: how cells are injured, how they die, and how tissue responds.",
    lectures: [cellInjury, inflammation],
  },
  concepts,
};

export const DEMO_COURSE_ID = COURSE_ID;
export const DEMO_LECTURE_1 = L1;
export const DEMO_LECTURE_2 = L2;
