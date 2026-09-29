# Test fixtures

| File | Pages | How it was made |
|---|---|---|
| `cell-injury.pdf` | 4 | `node scripts/make-fixture-pdf.mjs` |
| `renal-short.pdf` | 2 | `node scripts/make-fixture-pdf.mjs` |
| `lecture-25-pages.pdf` | 25 | `node scripts/make-fixture-pdf.mjs` |
| `encrypted.pdf` | 4 | `cell-injury.pdf` encrypted with pypdf, RC4-128, user password `medrecall-user` |
| `Cell Injury.pdf`, `Inflammation.pdf` | 10, 6 | `node scripts/make-lecture-fixtures.mjs` |
| `Hepatic Injury, Repair and Fibrosis in Alcoholic, Viral and Drug-Induced Liver Disease.pdf` | 11 | `node scripts/make-unseen-fixture.mjs` — the *unseen* lecture: content written independently of the lecture fixtures the generator was developed on, with the adversarial cases the merge-gate tests check (untranslatable English, temporal "by"/"within", "most specific", a picture drawn twice with contradictory captions, another drawn twice with the same caption, an uncaptioned image, "centrilobular" vs "bridging" necrosis, a long title). A unit test checks the file equals the script's output. |

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
