# Visual regression suite

`npm run test:visual --workspace=app` starts the app and a local fixture indexer,
then compares the home empty state, create validation error, active and pending
circle details, and reputation indexer outage at desktop and mobile sizes. The
suite uses fixed API responses, reduced motion, and no wallet or network
credentials.

When an intentional UI change requires new baselines, run
`npm run test:visual --workspace=app -- --update-snapshots`, review every image
under `__screenshots__`, and include the approved updates in the same change.
Do not update snapshots solely to silence a failing comparison.