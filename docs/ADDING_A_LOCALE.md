# Adding a language

All user-facing text lives in ICU MessageFormat JSON files under `ui/src/locales/<code>/`:

| File | Contents |
|---|---|
| `common.json` | interface text, property names, stage names, report labels |
| `elements.json` | element names, families, crystal structures, uses, data notes |
| `issues.json` | validation reason codes (`code.*`) and repair operations (`fix.*`) |

English (`en`) is the reference. A language is shipped only when it is complete.

## Steps

1. Copy `ui/src/locales/en/` to `ui/src/locales/<code>/` (for example `ar`, `ja`, `pt-BR`) and
   translate every value. Keep keys and `{placeholders}` exactly as they are; reorder them freely
   if the language's word order needs it.
2. Use ICU syntax for anything that varies. Plurals use your language's categories, for example
   Arabic `zero/one/two/few/many/other` and Thai `other` only:
   `"{count, plural, one {# molecule} other {# molecules}}"`. Use `select` for grammatical
   gender, and `{n, number}` for locale-aware digits. Never build a sentence by concatenating
   fragments in code.
3. Register the language in `ui/src/lib/i18n.ts`: import the three files, add them to `resources`,
   and add `{ code, label, dir }` to `LOCALES`. The label is the language's own name. Right-to-left
   languages (ar, he, fa, ur) are detected automatically: `applyDirection` sets
   `<html dir="rtl">`, and every layout uses logical CSS properties (`ms-*`, `ps-*`, `start-*`,
   `text-start`), so the interface mirrors without further changes.
4. Run the coverage gate:

   ```bash
   pnpm --dir ui i18n:check
   ```

   It fails if any key is missing or extra, if a message is not valid ICU, if placeholders differ
   from English, or if any value produced by the data or the compute engine (element symbols,
   categories, crystal structures, uses, notes, reason codes, fixes, library families, pKa
   groups, property names, job stages, simulation warnings, report labels) has no translation.
   The compute tests (`tests/unit/compute/test_issue_codes.py`) check every locale folder for the
   engine's reason codes and warning codes.
5. Run the unit tests (`pnpm --dir ui test`), then switch to the new language in the app and walk
   through every view. Long words can wrap differently; check the toolbar and the inspector.

The PDF repair report uses IBM Plex Sans Thai, which covers Latin and Thai. A script outside those
ranges (Arabic, CJK) needs a matching OFL font added to `scripts/engines.lock.json` (`fonts`) and
registered in `compute/mfcompute/chem/report.py`.
