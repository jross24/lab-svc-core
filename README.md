# lab-svc-core

This repository holds the mock "core" service of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The service is also the pattern for the other three services. It shows a gradual Production release with an automatic rollback,
and it shows logs, metrics, traces, a dashboard and alarms as code. A sibling service can copy the files that the section "Layout" marks.

## What the service is

The service is one Lambda function behind an API Gateway HTTP API. The function reads its items from a DynamoDB table (see "Data").
The API has one route, `GET /items`. The function returns JSON:

```json
{
  "service": "core",
  "version": "0.1.0",
  "items": [{ "id": "item-1", "name": "First item", "title": "First item" }]
}
```

Each item has both `name` and `title`, with the same value. `title` is the new name of the attribute `name`. A later release removes `name`.

The `version` field shows which release runs. The stack sets it as an environment variable of the function.

### Why the API is private

The route uses IAM authorisation. The API has a public address, but API Gateway checks each request before the function runs.
A caller must sign the request with AWS credentials (Signature Version 4).
The IAM identity of the caller must also have the permission `execute-api:Invoke` for this route.
API Gateway answers a request with no signature with `403 Forbidden`.

### How a consumer finds the service

The stack writes three SSM parameters in its account. The migration step writes a fourth one (see "The rollback floor").

| Parameter | Value |
| --- | --- |
| `/lab/core/url` | The base URL of the API. Add `/items` to call the route. |
| `/lab/core/api-arn` | The resource ARN for the IAM policy of the consumer. It allows `execute-api:Invoke` on `GET /items`. |
| `/lab/core/version` | The version of core that the stack runs. The release workflow of lab-workflows reads it, to check the deployment order and the set of tested versions. |
| `/lab/core/min-rollback-version` | The oldest version of core that can run against the data now. The migration step writes it, not CloudFormation. The workflow `redeploy.yml` reads it. |

The gradual release changes neither of the first two values. The API and the route keep their IDs.
The API now calls the alias `live` of the function, and not the function itself. A consumer needs no change.

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-svc-core`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `release` | all at once | all at once | canary: 10 percent, then 100 percent after 5 minutes |
| `injectFault` | false | false | false |
| `retainData` | true | true | true |

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

## Data

The service keeps its items in one DynamoDB table. This section explains the table, how its data changes with a release, and how to go back.

The rule that the lab proves here: **a rollback restores code, not data.**
So a change to the shape of the data takes two releases. The pipeline blocks a change that destroys a data store, unless a person says yes.
And the rollback path refuses a version that cannot read the data that is there now.

### The table

| Setting | Value | Why |
| --- | --- | --- |
| Key | `id` (string) | The service looks up items by id. |
| Billing | on demand | The lab has no steady load. It pays for requests, not for capacity. |
| Point in time recovery | on, in every stage | It is the only way back from a bad migration. See "Restore". |
| Encryption | the default | DynamoDB encrypts every table with a key that AWS owns. The lab needs no key of its own. |
| Table name | none | CloudFormation makes the name. A fixed name would stop a restore from making a new table next to it. |
| Deletion protection | on in Test, Staging and Production | DynamoDB refuses `DeleteTable` while it is on. |
| Removal policy | `RETAIN` in Test, Staging and Production. `DESTROY` in `Dev`. | See below. |

The stage config has the setting `retainData`. It is `true` in the three pipeline stages and `false` in `Dev`.
`Dev` is a copy on a laptop or a preview of a pull request. It holds no data that matters, and a preview must not leave a table that nobody removes.
That is the only reason for `DESTROY`. In the pipeline stages a deleted stack leaves the table, and a replaced table leaves the old table.

The stateful guard of the pull request workflow protects the table from a change of code. It fails a pull request that deletes or replaces the table,
for example a change of the key or a new logical ID, unless the pull request has the label `destructive-change-approved`.
The guard stays silent for a pull request that only adds a table.

The function that serves `GET /items` can read the table and cannot write it. The migration function can read and write it.

### Migrations

A migration is a numbered script in `lib/migrations`, for example `0001-seed-items.ts`. It changes the data. The list `lib/migrations/list.ts` holds all of them in order.
A migration has these rules:

- **Forward only.** A migration has no "down" step. A rollback of code does not undo data (see below), so a down step would give a wrong sense of safety.
- **Safe to repeat.** A migration can stop in the middle. The next run starts it again. So each step must give the same result when it runs twice.
  The scripts use conditional writes: "create the item only if it does not exist", "set the attribute only if it does not exist".
- **Never edit one that has run.** An environment may hold its record already. Add a new migration.

The **ledger** is the record of what ran. It lives in the same table as the items. A ledger record has the id `#migration#<id>`, and the status `started` or `done`.
It also holds the phase, the version of the release that ran it, and the times.
Because the ledger is in the table, a restore of the table restores the ledger too. The two always agree.
"Exactly once" means this: a migration that is `done` does not run again, and a migration that is not `done` runs again until it is. The scripts are safe to repeat, so a repeat does no harm.

#### The order of the steps in one deployment

The migrations have two phases. The phase says where the migration runs in the deployment.

1. **Expand** migrations are additive. They run **before** the new code takes traffic. Old code can still read the data afterwards.
2. The alias moves to the new code. In Production this is a canary: 10 percent of the traffic for 5 minutes, then all of it. CloudFormation waits for the whole CodeDeploy deployment.
3. **Contract** migrations are destructive. They run **after** the canary has finished. Old code can not read the data afterwards.
4. The SSM parameter `/lab/core/version` changes. The release is complete.

In three plain sentences: Additive steps run before the new code takes traffic. Destructive steps run only after the canary has finished. A destructive step also writes the rollback floor before it changes any data.

The CDK code makes this order with plain dependencies in `lib/core-stack.ts`. The alias depends on the expand step, and the contract step depends on the alias.
A unit test reads the template and checks both lines.

If an alarm stops the canary, CodeDeploy rolls the alias back and the stack update fails. Then the contract step never runs, and the data is not destroyed.

#### How it runs: a custom resource in the stack

The migration step is a part of the stack. A Lambda function runs the scripts. Two custom resources of CloudFormation call it, one for each phase.
CloudFormation runs a custom resource at the place that its dependencies give. That is how the order above works.
The CDK framework `Provider` sits between CloudFormation and the function. It sends the answer back to CloudFormation, also when the function fails or times out.

A function that throws fails the resource. That fails the stack update, and CloudFormation rolls the stack back. So a failed migration fails the release in the environment where it ran, usually Test.
The message of the error names the migration.

Why this and not a pipeline step? The lab compared two ways.

| | A custom resource in the stack (chosen) | A pipeline step that invokes a migration function |
| --- | --- | --- |
| Same artefact in every environment | Yes. The migration code is in the cloud assembly, with the service code. | The function must come from the same assembly, so it is the same. |
| New permission for the pipeline | None. CloudFormation invokes the function. | The role `github-deploy` needs `lambda:InvokeFunction`. |
| Place in the deployment | Exact. Dependencies put it before or after the alias. | The step runs before or after the whole `cdk deploy`. It cannot run after the canary and before the version parameter. |
| Failure | The stack update fails and rolls back. | The job fails. The stack is already updated. |
| Weak point | A custom resource that does not answer hangs the stack for an hour. The `Provider` framework removes this risk. | One more step in the workflow that every service repository shares. |

The custom resource keeps "build once, promote the same artefact" true, and it needs no new IAM for the pipeline. That decided it.
A migration over a big table does not fit in a Lambda function (15 minutes at most). Use a batch job for that, and keep this step for small changes.

### The rollback floor

The **rollback floor** is the oldest version of core that can still run against the data in an environment.
The SSM parameter `/lab/core/min-rollback-version` holds it in each environment. The pipeline reads it.
The workflow `redeploy.yml` refuses a version that is older than the floor, and it says why. See "The rollback floor" in the README of lab-workflows.

The file `pipeline.json` declares the floor: `minRollbackVersion`. An expand migration keeps the floor as it is, because old code still reads the data.
The release with a contract migration raises the floor to the version of the release that ran the matching expand migration.
Code from before that release can not read the data any more.

In three plain sentences: The floor lives with the data and not with the code. A redeploy puts back an old stack, so the old stack cannot be trusted to keep the floor. So the migration step writes the floor, and it never lowers it.

How it works:

- The step writes the floor in each environment at each deployment. It is the highest of two values: the value in `pipeline.json` of this release, and the floors that the ledger holds.
- A destructive migration writes its floor into its ledger record and into SSM **before** its first change of data. If the migration fails, the floor stays high.
- An older release that is deployed again (a rollback) declares an older floor. The ledger still holds the high floor. So the redeploy keeps the high floor.
- The runner refuses a destructive migration when the declared floor is older than the release that ran the matching expand migration. This catches a developer who forgets to raise the floor.
- The floor parameter is not a resource of CloudFormation. A rollback of the stack would put back the old value.

The canary has its own automatic rollback. If an alarm fires, CodeDeploy moves the alias back to the previous Lambda version. It does not use `redeploy.yml`, so the floor check does not see it.
This is safe because of two rules, and the order of the steps enforces both:

1. A release must read the data that the previous release wrote. During the canary the previous version still serves most of the traffic, and the new version serves the rest.
2. A destructive step runs only after the canary has finished. Then the previous version does not serve traffic any more. If the canary rolls back, the destructive step never ran.

### Restore

A rollback of code does not bring back data that a migration or a person changed. Two things can: fix forward with a new migration, or restore the table from point in time recovery.
The pipeline can not restore data. A person does it, and the lab proved the steps once in `lab-dev`.

1. **Find the time.** Each ledger record has `startedAt`. Restore to a time just before the start of the migration that did the harm. Without a migration, use the time of the incident.
   The earliest time is when point in time recovery was switched on. The latest time is about 5 minutes ago.
2. **Restore into a new table.** DynamoDB never restores into the table that exists. It makes a new table. Use a name that shows what it is.
   ```
   aws dynamodb restore-table-to-point-in-time \
     --source-table-name <live table> --target-table-name <live table>-restored \
     --restore-date-time <time> --profile <profile>
   ```
   The new table has the items and the ledger from that time. It does **not** have the settings of the old table: point in time recovery is off, deletion protection is off, and the tags are gone.
3. **Look at it.** Scan the new table and compare it with what you expect.
4. **Point the service at the data.** The stack owns the live table, and its name is in the environment of the function. The new table has another name. Two ways:
   - **Copy back (used in the proof).** Copy the rows of the new table into the live table: `node scripts/copy-table.ts <restored table> <live table>`.
     The stack, the table and the name stay as they are. A row that exists only in the live table stays. The ledger is copied too. It says which migrations had run at that time,
     so the next release runs again the migrations that came after, and that is right.
   - **Swap.** Change the code to use the new table, or import the new table into the stack and drop the old one. This is a change of the stack, and the stateful guard blocks it.
     The lab did not run this way. Do it only with a plan and the label `destructive-change-approved`.
5. **Clean up.** Delete the restored table. Switch point in time recovery on again for any table that you keep.

What a restore does not do: it does not change the code, and it does not change the rollback floor. The floor protects the code. If the restore goes back to before a destructive migration,
the floor is higher than needed. Lower it only by a release with a lower `minRollbackVersion` and a ledger without the destructive record. Most of the time, leave it.

#### The proof of the restore

The lab ran these steps in `lab-dev` on 2026-10-08, on a copy with the namespace `dm1` (4 rows: 3 items and 1 ledger record).

1. The table had been seeded by the migration at 14:00:59 UTC. The window of point in time recovery began at 14:00:08 and ended about 5 minutes before now.
2. At 14:03 the lab damaged the live table on purpose: it deleted `item-2` and changed the name of `item-3` to `CORRUPTED`. The function returned two items, one of them wrong.
3. The lab restored the table to 14:02:30 UTC into `lab-svc-core-dm1-restored`. The new table was `ACTIVE` after 3 minutes and 10 seconds.
   It had the 3 original items and the ledger record. Its point in time recovery was `DISABLED` and the table had no deletion protection, as the list above says.
4. `node scripts/copy-table.ts <restored table> <live table>` copied 4 rows. The live table then had `item-2` and the original `item-3`. The function returned the 3 original items with HTTP 200.
5. The lab deleted the restored table.

The restore needed no change of the stack. The window of point in time recovery starts when the feature is switched on and ends about 5 minutes before now.
So a restore to a time in the last 5 minutes fails, and a restore of a table that is a few minutes old has a very small window.

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
  - `LatencyAlarm`: it fires when the p99 duration is over 1000 ms in 2 periods of 1 minute in a row. The function does almost no work. See "The latency threshold" for the measurements. The function times out at 3 seconds.
- A service that answers a failure with a 5xx status, or with a degraded page, and does not throw can switch on a third alarm. Lambda counts a call as an error only when the function throws or times out,
  so the alarm `ErrorsAlarm` does not see such a call. The option `serviceErrors` of `GradualRelease` adds `ServiceErrorsAlarm`. It reads the metric `errors` that the service writes itself.
  It watches the version that the stack deploys, so during a canary it sees the errors of the new version and not of the old one. Core does not use it, because core throws when it fails.
  The siblings `lab-svc-catalogue`, `lab-svc-account` and `lab-web` use it.
  The lab ran this case in `lab-dev` with catalogue. `ErrorsAlarm` stayed `OK`, `ServiceErrorsAlarm` fired, and CodeDeploy rolled the release back after 101 seconds. See the README of lab-svc-catalogue.
- Both alarms treat missing data as "not breaching". A quiet service sends no data. It must not alarm, and it must not block a deployment.
- The API integration depends on the invoke permission of the alias. The first release switches a running API from the function to the alias. The order keeps the API up during that switch.

The code is in `lib/gradual-release.ts`.

### How a Production release goes, minute by minute

The times are measured. They come from the release 0.3.0 of core in Production, on 2026-10-07.
CodeDeploy ran the deployment `d-QWUJ3PCYJ` with the configuration `CodeDeployDefault.LambdaCanary10Percent5Minutes`.
The times are minutes and seconds after the reviewer approved. The canary step is exactly 5 minutes.
The other times depend on the runner and on CloudFormation, so another release can differ by some seconds.

| Time | What happens |
| --- | --- |
| before 0:00 | The release passed Test (with the end-to-end suite) and Staging. The job `deploy-production` waits for the reviewer. |
| 0:00 | The reviewer approves. |
| 0:02 | The job starts. |
| 0:33 | The job has installed the CDK, checked the zip against its SHA-256 and started `cdk deploy`. CloudFormation starts the stack update. |
| 0:52 | CloudFormation has updated the function and has published the new Lambda version. |
| 0:54 | CloudFormation starts the update of the alias `live`. CodeDeploy creates the deployment. The alias sends 10 percent of the calls to the new version and 90 percent to the old version. |
| 0:54 to 5:56 | The canary. CodeDeploy reads the two alarms. No alarm fires. The deployment is `InProgress` for 5 minutes and 2 seconds. |
| 5:56 | CodeDeploy sends 100 percent of the calls to the new version. The deployment is `Succeeded`. |
| 5:59 | CloudFormation sees the end of the deployment. The alias update is complete. |
| 6:01 to 6:03 | CloudFormation deletes the old Lambda version. The stack is `UPDATE_COMPLETE`. |
| 6:08 | The job prints the outputs and ends. |

The whole release took 6 minutes and 8 seconds after the approval. The first estimate in this README was about 8 minutes.
Most of the difference was in the last step: the estimate gave 2 minutes for the end, and the real end took 12 seconds.

What the lab saw during the canary:

- `aws lambda get-alias` showed version 1 with `RoutingConfig` `{"2": 0.1}`: 10 percent of the calls went to version 2. After the canary it showed version 2 and no routing.
- A signed loop called the private API every 2 seconds. The metric `requests` showed **both releases** for 5 minutes (calls in each minute, 0.2.0 / 0.3.0):
  22 / 4, 22 / 5, 33 / 4, 32 / 1 and 30 / 3. That is 17 of 156 calls (11 percent) for the new release. In the next minute the numbers were 3 / 28, and then 0 / 25.
- Old version 1 was gone after the release. CloudFormation deletes the old Lambda version in its clean-up step, so a hand rollback is a redeploy of the old release (see "Roll back by hand"), and not a move of the alias.
- After the release: the stack was `UPDATE_COMPLETE`, both alarms were `OK`, a signed call showed `0.3.0`, an unsigned call got `403`, and the Production web page answered 200 with core `0.3.0`.

Test and Staging use the same steps, but the alias moves to the new version at once.

### What makes a release roll back

- Either alarm is in the state `ALARM` while the deployment runs. CodeDeploy stops the deployment and moves 100 percent of the traffic back to the old version.
- The deployment fails for another reason. The deployment group also rolls back on a failed deployment.
- CodeDeploy cannot read the state of an alarm. The deployment stops.

CodeDeploy reports the failure to CloudFormation. The stack update fails and CloudFormation rolls the stack back.
Then `cdk deploy` ends with an error, and the job `deploy-production` fails.
The lab ran this case in its own account `lab-dev` (see "What the lab saw in lab-dev" below). It did not run it in Production: the owner runs that drill.

What does not roll a release back:

- A response with status 4xx. The alarms count function errors, and not client errors.
- An error after the deployment ended. CodeDeploy watches the alarms only while a deployment runs. After that the alarms only page.
- One slow call. The latency alarm needs two bad minutes in a row.

### The first release makes the alias

CodeDeploy needs an old version to move traffic from. When the alias does not exist, CloudFormation creates it and starts no deployment.
So **the first release that contains this change goes to each stage without a canary**. The second release is the first gradual release.
The drill below starts with a small second release for this reason.

The lab checked this in Production. Before the second release of core, `aws deploy list-deployments` showed no deployment, and the alias pointed to version 1.

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
- The field `traceId` is the trace of the request, in the form of X-Ray (`1-` and 8 hex digits, a dash, 24 hex digits).
  One request that passes web, a public API and core has the same `traceId` in the log line of each of them. See "Tracing".
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

**Choice: OpenTelemetry in all four services. The SDK is bundled into the function. The spans go straight to the OTLP endpoint of X-Ray.**

One request to the web page makes **one trace** with the spans of web, of catalogue or account, and of core.
Every service writes the same trace ID in its JSON log line. This is the goal of [lab-platform#25](https://github.com/jross24/lab-platform/issues/25).

#### The short version

1. Each service has a server span for each request. The call to the next service is a client span.
2. The caller puts the W3C header `traceparent` on the call. The next service reads it and continues the trace.
3. At the end of each request, the service signs one HTTPS call and sends all its spans to X-Ray (the OTLP endpoint). This needs CloudWatch Transaction Search in the account.
4. The cost: 512 MB of memory instead of 128 MB, about 35 to 40 ms for each request, and about 430 ms for the first request of a new environment.
   The cold page still became faster than before (2.6 s against 4.8 s), because the memory also gives more CPU.

#### How it works

- `lib/instrument.ts` wraps the handler. It starts the server span, runs the handler, writes the log line and the metric line, ends the span, and sends the spans.
- `lib/tracing.ts` holds the OpenTelemetry parts. It uses no global state of OpenTelemetry, so a unit test can make as many instances as it wants.
  The trace IDs come from the X-Ray ID generator, because X-Ray drops a trace whose ID does not start with the time.
- A service that calls another service sends the call through `tracing.fetch`. It makes the client span and adds the header `traceparent`.
  The services sign the request **first** and add `traceparent` **after** the signature. The signature lists only `host` and the `x-amz-*` headers.
  So the extra header does not break it. The lab checked this with a real call: API Gateway answered 200 to a signed request with `traceparent` and with `X-Amzn-Trace-Id` added after the signature.
- `lib/xray-exporter.ts` sends the spans to `https://xray.<region>.amazonaws.com/v1/traces`. The request is signed with Signature Version 4 for the service `xray` (`lib/sigv4.ts`).
  The OpenTelemetry exporter for JavaScript cannot sign a request. A unit test checks `sigv4.ts` against two vectors of the AWS test suite.
  A failed export never fails a request. The function writes one `WARN` line without the body of the answer.
- The log field `traceId` has the form of X-Ray. Take it from a log line to find the trace (see below).
- The function role needs one more permission: `xray:PutTraceSegments` on `*`. X-Ray actions do not support a resource. It is the only X-Ray action.
- Lambda active tracing is **off**. With both, each call would make two traces with different IDs.

#### Why Transaction Search, and why core turns it on

The endpoint accepts spans only when CloudWatch Transaction Search is on. The setting belongs to the whole account and the whole region.
Then X-Ray writes each span as a log event into the log group `aws/spans`, and indexes a part of the spans as traces that `aws xray batch-get-traces` finds.

`lib/transaction-search.ts` turns it on with two resources: a policy of CloudWatch Logs that lets X-Ray write into `aws/spans` of this account, and `AWS::XRay::TransactionSearchConfig` with 100 percent indexing.
Core owns the setting, because core deploys first and the platform stack has no pipeline. See [lab-platform#27](https://github.com/jross24/lab-platform/issues/27).
The first deployment waits until the setting is active. This took 6 minutes in the lab-dev account. So the job `deploy-test` has a limit of 15 minutes now.

#### What was measured

The lab compared three ways in its own account `lab-dev`, with a plain function as the base. The Lambda functions run Node.js 22 on x86. Each cell has 5 cold starts and 15 warm calls.
The times come from the `REPORT` lines of Lambda. "First request" is the duration of the first call after the init.

| Way | Zip of the function | Init (128 MB / 512 MB) | First request (128 MB / 512 MB) | Warm request, p50 (128 MB / 512 MB) | Memory used |
| --- | --- | --- | --- | --- | --- |
| Base: no tracing | 2 KB | 134 / 134 ms | 112 / 16 ms | 1.6 / 1.6 ms | 77 MB |
| **SDK in the function, ES module (chosen)** | 26 KB (111 KB of code) | 160 / 159 ms | 1918 / 448 ms | 164 / 37 ms | 102 to 112 MB |
| SDK in the function, CommonJS (the CDK default) | 107 KB (641 KB of code) | 208 / 206 ms | 1928 / 449 ms | 78 / 41 ms | 105 to 117 MB |
| SDK in the function, ES module, minified | 16 KB (47 KB of code) | 158 / 128 ms | 1943 / 433 ms | 98 / 39 ms | 104 to 111 MB |
| ADOT layer, CommonJS bundle (the CDK default) | layer 2.6 MB | the function does not start | | | |
| ADOT layer, ES module | layer 2.6 MB, function 2 KB | 830 / 857 ms | 309 / 95 ms | 20 / 2.6 ms (see below) | 121 to 141 MB |

What the table shows:

- **Memory is the lever.** At 128 MB the first request of the SDK variant takes 1.9 s, because the TLS connection to X-Ray needs CPU. At 256 MB it takes 0.9 s, at 512 MB 0.45 s, and at 1024 MB 0.24 s.
  The warm request follows: 164, 64, 37 and 34 ms. The services use 512 MB.
- **The ES module halves the bundle size and the init.** With the module entry of each package, esbuild removes most of the unused code (641 KB become 111 KB).
  Minifying brings no gain in the cold start, so the lab does not minify. The code stays readable in a stack trace.
- **The ADOT layer cannot instrument the default bundle.** The layer failed at init with `TypeError: Cannot redefine property: handler`.
  esbuild writes the exports of a CommonJS bundle as properties that cannot be changed, and the layer wants to wrap the handler. An ES module bundle works.
- **The layer adds about 700 ms to each cold start at every memory size.** It adds 2.6 MB of code and 45 to 65 MB of memory (the SDK way adds 25 to 35 MB). The init of the layer runs before the first request, so the first request itself is cheap (95 ms at 512 MB).
- **The layer is cheap on a warm request, if it records.** The warm request cost 2.6 ms, because the layer exports in the background. But with the default settings it recorded nothing:
  the layer reads the trace header of Lambda first. Without active tracing that header says "not sampled", and the layer drops the spans. The lab got spans only with active tracing, or with `OTEL_TRACES_SAMPLER=always_on`.
- **With its default settings, the layer prefers the trace of Lambda to the header of the caller.** The code of the layer (version 16) replaces the header `X-Amzn-Trace-Id` of the request with the header that Lambda made for the call. It then asks the propagators `baggage, tracecontext, xray` in this order.
  The last one that finds a valid trace wins, and that is the X-Ray header of Lambda. So an incoming `traceparent` loses, unless a team sets `OTEL_PROPAGATORS` to another order. The lab read this in the code of the layer and did not run a chain with the layer.
- **The layer does not trace `fetch` by default.** Its list of instrumentations is `aws-sdk,aws-lambda,http`. The `fetch` of Node.js 22 does not use the `http` module, so a caller must turn on the `undici` instrumentation.
- **The ARN of the layer holds the account ID of AWS** (an AWS-owned account, layer `AWSOpenTelemetryDistroJs`, version 16 in `eu-west-2`). The lab found no SSM parameter that gives it. The SDK way has no layer, so no account ID of another publisher is in this repository.

**The third way: native active tracing and a hand-made header.** This cannot link the services. The lab sent a signed call with `X-Amzn-Trace-Id` and `traceparent` to a function with active tracing:

- The header reached the function. API Gateway added a part of its own: `Self=1-...;Root=<the Root that the lab sent>;...`.
- But Lambda started its own trace for the function. The variable `_X_AMZN_TRACE_ID` had another `Root`. Lambda does not read the header of an HTTP request.
- So the segments that Lambda makes (`AWS::Lambda`, `AWS::Lambda::Function`) stay in a trace of their own. To link them, the function would have to send its own segments to the X-Ray daemon by hand. That is what the X-Ray SDK does. AWS put the X-Ray SDKs and the X-Ray daemon in maintenance mode on 2026-02-25. Their support ends on 2027-02-25 ([AWS documentation](https://docs.aws.amazon.com/xray/latest/devguide/xray-daemon-eos.html)).

The lab also saw one more thing. A header that is part of the signature breaks the call: `curl --aws-sigv4` signs every header that it sends. API Gateway then changes `X-Amzn-Trace-Id`, and the signature does not match (403).
That is why the services add the trace headers after the signing.

**The whole chain.** The lab deployed all four services to `lab-dev` and loaded the web page. A cold page means that all four functions started cold.

| Case | Memory | Cold page | Web, first call | Warm page, median of 5 |
| --- | --- | --- | --- | --- |
| Before: Lambda active tracing, no OpenTelemetry (2 samples) | 128 MB | 4.75 s and 4.82 s | 4.34 s | 314 and 339 ms |
| OpenTelemetry (1 sample; the page shows an error block) | 128 MB | 7.39 s | 6.93 s | 830 ms |
| OpenTelemetry (2 samples) | 256 MB | 4.14 s and 4.16 s | 3.65 s and 3.75 s | 374 and 391 ms |
| **OpenTelemetry (2 samples, the choice)** | **512 MB** | **2.67 s and 2.62 s** | **2.00 s and 2.20 s** | **237 and 262 ms** |
| OpenTelemetry (1 sample) | 1024 MB | 1.92 s | 1.47 s | 233 ms |
| For comparison: no OpenTelemetry, core, catalogue and account at 512 MB, web at 128 MB (2 samples) | mixed | 1.82 s and 1.38 s | 1.76 s and 1.24 s | 149 and 110 ms |

Every row is one deployment of the four services. The cold page is the first request after the deployment, so all four functions start cold.
Some samples were lost: a deployment of one service was stopped by its own latency alarm, because the earlier test calls were still slow. The table lists only samples where all four services had the memory of the row. The last row is the exception, and it shows that memory alone brings most of the gain.

At 512 MB, each function took this long for its first request (the init time comes first, and it was 120 to 190 ms for each function):

| Service | First request | Warm request, median |
| --- | --- | --- |
| web | 2.0 to 2.2 s | 223 ms |
| catalogue | 1.25 to 1.29 s | 124 ms |
| account | 1.20 to 1.27 s | 139 ms |
| core | 0.45 to 0.47 s | 43 to 52 ms |

What this shows:

- **At 128 MB, tracing would break the page.** The cold chain needs 7.4 s, and web waits only 5 s for each API (lab-platform#17).
- **At 256 MB, tracing costs what the memory saves.** The cold page takes as long as before the change (4.1 s against 4.8 s), which is already 83 percent of the limit.
- **At 512 MB, the page is faster than before the change** (2.6 s against 4.8 s cold, 0.25 s against 0.33 s warm). The tracing costs about 1 s of the cold page, and the memory gives back more than 3 s.
- **1024 MB gains 0.7 s more** and costs twice as much for each millisecond. The lab does not pay for that.

Memory is the right fix here, and not a work-around. Lambda gives CPU in proportion to memory, and the work at the start (loading code, a TLS connection) needs CPU.

#### The trade-off, in short

- The lab pays about 35 to 40 ms for each request, and 512 MB of memory for each function. At the public price of Lambda (USD 0.0000166667 for a GB-second on x86; check the price page) a page view costs about USD 1.56 instead of USD 4.83 per million page views in compute time,
  from the measured warm durations. The cost of the spans in CloudWatch Logs comes on top, and the lab did not measure it.
- The lab gets one trace for the whole request, a trace ID in each log line, and no layer from another account.
- The HTTP API gives no span of its own. In the trace, the time between the client span of the caller and the server span of the next service is the time of API Gateway and of the Lambda call.

#### What a team would revisit

- Where the spans leave the function (see [lab-platform#28](https://github.com/jross24/lab-platform/issues/28)). The export waits on the request path.
- Who owns Transaction Search and how many spans are sampled and indexed ([lab-platform#27](https://github.com/jross24/lab-platform/issues/27)).
- The public APIs accept a `traceparent` header from any caller. That is how a trace starts in the middle. A real team may ignore the header at the edge.
- The lab traces the calls of the code and not the SDK of AWS, because the services call no AWS API. A service that does would add the instrumentation for it.

#### How to see a trace

Take the `traceId` from a log line of any service. Then run:

```
aws xray batch-get-traces --trace-ids <traceId> --profile <profile>
```

The result has one document for each server span. The field `parent_id` of a document is the client span of the caller, and that span is in the `subsegments` of the caller.
In the console, open CloudWatch, then Application Signals, then Transaction Search, and search for the trace ID. Logs Insights on the log group `aws/spans` shows the raw spans.

### The latency threshold

`LatencyAlarm` fires when the p99 duration of the alias `live` is over **1000 ms** in 2 periods of 1 minute in a row.
The constant `LATENCY_P99_THRESHOLD_MS` in `lib/core-stack.ts` holds the value. The function times out at 3 seconds, and a third of that is 1000 ms.

The lab measured the duration of core in two ways:

| What | When | Result |
| --- | --- | --- |
| CloudWatch `Duration` in Production, all calls, before the tracing change (128 MB) | the 12 hours up to 2026-10-07 22:50 UTC | 267 calls: p50 1.4 ms, p95 30 ms, p99 107 ms, slowest 113 ms |
| The same in Test | the same hours | 284 calls: p50 1.6 ms, p95 52 ms, p99 111 ms, slowest 121 ms |
| The first request of a new environment, with tracing and 512 MB (lab-dev) | 2026-10-07 | 0.45 to 0.47 s |
| A warm request, with tracing and 512 MB (lab-dev) | the same day | 43 to 52 ms |

The first request of each new environment takes about 450 ms, because it opens the connection to X-Ray. A new version of the function has new environments.
So the first call of a canary takes about 450 ms. The value 500 ms would be too near to that, and the lab-dev account showed it: a deployment was stopped by this alarm after a series of cold tests.
The value 1000 ms is more than twice the first request. A hung call fires it, and a cold start does not. The alarm also needs two minutes in a row.

**After the table (2026-10-08).** The handler reads DynamoDB now, so the lab measured again, in `lab-dev`, with 512 MB and tracing.
The AWS SDK is part of the Lambda runtime and the bundle does not include it. The client is made when the module loads, so it counts as init and not as duration.

| What | Result |
| --- | --- |
| The first request of a new environment, 8 environments started at the same time | `Duration` 515 to 592 ms (the `Init Duration` of 439 to 490 ms is not in the metric) |
| A warm request | 59 to 132 ms (10 requests) |

The first request takes 65 to 140 ms longer than before the table. That is the connection to DynamoDB, on top of the connection to X-Ray. A warm request takes 59 to 132 ms, against 43 to 52 ms before.
The slowest cold request, 592 ms, is 59 percent of the threshold. So the value 1000 ms stays. The lab did not change it.

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
4. The alias sends 10 percent of the calls to the faulty version. About one call in ten fails. The loop prints `502` for them, because catalogue answers `502` when core fails. A direct call to the private API of core gets `500`.
5. Expect, in this order, within about one minute (the lab measured 63 seconds in `lab-dev`, see below):
   - `ErrorsAlarm` goes to `ALARM`. The dashboard shows the state, and "Errors of the alias live" shows the errors.
   - CodeDeploy stops the deployment and moves 100 percent of the traffic back to the old version. The deployment has the state `Stopped` with the error code `ALARM_ACTIVE`, and CodeDeploy starts a rollback deployment.
   - CloudFormation rolls the stack back. The stack ends in `UPDATE_ROLLBACK_COMPLETE`.
   - The job `deploy-production` **fails** at the step `cdk deploy`. The log names the stack and the failed update.
   - The loop prints `200` again. A signed call to `/items` shows the old version.
6. Clean up:
   - Do **not** use "Re-run failed jobs". It would deploy the same faulty zip again.
   - Revert the drill: a new pull request sets `injectFault: false` for `Production` and `DRILL_STAGES` to `[]`. Title: `fix: remove the drill fault`.
   - Merge it, wait at `deploy-production`, approve. This release is a good canary.
   - Check: the stack is `UPDATE_COMPLETE`, both alarms are `OK`, and a signed call shows the new version.

### What the lab saw in lab-dev

The lab ran this drill in its own account `lab-dev` with the code of this repository. It did not run it in Production: the owner does that.
The `Dev` stage got the canary configuration and `injectFault: true` for this test only. The test did not change `main`.
A signed loop called the API every 2 seconds. The times are UTC.

| Time | What happened |
| --- | --- |
| 22:46:42 | The stack update started the deployment `d-NH63AODYJ` with the configuration `CodeDeployDefault.LambdaCanary10Percent5Minutes`. The alias sent 10 percent of the calls to the faulty version. |
| 22:46:49 | The first call failed with `500`. |
| 22:47:25 | `ErrorsAlarm` was in the state `ALARM` (the first poll that saw it). |
| 22:47:42 | CodeDeploy stopped the deployment: state `Stopped`, error `ALARM_ACTIVE`. 60 seconds after the start. |
| 22:47:43 to 22:47:45 | CodeDeploy ran the rollback deployment `d-DRDROADYJ` with `CodeDeployDefault.LambdaAllAtOnce`. It was `Succeeded`. |
| 22:47:54 | The alias pointed to the old version, with no routing. |
| after | The stack was `UPDATE_ROLLBACK_COMPLETE`. `cdk deploy` failed with the message that the deployment failed because the alarm `ErrorsAlarm` was active. |

Of 168 calls, 3 failed (`500`), and the rest answered with the old version. The alarm had fired 43 seconds after the start, and the rollback was complete 63 seconds after the start.
The stop came 17 seconds after the first poll that saw the alarm. The lab did not test how often CodeDeploy reads an alarm.
The latency alarm and the pipeline job were not part of this test: lab-dev has no pipeline, so `deploy-production` was not run.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`. It also scans the dependencies and the commits for secrets, and it checks the workflow files. It posts the `cdk diff` against Production as one comment. A delete or a replacement of a stateful resource fails the check until someone adds the label `destructive-change-approved`. The [README of lab-workflows](https://github.com/jross24/lab-workflows#the-cdk-diff-comment) explains the comment.
2. Merge the pull request. The `release` workflow starts.
3. The workflow works out the next version from the commit titles and creates the tag, for example `v0.2.0`.
4. The workflow builds one time: one `cdk synth -c version=<version>`. It stores the zipped `cdk.out` in a GitHub release.
5. The workflow takes the lock of Test. It checks the deployment order, deploys that same zip to Test, and runs the end-to-end suite. The suite also checks that Test reports the version of the release. The workflow records the four versions that passed as `tested-with.json` on the GitHub release.
6. The workflow checks the order and the tested set again in Staging, deploys the zip there, and runs the smoke subset of the suite. CodeDeploy moves the traffic at once in Test and in Staging.
7. The workflow waits. A reviewer approves the `production` environment in GitHub. A newer release that reaches this point cancels an older release that still waits. After the approval the workflow checks again, deploys the same zip to Production, and runs the smoke subset. CodeDeploy moves 10 percent of the traffic, waits 5 minutes, and moves the rest.
   If the smoke subset fails, the job fails and a redeploy of the earlier version waits for the reviewer.

The file `pipeline.json` names this service and the services that it needs. Core needs none. The consumers (catalogue and account) need core, so the pipeline checks their order against the version of core in the environment.
A release of core is also compared with the tested set: Staging and Production must run at least the versions of the other services that the suite tested with this release, unless `pipeline.json` accepts older ones.

No deploy job builds again. The lab-workflows README explains how the pipeline proves this.
It also lists the time limit of each job. `deploy-production` has 40 minutes: 30 for the deployment and 10 for the checks and the smoke subset.

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

With no other context value, the `Dev` stage is the **baseline copy** of the account. It uses the same stack name and the same parameter names as the pipeline stages.
The consumer services of the account read `/lab/core/url` and `/lab/core/api-arn`, so they call the baseline copy.
An account holds one baseline copy, and it stays deployed. To run a second copy, use a namespace.
The `Dev` stage has the alias, the deployment group, the alarms and the dashboard too. It releases all at once.

The baseline copy also turns on CloudWatch Transaction Search in the account (see "Tracing"). That setting belongs to the whole account.
The first deployment waits about 6 minutes for it. `cdk destroy` of the baseline copy turns it off again.

### Namespaces

A namespace gives a copy of the `Dev` stage names of its own. So a second copy can live in the same account and not touch the baseline copy.
Use it for a copy on your laptop. The pipeline uses it for the preview of a pull request.

```
npx cdk deploy -c dev=true -c namespace=my-test -c version=0.0.0-my-test "Dev/*" --profile <your-dev-profile>
npx cdk destroy -c dev=true -c namespace=my-test "Dev/*" --profile <your-dev-profile>
```

The rules for the context value `namespace` are the same in all services:

- It is valid only together with `dev=true`. With `dev` off, the app stops with an error.
- It has 1 to 20 characters. The first character is a letter from `a` to `z`.
- The other characters are the letters `a` to `z`, the digits `0` to `9` and `-`. The last character is not `-`.
- The app stops with an error for any other value. The message shows the value and an example.
- The pipeline stages never read it.
- The namespace `pr-<number>` belongs to the pipeline. Do not use a name that starts with `pr-` on a laptop.

The names that the namespace changes:

| | No namespace (baseline copy) | Namespace `<ns>` | Example, namespace `pr-12` |
| --- | --- | --- | --- |
| Stack name | `lab-svc-core` | `lab-svc-core-<ns>` | `lab-svc-core-pr-12` |
| SSM parameter with the URL | `/lab/core/url` | `/lab/ns/<ns>/core/url` | `/lab/ns/pr-12/core/url` |
| SSM parameter with the API ARN | `/lab/core/api-arn` | `/lab/ns/<ns>/core/api-arn` | `/lab/ns/pr-12/core/api-arn` |
| SSM parameter with the version | `/lab/core/version` | `/lab/ns/<ns>/core/version` | `/lab/ns/pr-12/core/version` |
| Dashboard name | `lab-svc-core` | `lab-svc-core-<ns>` | `lab-svc-core-pr-12` |
| Tag on the stack and its resources | none | `lab-namespace=<ns>` | `lab-namespace=pr-12` |

Nothing else of the stack has a fixed name. CloudFormation builds the other names from the stack name, so they are unique too.
A unit test compares all Name-like properties of two namespaces. It fails when a new fixed name appears.

**Transaction Search.** A copy with a namespace does not create CloudWatch Transaction Search. The setting belongs to the whole account.
The policy has the fixed name `lab-xray-can-write-spans`. A second copy would collide with it.
`cdk destroy` of a preview would also switch tracing off for the whole account. Only the baseline copy owns the setting.

**The consumers.** A consumer service reads `/lab/core/url` and `/lab/core/api-arn` by default. So a consumer still calls the baseline copy.
A copy of core with a namespace is for a consumer that names it with a context value (`coreNamespace` in the consumer). The consumers do not have that value yet.

**The version.** Give each copy its own `version`. The default `0.0.0-dev` belongs to the baseline copy.
The pipeline uses a version such as `0.0.0-pr12.abc1234`.

The code is in `lib/namespace.ts`. It does not change the nine shared files.
The shared dashboard code always names the dashboard `lab-svc-core`. So the stack sets the new name on the `CfnDashboard` with `addPropertyOverride`.

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values and makes the stages. |
| `lib/stages.ts` | The typed settings of each stage: log retention, the release type and the fault switch. |
| `lib/core-stage.ts` | The CDK stage. |
| `lib/namespace.ts` | The context value `namespace`: the check of the value and the names of a copy. |
| `lib/core-stack.ts` | The stack: function, API, SSM parameters, outputs. |
| `lib/transaction-search.ts` | Core only. CloudWatch Transaction Search for the whole account: the policy for the log group `aws/spans` and the setting. |
| `lib/gradual-release.ts` | **Same file in all four repositories.** The alias, the deployment group, the alarms and the `Release` type. |
| `lib/service-dashboard.ts` | **Same file in all four repositories.** The dashboard of a stage. |
| `lib/instrument.ts`, `lib/logger.ts`, `lib/metrics.ts` | **Same file in all four repositories.** The wrapper of the handler, the log line and the metric line. |
| `lib/tracing.ts`, `lib/xray-exporter.ts`, `lib/sigv4.ts` | **Same file in all four repositories.** OpenTelemetry tracing, the export of spans to X-Ray, and the signature of that request. |
| `lib/function-defaults.ts` | **Same file in all four repositories.** The memory size and the bundling settings of the function. |
| `lib/items-handler.ts` | The Lambda handler and the fault switch. It reads the items from the table. |
| `lib/items-table.ts` | The DynamoDB table and its settings. |
| `lib/migrations/` | The migration runner (`runner.ts`), its types, the version helper, the migration scripts (`0001-seed-items.ts`) and the list (`list.ts`). |
| `lib/migrations-resource.ts` | The migration function and the two custom resources, `Expand` and `Contract`. |
| `lib/migrate-handler.ts` | The Lambda function that runs the migrations for CloudFormation. |
| `lib/dynamo-store.ts` | The DynamoDB and SSM code behind the runner: the items, the ledger and the floor parameter. |
| `lib/pipeline-file.ts` | Reads `minRollbackVersion` from `pipeline.json` at synth time. |
| `scripts/copy-table.ts` | A tool for a person: copies the rows of a restored table into the live table. |
| `contract.json` | What the service promises in its answers. See "Contract tests" in the README of lab-workflows. |
| `pipeline.json` | The name of the service, the providers it needs, and `minRollbackVersion`. |
| `test/` | The unit tests (vitest). `test/support/` holds the in-memory store and the helper for the contract. |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |
