# lab-svc-core

This repository holds the mock "core" service of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

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

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-svc-core`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `gradualRelease` | false | false | true |

`gradualRelease` is a placeholder. No code uses it yet.

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

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`.
2. Merge the pull request. The `release` workflow starts.
3. The workflow works out the next version from the commit titles and creates the tag, for example `v0.2.0`.
4. The workflow builds one time: one `cdk synth -c version=<version>`. It stores the zipped `cdk.out` in a GitHub release.
5. The workflow deploys that same zip to Test, then to Staging.
6. The workflow waits. A reviewer approves the `production` environment in GitHub. Then the workflow deploys the same zip to Production.

No deploy job builds again. The lab-workflows README explains how the pipeline proves this.

### Commit titles choose the version

Each pull request is squashed, so the title of the pull request becomes the commit title.

| Title | Next version |
| --- | --- |
| `feat: ...` | minor, `0.1.0` to `0.2.0` |
| `feat!: ...`, or `BREAKING CHANGE` in the message | major, `0.2.0` to `1.0.0` |
| any other title, for example `fix: ...` | patch, `0.2.0` to `0.2.1` |

### Roll back

Run the `redeploy` workflow from the Actions tab. Give it an old version and an environment.
It downloads the `cdk.out` zip of that GitHub release and deploys it. It does not build.

```
gh workflow run redeploy.yml -f version=0.1.0 -f environment=test
```

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

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values and makes the stages. |
| `lib/stages.ts` | The typed settings of each stage. |
| `lib/core-stage.ts` | The CDK stage. |
| `lib/core-stack.ts` | The stack: function, API, SSM parameters, outputs. |
| `lib/items-handler.ts` | The Lambda handler. |
| `test/` | The unit tests (vitest). |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |
