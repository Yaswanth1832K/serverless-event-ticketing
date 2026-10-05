# CI/CD setup checklist

**Status: written, not verified.** The workflow `.github/workflows/ci-cd.yml` has never run on GitHub, and the AWS role and policy below have never been used. Expect to fix a permission or a typo on the first run (limitation L40). Everything marked "run it" is a command you run yourself.

**Progress (2026-10-05):** steps 1 to 3 were done with the AWS CLI for repository `Yaswanth1832K/serverless-event-ticketing`: the OIDC provider, the roles `ticketing-ci-dev` and `ticketing-ci-prod` (inline policy `deploy`) and the SSM parameter `/ticketing-dev/qr-signing-secret` now exist. The roles have been **created but never assumed**: the pipeline has not run.

**Trigger (temporary):** the first commit has `workflow_dispatch` only, so nothing runs on push. Start it by hand (Actions tab, "ci-cd", Run workflow on `main`, or `gh workflow run ci-cd.yml --ref main`). A manual run on `main` runs `verify`, then `deploy-dev` automatically, then waits for approval before `deploy-prod`. Once a run has been seen to work, a second commit restores `pull_request` and `push` to `main`.

## What the pipeline does

| Job | Runs on | Does |
|---|---|---|
| `verify` | every pull request and push | lint, typecheck (backend and frontend), unit tests (backend and frontend), frontend build, `sam validate --lint`, `sam build`. No AWS access. |
| `deploy-dev` | push to `main`, after `verify` | assumes the dev role (OIDC), `sam deploy` to stack `ticketing-dev`, `npm run deploy:frontend`, smoke test (`/health` and the website answer 200). |
| `deploy-prod` | after `deploy-dev` | waits for a reviewer to approve the `prod` environment, then the same steps against stack `ticketing-platform` (the stack that is already deployed). |

There are **no AWS access keys anywhere**. GitHub gives each job a short-lived OIDC token and AWS exchanges it for temporary credentials. The role can only be assumed by this repository and only from the matching environment.

All commands below are PowerShell. Replace the four values in step 0 once and keep the window open.

---

## In AWS

**0. Set variables** (use your own GitHub name and repository name)
```powershell
$Region = 'us-east-1'
$Account = (aws sts get-caller-identity --query Account --output text)
$Owner = '<your-github-username>'
$Repo  = '<your-repository-name>'
```

**1. Create the GitHub OIDC provider** (once per AWS account; if it already exists AWS says so, which is fine)
```powershell
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
```
If the CLI asks for a thumbprint, add `--thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1`.

**2. Create the dev and prod roles** (the trust policy and permission policy are in `ci/`; this fills in the placeholders into a temporary folder, not into the repo)
```powershell
# The token's subject claim is NOT always "repo:<owner>/<repo>". Repositories created recently use the
# immutable form "repo:<owner>@<owner id>/<repo>@<repo id>", so ask GitHub for the exact prefix.
# This needs the repository to EXIST already (create it first, step 5, empty is fine).
$SubPrefix = gh api "repos/$Owner/$Repo/actions/oidc/customization/sub" --jq .sub_claim_prefix
$SubPrefix        # check it: it must start with "repo:" and name your repository
$tmp = New-Item -ItemType Directory -Force "$env:TEMP\ticketing-ci"
foreach ($e in @(@{env='dev'; stack='ticketing-dev'}, @{env='prod'; stack='ticketing-platform'})) {
  $fill = { param($f) (Get-Content $f -Raw).Replace('<ACCOUNT_ID>',$Account).Replace('<SUB_CLAIM_PREFIX>',$SubPrefix).Replace('<ENVIRONMENT>',$e.env).Replace('<STACK_NAME>',$e.stack) }
  & $fill 'ci\trust-policy.template.json'       | Set-Content "$tmp\trust-$($e.env).json" -Encoding ascii
  & $fill 'ci\deploy-permissions.template.json' | Set-Content "$tmp\perm-$($e.env).json"  -Encoding ascii
  aws iam create-role --role-name "ticketing-ci-$($e.env)" --assume-role-policy-document "file://$tmp/trust-$($e.env).json" --query Role.Arn --output text
  aws iam put-role-policy --role-name "ticketing-ci-$($e.env)" --policy-name deploy --policy-document "file://$tmp/perm-$($e.env).json"
}
```
The two printed ARNs are what you put in GitHub in step 7. The roles are `ticketing-ci-dev` (only the `dev` environment can assume it, only stack `ticketing-dev`) and `ticketing-ci-prod` (only `prod`, only stack `ticketing-platform`).

**3. Create the dev QR signing secret** (random, 32 bytes, never printed; prod already has its own)
```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
aws ssm put-parameter --name /ticketing-dev/qr-signing-secret --type SecureString --value ([Convert]::ToBase64String($b)) --region $Region | Out-Null
Remove-Variable b
```
Prod keeps using `/ticketing-platform/qr-signing-secret`, which exists already.

**4. After the first deploy of each stack**, open the e-mail from AWS Notifications and click **Confirm subscription**. Until you do, alarms fire but nobody is told (L37). Check: `aws sns list-subscriptions-by-topic --topic-arn <AlarmTopicArn from the stack outputs>`.

## In GitHub

**5. Create the repository and push** (this folder is not a git repository yet)
```powershell
git init -b main
git add .
git status          # read this list. node_modules, .aws-sam, dist and .env must NOT appear
git commit -m "Ticketing platform"
gh repo create "$Owner/$Repo" --private --source . --push
```
Before pushing, search for anything you do not want public (`docs/test-results/` contains your AWS account id inside ARNs and the demo password `DemoPass123` is in `docs/demo-guide.md`; neither is a credential that grants access, but decide if you are comfortable). Nothing in the repo contains an access key or the QR secret.

**6. Create the environments `dev` and `prod`, with a required reviewer on `prod`**
```powershell
gh api -X PUT "repos/$Owner/$Repo/environments/dev"
$me = (gh api user --jq .id)
'{"reviewers":[{"type":"User","id":' + $me + '}]}' | gh api -X PUT "repos/$Owner/$Repo/environments/prod" --input -
```
**Caution:** required reviewers on a *private* repository need a paid GitHub plan (Pro, Team or Enterprise). On the free plan either make the repository public (check step 5 first) or the prod job will not wait for approval. Confirm in the GitHub UI: Settings, Environments, prod, "Required reviewers" shows your name.

**7. Add the variables to each environment** (variables, not secrets: none of these is secret). `ALARM_EMAIL` is the address that receives alarms.
```powershell
$DevRole  = "arn:aws:iam::${Account}:role/ticketing-ci-dev"
$ProdRole = "arn:aws:iam::${Account}:role/ticketing-ci-prod"
$Email = '<alarm e-mail address>'

gh variable set AWS_ROLE_ARN          --env dev  --repo "$Owner/$Repo" --body $DevRole
gh variable set STACK_NAME            --env dev  --repo "$Owner/$Repo" --body 'ticketing-dev'
gh variable set QR_SECRET_PARAM_NAME  --env dev  --repo "$Owner/$Repo" --body '/ticketing-dev/qr-signing-secret'
gh variable set ALARM_EMAIL           --env dev  --repo "$Owner/$Repo" --body $Email

gh variable set AWS_ROLE_ARN          --env prod --repo "$Owner/$Repo" --body $ProdRole
gh variable set STACK_NAME            --env prod --repo "$Owner/$Repo" --body 'ticketing-platform'
gh variable set QR_SECRET_PARAM_NAME  --env prod --repo "$Owner/$Repo" --body '/ticketing-platform/qr-signing-secret'
gh variable set ALARM_EMAIL           --env prod --repo "$Owner/$Repo" --body $Email
```

**8. Run it and watch**
```powershell
git push            # any push to main starts the pipeline
gh run watch
```
`verify` and `deploy-dev` run by themselves. When `deploy-prod` shows "Waiting", open the run page and click **Review deployments**, then approve. Only after a full green run should this document be changed to "verified", and L40 closed.

## If the first run fails

- **`Not authorized to perform sts:AssumeRoleWithWebIdentity`**: the trust policy's `sub` does not match the token's. **This happened in run 1** ([test-results/ci-run1-FAILED-deploy-dev.txt](test-results/ci-run1-FAILED-deploy-dev.txt)): the trust policy said `repo:Yaswanth1832K/serverless-event-ticketing:environment:dev`, but this repository uses GitHub's immutable subject format, so the token's subject was `repo:Yaswanth1832K@244766370/serverless-event-ticketing@1405917808:environment:dev`. Find the real value in CloudTrail (event `AssumeRoleWithWebIdentity`, field `userIdentity.userName`) or with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix`, then update the role: `aws iam update-assume-role-policy --role-name ticketing-ci-dev --policy-document file://trust-dev.json`. Also check the job has `environment:` set and the owner and repo spelling.
- **`AccessDenied` on a CloudFormation, IAM, Lambda or other action**: the permission policy in `ci/deploy-permissions.template.json` is missing that action. The error names it; add it, then update the role with `aws iam put-role-policy` again. This is the most likely first-run failure, because the policy was written from the template's resource list and has not been exercised.
- **`sam deploy` says the stack is in `ROLLBACK_COMPLETE`**: delete the failed stack (`aws cloudformation delete-stack --stack-name ticketing-dev`) and rerun.
- **Dev health check fails right after deploy**: API Gateway routes can take a minute to go live (seen in earlier stages); the smoke test retries for about a minute.

## Cleaning up the dev stack
```powershell
aws s3 rm "s3://$(aws cloudformation describe-stacks --stack-name ticketing-dev --query "Stacks[0].Outputs[?OutputKey=='WebBucketName'].OutputValue" --output text)" --recursive
aws s3 rm "s3://$(aws cloudformation describe-stacks --stack-name ticketing-dev --query "Stacks[0].Outputs[?OutputKey=='ImagesBucketName'].OutputValue" --output text)" --recursive
sam delete --stack-name ticketing-dev --region us-east-1 --no-prompts
aws ssm delete-parameter --name /ticketing-dev/qr-signing-secret
```
