# V2-014 Run Detail Delivery Recovery Gate

V2-014 binds the Studio Run detail surface to one canonical identity across
Run status, Acceptance, Recovery, and Delivery. The local gate launches the
built Electron renderer with a disposable user data directory, seeds a failed
TaskRun and its matching recovery snapshot, and observes these clicks:

`Work Inbox -> Run detail -> Acceptance -> Recovery -> Recover Run -> Delivery`

The fixture uses `fixture-provider` metadata only. Provider execution is
disabled (`Provider=0`) and the report explicitly records that no human timed
acceptance was performed. This is local renderer evidence and does not prove
real Provider recovery, failover, signing, packaging, or release readiness.

Run the focused gate with:

```sh
npm run build
npm run test:run-detail-delivery-recovery:required
```

The report is written to
`test-results/v2-014-run-detail-delivery-recovery/latest.json`. The underlying
Electron click trace is retained at
`test-results/packaged-ui-click/latest.json`.
