# Monitoring deployment and safe delivery test

Status: **rule files and routing config VALIDATED 2026-10-21 (section 4); alert DELIVERY still UNVERIFIED.**
`promtool` and `amtool` now pass against the files in this directory, which proves the rules parse, evaluate and
annotate as intended and that the Alertmanager skeleton in section 3 routes as described. That is all it proves.
Nothing in this repository runs Prometheus or Alertmanager, and no destination (pager, chat, e-mail) exists in the
code or docs. Every receiver below is a `PLACEHOLDER`: the operator must supply real ones. **No alert from this
repository has ever been delivered to a human.** Do not paste real credentials into this repository; keep them in
the monitoring system's secret store.

## 1. Prerequisites on the API side

1. `METRICS_TOKEN` set to a random value of at least 16 characters (for example `openssl rand -hex 32`), different
   per environment. Unset or shorter means `/metrics` answers 404 (by design).
2. The hostname Prometheus uses to reach the API must be in `API_PRIVATE_HOSTS` (comma list). Any other Host, and any
   request carrying `X-Forwarded-For`, `X-Forwarded-Host` or `Forwarded`, gets 404 even with the right token. Scrape
   the instance directly (private IP / service DNS), never through the public load balancer, tunnel or ngrok.
3. `/metrics` is NOT exempt from the global per-IP rate limit (verified in `metrics.socket.test.ts`). The default
   budget is generous and a 15-30 s scrape from one Prometheus is far below it, but many scrapers behind one NAT
   address, or a scrape loop, share that IP's bucket with other private-network traffic. If `/metrics` ever returns
   429 or 503 (fail-closed limiter) the scrape fails and `MetricsTargetDown` fires after 5 minutes.
4. State is per process: scrape EVERY instance (service discovery), not a load-balanced VIP.

## 2. Prometheus scrape config

```yaml
# prometheus.yml (fragment)
global:
  scrape_interval: 30s
  evaluation_interval: 30s

rule_files:
  - /etc/prometheus/rules/alert-rules.yml          # copy of docs/security/alert-rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager.monitoring.internal:9093"]   # PLACEHOLDER hostname

scrape_configs:
  - job_name: voice-agent-api          # alert-rules.yml (MetricsTargetDown, ApiRestartLoop) assumes this exact name
    metrics_path: /metrics
    scheme: http                       # private network only; use https + tls_config if your mesh terminates TLS
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/voice-agent-metrics-token   # file contains ONLY the token; mode 0400
    static_configs:                    # or dns_sd_configs / kubernetes_sd_configs
      - targets: ["api-1.internal.example:3001", "api-2.internal.example:3001"]   # PLACEHOLDER private names
    relabel_configs:
      # The `instance` label is host:port, which can be a private IP or pod name. Replace it with a stable,
      # non-identifying name so IPs/pod names do not leak into alerts and dashboards.
      - source_labels: [__address__]
        regex: "(api-[0-9]+)\\..*"
        target_label: instance
        replacement: "$1"
      - regex: "(pod_ip|node|__meta_kubernetes_pod_ip)"   # drop any discovery label that carries an address
        action: labeldrop
    metric_relabel_configs: []         # metrics.ts only emits short [a-z0-9_.:-] label values; nothing to scrub
```

Notes:

- `credentials_file` (not inline `credentials`) keeps the token out of the config file and out of `/api/v1/status/config`.
- The application never logs the token (`metrics.socket.test.ts` checks every log line written during the requests);
  Prometheus will show a scrape error text but not the token.
- Rotate `METRICS_TOKEN` by deploying the new value and updating the file; Prometheus re-reads the file on each
  scrape. During the gap scrapes return 401 for at most one deploy (shorter than the 5 m `for:` of MetricsTargetDown).
- `up == 0` with HTTP 404 in the target page means the Host is not in `API_PRIVATE_HOSTS` or `METRICS_TOKEN` is
  unset; 401 means a token mismatch; 429 means the rate limit.

## 3. Alertmanager skeleton (all receivers are placeholders)

```yaml
# alertmanager.yml (fragment) - EVERY receiver target below is a PLACEHOLDER, none exists.
route:
  receiver: ops-default                 # PLACEHOLDER
  group_by: [alertname, instance]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: [severity = "none", alertname = "Watchdog"]
      receiver: heartbeat               # dead-man's switch; never a pager
      repeat_interval: 5m
      continue: false
    - matchers: [test = "delivery-check"]
      receiver: delivery-test           # non-paging sink used by the safe test in section 5
      continue: false
    - matchers: [severity = "critical"]
      receiver: oncall-pager            # PLACEHOLDER
    - matchers: [severity = "warning"]
      receiver: ops-default             # PLACEHOLDER

inhibit_rules:
  # An unscrapable instance makes its own alerts meaningless; show only MetricsTargetDown for it.
  - source_matchers: [alertname = "MetricsTargetDown"]
    target_matchers: [severity =~ "warning|critical"]
    equal: [instance]

receivers:
  - name: ops-default
    # PLACEHOLDER: e.g. a chat or e-mail receiver. Fill in from your secret store.
  - name: oncall-pager
    # PLACEHOLDER: your paging integration.
  - name: heartbeat
    # PLACEHOLDER: a dead-man's-switch service that alerts when the Watchdog stops arriving.
  - name: delivery-test
    # PLACEHOLDER: a NON-paging sink (a private test channel or a local webhook receiver you control).
```

A receiver with no `*_configs` is valid YAML and silently drops notifications. Replace every placeholder before
relying on this.

## 4. Validate the rules offline (no delivery)

Run on **2026-10-21** from `docs/security/`, using the official Docker images (Docker Desktop 29.6.1, Windows). The
images were pulled for this check; no global software was installed. Exact images:

| Image | Digest | Tool version |
|---|---|---|
| `prom/prometheus:latest` | `sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e` | promtool 3.15.0 (go1.27.1, built 2026-09-25) |
| `prom/alertmanager:latest` | `sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a` | amtool 0.34.1 (go1.26.8, built 2026-09-17) |

`latest` is a moving tag: pin a digest or a version tag if you need to reproduce these results exactly. If you have
the binaries on PATH, drop the `docker run --rm -v "$PWD:/w" -w /w --entrypoint <tool>` prefix from each command.

### 4.1 Rule file syntax - PASS

```sh
docker run --rm -v "$PWD:/w" -w /w --entrypoint promtool prom/prometheus:latest check rules alert-rules.yml
```

```
Checking alert-rules.yml
  SUCCESS: 19 rules found
```

### 4.2 Rule unit tests - PASS

```sh
docker run --rm -v "$PWD:/w" -w /w --entrypoint promtool prom/prometheus:latest test rules alert-rules.test.yml
```

```
  SUCCESS
```

All 24 test cases (30 `eval_time` assertions) pass, and each of the 19 alerts in `alert-rules.yml` is named by at
least one case. **No rule and no test needed changing** on the first run: the annotations in the two files already
matched exactly, and every `for:`/threshold assertion held.

A passing run prints one word, which is easy to mistake for a harness that did nothing, so the harness was confirmed
to be live. With `summary: "Many throttled MFA attempts"` changed to `"Many throttled MFA attempts!!"` in a
throwaway copy of `alert-rules.yml` outside the repository, promtool reported:

```
  FAILED:
    name: MfaThrottleSpike fires on > 10 throttled MFA attempts in 10 minutes,
    alertname: MfaThrottleSpike, time: 15m,
        exp:[ ... summary="Many throttled MFA attempts"}]
        got:[ ... summary="Many throttled MFA attempts!!"}]
```

The copy was discarded; the files in this directory are unmodified. That is exactly the failure to expect when a
summary or action is edited in one file and not the other.

### 4.3 Alertmanager config and routing - PASS (structure only)

The section 3 skeleton is a fragment inside this document, not a loadable file, so it was extracted verbatim to a
temporary `alertmanager.yml` outside the repository and checked there. The repository still carries no real
`alertmanager.yml` on purpose: such a file must name receivers, and committed placeholder receivers that silently
drop every notification are more dangerous than an obvious fragment.

```sh
docker run --rm -v "$PWD:/w" -w /w --entrypoint amtool prom/alertmanager:latest check-config alertmanager.yml
```

```
Checking 'alertmanager.yml'  SUCCESS
Found:
 - global config
 - route
 - 1 inhibit rules
 - 4 receivers
 - 0 templates
```

Routing checks (static, no network). Each printed exactly the receiver named in `--verify.receivers` and exited 0:

```sh
amtool config routes test --config.file=alertmanager.yml --verify.receivers=oncall-pager  severity=critical alertname=DbAuthorizationErrors   # -> oncall-pager
amtool config routes test --config.file=alertmanager.yml --verify.receivers=delivery-test test=delivery-check severity=critical alertname=DeliveryTest  # -> delivery-test
amtool config routes test --config.file=alertmanager.yml --verify.receivers=heartbeat     severity=none alertname=Watchdog                     # -> heartbeat
```

`amtool config routes show --config.file=alertmanager.yml` prints the tree below. Read it to confirm no `critical`
alert lands on `ops-default`, and note that the second case above is routed to `delivery-test` despite being
`severity=critical`, because the `test` matcher is ordered ahead of the pager route. That ordering is what makes the
section 5 synthetic test safe.

```
Routing tree:
.
└── default-route  receiver: ops-default
    ├── {alertname="Watchdog",severity="none"}  receiver: heartbeat
    ├── {test="delivery-check"}  receiver: delivery-test
    ├── {severity="critical"}  receiver: oncall-pager
    └── {severity="warning"}  receiver: ops-default
```

This proves the routing TREE is right. It proves nothing about delivery: every receiver here has no `*_configs`, so
a real Alertmanager would accept each of these notifications and then drop it.

### 4.4 Scrape config - PASS (structure only, two paths rewritten)

The section 2 fragment was checked too, because a bad `relabel_configs` regex or a misspelled field would otherwise
only surface in production. It names absolute paths that do not exist on a review machine, so `rule_files` was
pointed at a local copy of `alert-rules.yml` and `credentials_file` at a dummy token file. Nothing else was changed:

```sh
docker run --rm -v "$PWD:/w" -w /w --entrypoint promtool prom/prometheus:latest check config prometheus.yml
```

```
Checking prometheus.yml
  SUCCESS: 1 rule files found
 SUCCESS: prometheus.yml is valid prometheus config file syntax

Checking alert-rules.yml
  SUCCESS: 19 rules found
```

Run `promtool check config` again against YOUR real `prometheus.yml`: with the real paths in place it also verifies
that `credentials_file` exists and is readable, which the rewritten copy above cannot.

### 4.5 What section 4 did NOT verify

- **Alert delivery to any destination.** Not tested, and not testable from here: no receiver exists, and no
  external service was contacted. See section 5; the status stays "alert delivery UNVERIFIED".
- That a real Prometheus can scrape the API at all (`METRICS_TOKEN`, `API_PRIVATE_HOSTS`, network path, the per-IP
  rate limit in section 1). No API instance and no Prometheus server were run - only the offline `promtool`/`amtool`
  checkers.
- That `credentials_file` resolves in a real deployment (see 4.4).
- Threshold calibration. promtool proves each rule fires on the synthetic series in `alert-rules.test.yml`; it
  cannot say whether "> 20 denials in 10 m" is the right number for your traffic.
- The inhibit rule's runtime effect. `check-config` parses it; suppression only happens in a running Alertmanager.

## 5. Safe delivery test (never touches the pager)

Goal: prove Prometheus -> Alertmanager -> receiver works, and prove the pager route is wired, without paging anyone.

1. Heartbeat: the always-firing `Watchdog` rule in `alert-rules.yml` reaches the `heartbeat` receiver. Confirm it is
   received there; configure the receiving service to alert when it stops arriving.
2. Synthetic alert to a non-paging receiver. Post a test alert directly to Alertmanager's v2 API. The `test` label is
   routed ahead of the severity routes, so it cannot reach `oncall-pager`:

```sh
curl -sS -XPOST http://alertmanager.monitoring.internal:9093/api/v2/alerts \
  -H 'Content-Type: application/json' \
  -d '[{
    "labels": {"alertname":"DeliveryTest","severity":"warning","test":"delivery-check","instance":"synthetic"},
    "annotations": {"summary":"Synthetic delivery test. No action required."},
    "startsAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "endsAt":   "'"$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)"'"
  }]'
```

   Expected: HTTP 200, the alert visible under `GET /api/v2/alerts`, and a notification at the `delivery-test`
   receiver after `group_wait` (30 s). Nothing at `oncall-pager`/`ops-default`.
3. Silence check (optional): `amtool silence add test=delivery-check --duration=15m --comment="delivery test"
   --alertmanager.url=...` and confirm the next post is suppressed, then expire it.
4. Pager wiring, once, with the on-call person's consent and during working hours: post the same body with
   `"severity":"critical"` and WITHOUT the `test` label but with `alertname` `DeliveryTestPager`, and an annotation
   saying it is a test; agree the time with the person who will be paged. Do not do this unannounced.
5. Application-level end to end (staging only): in a staging environment set `RATE_LIMIT_FAIL_MODE=open`, stop its
   database briefly, send traffic, and confirm `RateLimitStoreFailOpen` reaches the warning receiver. Never
   do this in production.
6. Record the evidence (time, receiver, screenshot or message id) next to the staging checklist. Until then the
   status stays "alert delivery UNVERIFIED".

## 6. What this document does not provide

- No Prometheus/Alertmanager/Grafana deployment manifests, no real receivers, no secrets.
- No log-based alerting: security events and the `FAILED TO PERSIST` log line are only in logs and the database.
- No dashboards. Counters are per instance; build panels with `sum by (instance) (rate(...))`.
