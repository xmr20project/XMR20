STALLED ATTEMPT (integration run 2, 24 Oct 2026 23:50:58 local start; interop.test.mjs started ~23:06 UTC and never finished)
Observed: integration-suite.log stayed at "[suite] interop vectors + independent checker (interop.test.mjs)…" for over an hour;
runs/interop-results.json written with zero transfers; evidence/verified-interop-2026-10-24T23-06-34 holds steps.json=[] and a
network audit with zero requests; `node --test interop.test.mjs`, its child and one Playwright Chromium stayed alive with no
fakechain child (backend.close() had already run in the test's finally); integration-report.json absent. See process-snapshot.txt.
Actual failure (confirmed by reproduction, harness-fix-smoke.txt case 3): this candidate had NO wallet-extension/extension-private-
holder-test build (only the stagenet build was copied from privacy-stagenet-wallet-20261024), so Chromium started with a
non-existent --load-extension path, no extension service worker ever appeared and h.launch threw
  browserContext.waitForEvent: Timeout 30000ms exceeded while waiting for event "serviceworker"
30 s after launching the browser (53 s after the test started; audit written 31 s after the browser started). Because h.launch
created the browser context and waited for the service worker BEFORE returning it, the test's `context` stayed null, its finally
closed the backend and wrote the empty audit, the test failed, and the still-open Chromium kept the test process alive forever.
The suite runner buffered all child output until exit and had no bound, so nothing was visible and nothing ended the run.
Fixes (no assertion changed): (1) local test extension built inside the candidate (wallet-extension/server-patch/extension-auth.mjs,
a plain source module the copy had dropped, restored first); (2) browser-harness.mjs h.launch refuses a missing build before
launching and closes the context itself when the service-worker wait fails; (3) integration-suite.mjs streams every suite's output
to runs/suite-logs/, echoes failures and a heartbeat per minute, bounds each suite and terminates its whole process group on the
bound; the missing migration suite was added, the interop row was renamed to what the test does, and the independent checker is
its own row. Files here: process-snapshot.txt, interop-results.json, verified-interop-2026-10-24T23-06-34/, integration-suite-
attempt2-interop-stalled.log (the suite log of the attempt; its first ten suites PASSED and are carried into the completing run).
