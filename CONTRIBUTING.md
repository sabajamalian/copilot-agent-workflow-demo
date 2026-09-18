# Contributing

Keep this a small, inspectable teaching example. Change canonical plugin source,
then run `npm run check`, `npm test`, and `npm run demo:test`. No dependency
installation is needed.

Preserve explicit opt-in, session/run/stage validation, finite transitions, and
normal approval gates. Add regression tests for every lifecycle change. Record
real-runtime evidence separately from mocked tests, and don't imply a passing
unit test proves an experimental host API works.

The installer owns only its exact hash-tracked files. Don't add force-overwrite,
global configuration edits, or broad cleanup. Explain migration and recovery
when changing persisted state or installation layouts.

Update plugin, package, and marketplace versions together. Run a small live
sample before publishing a new version where access is available. Keep personal
paths, session transcripts, credentials, and private source out of commits.

Demo agents must not publish their own results. Humans review and commit changes;
CI and repository controls remain authoritative.
