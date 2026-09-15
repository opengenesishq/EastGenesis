# Provider capability and health contract

The 0913 Provider slice keeps two kinds of evidence separate:

- `src/shared/provider-capability-card.ts` projects saved model declarations and bounded generation verification into a non-secret capability card. A successful generation probe verifies text generation only; it does not verify tools, vision, image, video, or audio capability.
- `src/shared/provider-health-contract.ts` projects persisted health into an explicit state and access decision. `healthy/automatic` requires a closed circuit and an observed successful probe or generation history. `degraded/automatic` preserves routing while exposing recent failures. `half_open/probe_only`, `unprobed/probe_only`, and `unhealthy/blocked` fail closed for ordinary automatic routing.

The required gate is `npm run test:provider-capability-health:required`. It uses synthetic records, makes zero Provider or network requests, and writes `test-results/provider-capability-card/latest.json`. The report is local contract evidence only; it does not establish production availability, task completion, pricing accuracy, or human onboarding time.
