# Test fixtures

| File | Pages | How it was made |
|---|---|---|
| `cell-injury.pdf` | 4 | `node scripts/make-fixture-pdf.mjs` |
| `renal-short.pdf` | 2 | `node scripts/make-fixture-pdf.mjs` |
| `lecture-25-pages.pdf` | 25 | `node scripts/make-fixture-pdf.mjs` |
| `encrypted.pdf` | 4 | `cell-injury.pdf` encrypted with pypdf, RC4-128, user password `medrecall-user` |

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
