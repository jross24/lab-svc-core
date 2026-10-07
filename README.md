# lab-svc-core

This repository holds the mock "core" service of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The service is also the pattern for the other three services. It shows a gradual Production release with an automatic rollback,
and it shows logs, metrics, traces, a dashboard and alarms as code. A sibling service can copy the files that the section "Layout" marks.

## What the service is

The service is one Lambda function behind an API Gateway HTTP API.
The API has one route, `GET /items`. The function returns JSON:

```json
{
  "service": "core",
  "version": "0.1.0",
  "items": [{ "id": "item-1", "name": "First item" }]
}
```

The `version` field shows which release runs. The stack sets it as an environment variable of the function.

### Why the API is private

The route uses IAM authorisation. The API has a public address, but API Gateway checks each request before the function runs.
A caller must sign the request with AWS credentials (Signature Version 4).
The IAM identity of the caller must also have the permission `execute-api:Invoke` for this route.
API Gateway answers a request with no signature with `403 Forbidden`.

### How a consumer finds the service

The stack writes two SSM parameters in its account.

| Parameter | Value |
| --- | --- |
| `/lab/core/url` | The base URL of the API. Add `/items` to call the route. |
| `/lab/core/api-arn` | The resource ARN for the IAM policy of the consumer. It allows `execute-api:Invoke` on `GET /items`. |

The gradual release changes neither value. The API and the route keep their IDs.
The API now calls the alias `live` of the function, and not the function itself. A consumer needs no change.

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-svc-core`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `release` | all at once | all at once | canary: 10 percent, then 100 percent after 5 minutes |
| `injectFault` | false | false | false |

Every stage has the same resources: the same alias, the same CodeDeploy deployment group, the same alarms and the same dashboard.
Only the values in the table differ. So Test runs what Production runs. A unit test checks this: it compares the three templates.

`injectFault` is a device for the release drill. See "The Production drill". No stage sets it in `main`.

The code names no AWS account and no region. A stack goes to the account of the credentials that deploy it.
The pipeline gives each deploy job the credentials of one account. So `Test/*` goes to the Test account, and so on.
There is one account for each environment, so the stack name and the parameter names are the same in each one.

All three stages use the same bundled Lambda code. You can see this after a synth:

```
npx cdk synth --quiet
npx cdk ls --app cdk.out
grep -ho '"S3Key": "[a-f0-9]*.zip"' cdk.out/assembly-*/*.template.json
```

The second command lists `Test/Core`, `Staging/Core` and `Production/Core`. The third command prints the same asset hash three times.

## Gradual release

### What the stack makes

- A Lambda **version** for each release. The `VERSION` environment variable changes in each release, so the function changes, and CDK publishes a new version.
  A unit test proves this: two releases give two different version resources.
- An **alias** `live`. The API calls the alias. The alias points to one version, or to two versions with weights during a canary.
- A **CodeDeploy deployment group** for the alias. When the alias gets a new version, CloudFormation starts a CodeDeploy deployment and waits for it.
  The `release` setting of the stage chooses the deployment configuration:
  `CodeDeployDefault.LambdaAllAtOnce` in Test and Staging, `CodeDeployDefault.LambdaCanary10Percent5Minutes` in Production.
- **Two alarms** on the alias. The deployment group watches both.
  - `ErrorsAlarm`: it fires on one error or more in a period of 1 minute.
  - `LatencyAlarm`: it fires when the p99 duration is over 500 ms in 2 periods of 1 minute in a row. The function does almost no work, so a normal call should take a few milliseconds. The lab has not measured this in Lambda yet. The function times out at 3 seconds.
- A service that answers a failure with a 5xx status, or with a degraded page, and does not throw can switch on a third alarm. Lambda counts a call as an error only when the function throws or times out,
  so the alarm `ErrorsAlarm` does not see such a call. The option `serviceErrors` of `GradualRelease` adds `ServiceErrorsAlarm`. It reads the metric `errors` that the service writes itself.
  It watches the version that the stack deploys, so during a canary it sees the errors of the new version and not of the old one. Core does not use it, because core throws when it fails.
  The siblings `lab-svc-catalogue`, `lab-svc-account` and `lab-web` use it.
- Both alarms treat missing data as "not breaching". A quiet service sends no data. It must not alarm, and it must not block a deployment.
- The API integration depends on the invoke permission of the alias. The first release switches a running API from the function to the alias. The order keeps the API up during that switch.

The code is in `lib/gradual-release.ts`.

### How a Production release goes, minute by minute

The times are estimates. The canary step is exactly 5 minutes. The other times depend on the runner and on CloudFormation.

| Time | What happens |
| --- | --- |
| before 0:00 | The release passed Test (with the end-to-end suite) and Staging. The job `deploy-production` waits for the reviewer. |
| 0:00 | The reviewer approves. The job starts. |
| 0:00 to 1:00 | The job installs the CDK, checks the zip against its SHA-256 and starts `cdk deploy`. |
| about 1:00 | CloudFormation publishes the new Lambda version and moves the alias `live` to it. CodeDeploy starts a deployment. |
| 1:00 to 6:00 | The alias sends 10 percent of the calls to the new version and 90 percent to the old version. CodeDeploy reads the two alarms during this time. |
| about 6:00 | No alarm fired. CodeDeploy sends 100 percent of the calls to the new version. |
| 6:00 to 8:00 | The deployment succeeds. CloudFormation removes the old version and finishes the stack update. The job prints the outputs and ends. |

Test and Staging use the same steps, but the alias moves to the new version at once.

### What makes a release roll back

- Either alarm is in the state `ALARM` while the deployment runs. CodeDeploy stops the deployment and moves 100 percent of the traffic back to the old version.
- The deployment fails for another reason. The deployment group also rolls back on a failed deployment.
- CodeDeploy cannot read the state of an alarm. The deployment stops.

CodeDeploy reports the failure to CloudFormation. The stack update fails and CloudFormation rolls the stack back.
Then `cdk deploy` ends with an error, and the job `deploy-production` fails. The lab has not yet run this case. The drill below proves it.

What does not roll a release back:

- A response with status 4xx. The alarms count function errors, and not client errors.
- An error after the deployment ended. CodeDeploy watches the alarms only while a deployment runs. After that the alarms only page.
- One slow call. The latency alarm needs two bad minutes in a row.

### The first release makes the alias

CodeDeploy needs an old version to move traffic from. When the alias does not exist, CloudFormation creates it and starts no deployment.
So **the first release that contains this change goes to each stage without a canary**. The second release is the first gradual release.
The drill below starts with a small second release for this reason.

### How to watch a release

- **Dashboard.** Open CloudWatch in the console (region `eu-west-2`), then Dashboards, then `lab-svc-core`.
  The graph "Requests by version" shows how many requests each release got in each minute.
  During a canary you see two lines: about 90 percent for the old version and about 10 percent for the new version. After 5 minutes you see one line.
- **CodeDeploy.** Open CodeDeploy in the console, then Deployments. The page of the deployment shows the traffic weights and the state of the alarms.
- **Command line.** Use a read-only profile.

```
FN=$(aws cloudformation list-stack-resources --stack-name lab-svc-core --profile <profile> \
  --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)

# The version of the alias. During a canary, RoutingConfig shows the weight of the new version.
aws lambda get-alias --function-name "$FN" --name live --profile <profile> \
  --query '{version:FunctionVersion,routing:RoutingConfig}'

# The latest deployments, then one deployment.
aws deploy list-deployments --profile <profile> --max-items 3
aws deploy get-deployment --deployment-id <id> --profile <profile> \
  --query 'deploymentInfo.{status:status,config:deploymentConfigName,error:errorInformation.code}'
```

A signed call to the API, as a consumer makes it:

```
eval "$(aws configure export-credentials --profile <profile> --format env)"
URL=$(aws ssm get-parameter --name /lab/core/url --profile <profile> --query Parameter.Value --output text)
curl --silent --aws-sigv4 "aws:amz:eu-west-2:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -H "x-amz-security-token: $AWS_SESSION_TOKEN" "$URL/items"
```

### One set of alarms for the release and for the on-call

The two alarms watch the alias `live`. The alias is the live traffic. So the alarms serve two jobs with no extra code:

1. **The release gate.** CodeDeploy reads them during a deployment and rolls back.
2. **The page.** Outside a deployment they watch the same traffic.

The lab has no notification target. To page an on-call, make an SNS topic in `lib/core-stack.ts` and add it to both alarms.
The place is marked with a comment, and the code is two lines:

```ts
release.errorsAlarm.addAlarmAction(new SnsAction(topic));
release.latencyAlarm.addAlarmAction(new SnsAction(topic));
```

The topic can send to email, to a chat tool or to an on-call tool (for example through AWS Chatbot or a webhook).

### Roll back by hand

Run the `redeploy` workflow with the **last good version** and the environment. A redeploy to Production is also a canary: the alias gets a different version, so CodeDeploy runs.

Do not redeploy `0.1.0`. That release has no alias. A redeploy of it would remove the alias, the deployment group, the alarms and the dashboard.

## Observability

### Logs

The function writes **one line of JSON for each request**:

```json
{"timestamp":"2026-10-07T20:54:32.083Z","level":"INFO","service":"core","version":"0.2.0","requestId":"local-1","route":"GET /items","status":200,"durationMs":0.113,"traceId":"1-67000000-aaaaaaaaaaaaaaaaaaaaaaaa"}
```

- The level is `INFO` for status below 400, `WARN` for 4xx and `ERROR` for 5xx and for a thrown error. A thrown error adds the field `error`.
- The line holds no body, no header and no query string.
- The field `traceId` is the X-Ray trace of the call. It links a log line to its trace.
- The field `coldStart` is `true` on the first request of an execution environment, and it is absent on all other lines.
  The init time of the function falls on that request, so a slow line with `coldStart` is a cold start and not a slow code path.
- The field `degraded` holds a short reason when a handler answered with a good status but handled a failure (a page with an error block). Core never sets it. The sibling `lab-web` does.
  A degraded call is a warning in the log and an error in the metric. See `Signals` in `lib/instrument.ts`.
- The module is `lib/logger.ts`. It is a short module, and the service has no logging library.
- The function writes to stdout directly, and not with `console.log`. In the default text log format, the Lambda runtime adds a time stamp, a request ID and a level before the `console.log` text (the AWS documentation says so). Then the line no longer starts with `{`.
  A direct write is the method that the AWS documentation shows for the embedded metric format. The lab ran this path only on a laptop, with the real bundle. The first release shows if it works in Lambda (see "Metrics and the deployment marker").
- The stage config sets the retention of the log group (`logRetentionDays`).

An example query in CloudWatch Logs Insights:

```
fields @timestamp, level, version, route, status, durationMs, traceId
| filter ispresent(status)
| sort @timestamp desc
| limit 20
```

### Metrics and the deployment marker

The function writes a second line for each request. It uses the CloudWatch **embedded metric format** (EMF).
CloudWatch reads the line from the log stream and makes three metrics in the namespace `Lab/Service`:
`requests`, `errors` and `duration`. The dimensions are `service` and `version`.

This needs **no new IAM permission**. The function does not call `PutMetricData`. The pipeline needs no new permission either.

The dimension `version` is the release. So the graph "Requests by version" is a **deployment marker**.
It shows the minute when a release first got traffic, the 10 percent step of a canary, and the minute when the old version got its last request.
The module is `lib/metrics.ts`.

To check that CloudWatch reads the lines after a release, list the metrics. The list is empty until the first request:

```
aws cloudwatch list-metrics --namespace Lab/Service --profile <profile> --region eu-west-2
```

The alarms use the native metrics of Lambda (`Errors` and `Duration`) with the dimension `Resource = <function>:live`.
Native metrics count a failed call even when the function code did not run, for example after a timeout or an out-of-memory error.

### Tracing

**Choice: Lambda active tracing (X-Ray). Not the AWS Distro for OpenTelemetry (ADOT) layer, not yet.**

What active tracing gives:

- Lambda sends a trace to X-Ray for a sampled call. The trace has two segments: `AWS::Lambda` and `AWS::Lambda::Function`.
- It needs one setting (`tracing: Tracing.ACTIVE`). The role of the function gets `xray:PutTraceSegments` and `xray:PutTelemetryRecords`.
- It adds no layer, no package and no code. AWS publishes no figure for its cost in cold start or memory.
- The log line carries the trace ID, so you can go from a log line to its trace.

What it does **not** give, and the facts behind this:

- **No API Gateway segment.** HTTP APIs do not support X-Ray tracing. Only REST APIs do. This holds for ADOT too.
- **No trace across services.** Active tracing does not read a trace header from a request, and it does not pass one on.
  When catalogue calls core, core starts its own trace. One trace across web, the public API and core needs OpenTelemetry (or the X-Ray SDK) in every service.
  The X-Ray SDK is in maintenance mode since February 2026. AWS recommends OpenTelemetry.

Why not ADOT now:

- **Cold start.** The AWS documentation says that the layer needs more memory and adds cold start time. It gives no figure.
  User reports for the older layer, which embeds a collector, say 1 to 5 seconds (for example [aws-otel-lambda issue 228](https://github.com/aws-observability/aws-otel-lambda/issues/228), from 2022). The lab already uses 3.8 s of the 5 s limit in a cold chain (lab-platform#17).
  The lab did not measure the layer. A measurement needs a deployed function.
- **Memory.** The functions have 128 MB. AWS gives no minimum for the layer. The older layer runs a collector process next to the function, so the function would need more memory.
- **The layer ARN.** An ADOT layer belongs to an AWS-owned account, and its ARN holds that account ID. I found no SSM parameter that gives the ARN, so the ARN would sit in this public repository.
  That ID is not a lab account and it is not secret. But it breaks the unit test that forbids a 12-digit account ID in a template, and it pins code from another account into the function.
  The helper `AdotLayerVersion` in `aws-cdk-lib` embeds the ID of the older layer family, and its documentation calls that family legacy.
  AWS now recommends a newer layer family. This repository uses neither, so no AWS-owned account ID is in the repository.
- **Propagation over the signed fetch.** It can work. SigV4 checks only the signed headers (`host` and the `x-amz-*` headers). The layer adds `traceparent` after the signing, so the signature stays valid.
  The instrumentation of `fetch` is in the layer but is off by default. Each caller must turn it on. The AWS documentation does not confirm that API Gateway accepts the extra header, so the lab must test it.
- **Not verified.** Whether the layer instruments an esbuild bundle in ESM, and whether it works at 128 MB, are not documented. The lab could not test them before a release.

The trade-off: the lab gets traces of the Lambda calls now, with no risk to the cold start. It does not get one trace across services.
The gap has an issue: [lab-platform#25](https://github.com/jross24/lab-platform/issues/25). It lists what to test before a move to OpenTelemetry in all four services.

How to see a trace: take the `traceId` from a log line. Open CloudWatch, then X-Ray traces, and search for the ID. Or use the command line:

```
aws xray batch-get-traces --trace-ids <traceId> --profile <profile> \
  --query 'Traces[].Segments[].Document' --output text
```

The AWS documentation gives the sampling rule of Lambda: the first request of each second, and 5 percent of the others. A single test call falls under the first part.

### Dashboard

Each stage has one dashboard named `lab-svc-core`. `lib/service-dashboard.ts` defines it. It shows:

- Requests by version (from the embedded metrics).
- Errors of the alias `live`, with the line of the alarm.
- The p50 and the p99 duration of the alias `live`, with the line of the alarm.
- The 4xx and 5xx counts of API Gateway.
- The state of both alarms.

## The Production drill

The drill proves the gradual release in Production. The owner runs it. The pipeline needs two releases for it, because the first release only creates the alias.
Do the drill after the first release reached Production.

Prepare a signed traffic loop. The canary gets 10 percent of the calls, so a quiet service shows nothing. Run this in a second terminal during each drill:

```
CAT=$(aws ssm get-parameter --name /lab/catalogue/url --profile lab-prod --query Parameter.Value --output text)
for i in $(seq 1 180); do curl --silent --output /dev/null --write-out "%{http_code} " "$CAT/products"; sleep 2; done
```

The loop calls the public API of catalogue. Catalogue calls core with a signed request. So the traffic goes through the alias `live`.
It runs for 6 minutes. Start it just after you approve.

### (a) A good release: watch the canary

1. Check that the alias exists in Production: `aws lambda get-alias` (see "How to watch a release"). If it does not, approve the first release and come back.
2. Merge a small pull request, for example `fix: ...`. Any change starts a release. The release passes Test and Staging, and then waits at `deploy-production`.
3. Open the dashboard `lab-svc-core` in the Production account, and the CodeDeploy page of the deployment group.
4. Approve the `production` environment on the page of the run. Start the traffic loop.
5. Watch for 5 minutes. Expect:
   - The CodeDeploy deployment is `InProgress` with the configuration `CodeDeployDefault.LambdaCanary10Percent5Minutes`.
   - `aws lambda get-alias` shows `RoutingConfig` with a weight of about 0.1 for the new version.
   - "Requests by version" shows about 90 percent for the old release and about 10 percent for the new release.
6. After 5 minutes, the alias points to the new version and `RoutingConfig` is empty. The graph shows only the new release. The deployment is `Succeeded`. The job ends.

### (b) A bad release: the alarm rolls it back

The fault switch is a **drill device**. It is not a production practice. The Test suite would catch a bad version first, so the fault must appear only in Production.
The stage config does this: `injectFault` is false in Test and Staging, and the drill sets it to true for Production only.
With the switch on, the handler throws on each call.

1. Make a branch with these two changes in one pull request:
   - In `lib/stages.ts`, set `injectFault: true` in the `Production` block.
   - In `test/app.test.ts`, change `DRILL_STAGES` to `['Production']`. The guard test fails by design if you change only one of the two.

   The two edits are the whole change. A dry run with exactly these edits passed lint, typecheck, all the tests and `cdk synth`, and `INJECT_FAULT` appeared only in the Production template.

   Give it the title `fix: drill, inject a fault in production`.
2. Merge it. The release passes Test (the suite finds no fault there) and Staging, and then waits at `deploy-production`.
3. Open the dashboard. Approve. Start the traffic loop.
4. The alias sends 10 percent of the calls to the faulty version. About one call in ten fails. The loop prints `502` for them, because catalogue answers `502` when core fails.
5. Expect, in this order, within a few minutes (the alarm period is 1 minute, and CloudWatch gets the Lambda metrics after a delay; the lab has not measured the time):
   - `ErrorsAlarm` goes to `ALARM`. The dashboard shows the state, and "Errors of the alias live" shows the errors.
   - CodeDeploy stops the deployment and moves 100 percent of the traffic back to the old version. The deployment has the state `Stopped` and CodeDeploy starts a rollback deployment.
   - CloudFormation rolls the stack back. The stack ends in `UPDATE_ROLLBACK_COMPLETE`.
   - The job `deploy-production` **fails** at the step `cdk deploy`. The log names the stack and the failed update.
   - The loop prints `200` again. A signed call to `/items` shows the old version.
6. Clean up:
   - Do **not** use "Re-run failed jobs". It would deploy the same faulty zip again.
   - Revert the drill: a new pull request sets `injectFault: false` for `Production` and `DRILL_STAGES` to `[]`. Title: `fix: remove the drill fault`.
   - Merge it, wait at `deploy-production`, approve. This release is a good canary.
   - Check: the stack is `UPDATE_COMPLETE`, both alarms are `OK`, and a signed call shows the new version.

The lab has not run this drill. Every statement in step 5 follows from the AWS documentation and not from a run. The drill is the test.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`.
2. Merge the pull request. The `release` workflow starts.
3. The workflow works out the next version from the commit titles and creates the tag, for example `v0.2.0`.
4. The workflow builds one time: one `cdk synth -c version=<version>`. It stores the zipped `cdk.out` in a GitHub release.
5. The workflow deploys that same zip to Test, then to Staging. In both, CodeDeploy moves the traffic at once.
6. The workflow waits. A reviewer approves the `production` environment in GitHub. Then the workflow deploys the same zip to Production. CodeDeploy moves 10 percent of the traffic, waits 5 minutes, and moves the rest.

No deploy job builds again. The lab-workflows README explains how the pipeline proves this.
It also lists the time limit of each job. `deploy-production` has 30 minutes.

### Commit titles choose the version

Each pull request is squashed, so the title of the pull request becomes the commit title.

| Title | Next version |
| --- | --- |
| `feat: ...` | minor, `0.1.0` to `0.2.0` |
| `feat!: ...`, or `BREAKING CHANGE` in the message | major, `0.2.0` to `1.0.0` |
| any other title, for example `fix: ...` | patch, `0.2.0` to `0.2.1` |

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.
esbuild bundles the Lambda code during `cdk synth`. You do not need Docker.

```
npm ci
npm run lint
npm run typecheck
npm test
npm run synth
```

Synthesis does not need AWS credentials.

## Deploy to a personal account

Do not deploy `Test`, `Staging` or `Production` from a laptop. Only the pipeline deploys them.

For your own experiments there is a fourth stage, `Dev`. The context value `dev=true` selects it.
With `dev=true` the app makes only the `Dev` stage, so the command cannot touch a pipeline stage by accident.

```
npx cdk deploy -c dev=true "Dev/*" --profile <your-dev-profile>
npx cdk destroy -c dev=true "Dev/*" --profile <your-dev-profile>
```

The profile selects the account. The account must be bootstrapped (`npx cdk bootstrap --profile <your-dev-profile>`).
The version is `0.0.0-dev` unless you add `-c version=<version>`.

The `Dev` stage uses the same stack name and the same parameter names as the other stages.
So one account can hold only one copy of the service. Use a personal account, not a pipeline account.
The `Dev` stage has the alias, the deployment group, the alarms and the dashboard too. It releases all at once.

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values and makes the stages. |
| `lib/stages.ts` | The typed settings of each stage: log retention, the release type and the fault switch. |
| `lib/core-stage.ts` | The CDK stage. |
| `lib/core-stack.ts` | The stack: function, API, SSM parameters, outputs. |
| `lib/gradual-release.ts` | **Copy to a sibling.** The alias, the deployment group, the two alarms and the `Release` type. |
| `lib/service-dashboard.ts` | **Copy to a sibling.** The dashboard of a stage. |
| `lib/instrument.ts`, `lib/logger.ts`, `lib/metrics.ts` | **Copy to a sibling.** The wrapper of the handler, the log line and the metric line. |
| `lib/items-handler.ts` | The Lambda handler and the fault switch. |
| `test/` | The unit tests (vitest). |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |
