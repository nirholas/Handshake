# three.ws AWS Infrastructure

CDK stack for the three.ws AWS resources. Deploys to account `155407237916`, region `us-east-1`.

All resources are tagged with the `awsApplication` key pointing to the three.ws MyApplications ARN, so they surface in the [AWS console dashboard](https://us-east-1.console.aws.amazon.com/systems-manager/appmanager/application/AWS_AppRegistry_Application-three.ws).

## Resources

| Resource | ID | Purpose |
|---|---|---|
| S3 Bucket | `3d-agent-avatars` | 3D avatar uploads (used by `api/_lib/r2.js`) |
| CloudWatch Log Group | `/three-ws/api` | API observability |
| AppRegistry Association | — | Links this stack to the MyApplications entry |

## First-time setup

```bash
cd infra
npm install
npx cdk bootstrap aws://155407237916/us-east-1   # once per account/region
```

## Deploy

```bash
cd infra
npm run deploy
```

## If the S3 bucket already exists

If `3d-agent-avatars` was created outside CDK, import it instead of re-creating:

```bash
cd infra
npx cdk import ThreeWsStack
```

CDK will prompt you to confirm the bucket name, then take it under management.

## Diff

```bash
cd infra
npm run diff
```
