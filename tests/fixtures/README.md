# Test fixtures

| File | Pages | How it was made |
|---|---|---|
| `cell-injury.pdf` | 4 | `node scripts/make-fixture-pdf.mjs` |
| `renal-short.pdf` | 2 | `node scripts/make-fixture-pdf.mjs` |
| `lecture-25-pages.pdf` | 25 | `node scripts/make-fixture-pdf.mjs` |
| `encrypted.pdf` | 4 | `cell-injury.pdf` encrypted with pypdf, RC4-128, user password `medrecall-user` |
| `Cell Injury.pdf`, `Inflammation.pdf` | 10, 6 | `node scripts/make-lecture-fixtures.mjs` |
| `Hepatic Injury, Repair and Fibrosis in Alcoholic, Viral and Drug-Induced Liver Disease.pdf` | 11 | `node scripts/make-unseen-fixture.mjs` — the *unseen* lecture: content written independently of the lecture fixtures the generator was developed on, with the adversarial cases the merge-gate tests check (untranslatable English, temporal "by"/"within", "most specific", a picture drawn twice with contradictory captions, another drawn twice with the same caption, an uncaptioned image, "centrilobular" vs "bridging" necrosis, a long title). A unit test checks the file equals the script's output. |

### `benchmark/` — the trusted-cards benchmark

Five lectures from three PDF producers, used by `tests/unit/benchmark-lectures.test.ts`
(verbatim single-block excerpts, no cross-drug attribution, no opposite-subtype
picture, 20 ⊂ 40 ⊂ 60, exact cards). Synthetic "photographs" (PIL) so nothing
is copyrighted; the medical text is written for these files.

| File | Pages | How it was made |
|---|---|---|
| `cell-injury.pdf` | 15 | `generators/images.py`, `generators/decks.py` (python-pptx), then `soffice --headless --convert-to pdf` (LibreOffice 24.2 Impress): wrapped bullets, pronouns, a lecturer-question slide, two tables, side-by-side wet/dry gangrene with their own captions, two-column apoptosis pathways |
| `autonomic-pharmacology.pdf` | 16 | same: receptor table, drug paragraphs in two columns (atropine / clonidine, …), sub-bullets, a case vignette, drug tables, summary fragments |
| `pathology-images.pdf` | 12 | same: a repeated logo, subtype pairs (wet/dry, papillary/follicular, type 1/2, normal/cirrhotic, left/right, acute/chronic), one caption shared by two pictures, a table rendered as an image, a thumbnail, labels over an image |
| `heldout-hemodynamics-diuretics.pdf` | 10 | `generators/make_heldout1.py` then `node generators/print-heldout.mjs` (HTML slides printed by Chromium): written after the generator was tuned on the three decks above |
| `heldout2-neoplasia-anticoagulants.pdf` | 4 | `generators/make_heldout2.py` (reportlab, a two-column handout): written after all tuning and measured once before its own fixes |

`encrypted.pdf` is a genuinely encrypted file, so the ENCRYPTED path is exercised
through pdfjs's own `PasswordException` rather than a mocked error. To regenerate:

```python
from pypdf import PdfReader, PdfWriter
reader = PdfReader("tests/fixtures/cell-injury.pdf")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
writer.encrypt(user_password="medrecall-user", owner_password="medrecall-owner", algorithm="RC4-128")
writer.write("tests/fixtures/encrypted.pdf")
```

`main-learner-state.ts` is learner state exactly as `main@482824c` (before card
study) saved it — no `pendingTutorRemediation`, no `cards`. It was captured by
running that commit's own engine (chunk 1 taught, a wrong Tutor INITIAL answer
on c-hypoxia, then for `MAIN_REMEDIATED` a correct remediation) and serialising
the result, and is used to prove such state still migrates correctly.
