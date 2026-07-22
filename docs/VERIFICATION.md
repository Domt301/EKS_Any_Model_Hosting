# Deployment Verification Report

_Last updated at implementation time. Environment: CI/dev sandbox **without AWS
credentials or a GPU**._

## Summary

The full pilot codebase — CDK infrastructure, FastAPI service, React SPA,
Kubernetes resources, scripts, tests, ADRs, and docs — is complete and passes
every check that can be run without a live AWS account. A real `cdk deploy` and
the end-to-end streamed-inference acceptance test **could not be executed here**
because this environment has no AWS credentials and no GPU. Those steps are
scripted and documented so they can be run in a real account.

## What was verified locally ✅

| Check | Command | Result |
| --- | --- | --- |
| CDK TypeScript compiles (strict) | `npx tsc --noEmit` | pass |
| CDK synthesizes to CloudFormation | `npx cdk synth` | pass (all 5 stacks) |
| CDK assertion tests | `npm test` | **25 passed** |
| ESLint | `npx eslint . --ext .ts` | clean |
| FastAPI unit/integration tests | `pytest` (services/api) | **32 passed** |
| SPA production build | `npm run build` (spa) | pass (dist emitted) |
| Kubernetes/CI YAML parse | `yaml.safe_load_all` | valid |

Security-critical properties asserted against the synthesized template:
- vLLM and FastAPI Services are `ClusterIP`; **no** Kubernetes `LoadBalancer`
  Service exists anywhere.
- Internal ALB is `Scheme: internal` (not internet-facing).
- API Gateway HTTP API + VPC Link + Cognito **JWT authorizer** exist; stage is
  throttled to 5 rps / burst 10.
- EKS `defaultCapacity` is 0; exactly two managed node groups; GPU group carries
  the `dedicated=inference:NoSchedule` taint and `workload-type=inference` label.
- All five control-plane log types enabled; a 14-day log-group retention exists.
- Cognito app client has **no secret** and uses **authorization-code only**
  (implicit disabled).
- ECR image scanning on push; vLLM image pinned (validation rejects `:latest`).
- vLLM NetworkPolicy (`vllm-allow-from-fastapi`) + `default-deny-ingress` present.

## What must be verified in a real AWS account ⏳

Run these after `scripts/deploy.sh <env>`:
1. `cdk deploy --all` completes; EKS cluster ACTIVE; CPU+GPU nodes join.
2. `nvidia.com/gpu` is allocatable; NVIDIA device plugin healthy.
3. vLLM pod becomes Ready (model downloaded + loaded).
4. FastAPI pods Ready; internal ALB target group healthy.
5. API Gateway HTTPS endpoint reachable; `scripts/smoke-test.sh` passes.
6. **Primary acceptance test:** authenticated, streamed chat completion returns
   `event: token …` then `event: done` (`COGNITO_ACCESS_TOKEN=… scripts/smoke-test.sh`).
7. `scripts/integration-test.sh` confirms vLLM is not publicly reachable and the
   ALB is internal.

## Unresolved risks / assumptions to validate on first deploy

1. **API Gateway streaming (highest-impact):** HTTP API caps integration timeout
   at 29 s and buffers responses. Fine for the pilot's short outputs, but not
   incremental streaming for long generations. See
   [ADR-005](adr/ADR-005-api-gateway-https.md). Validate perceived streaming and
   worst-case latency on real hardware; if long-form streaming is needed, move to
   a public ALB + ACM/custom domain (currently out of scope).
2. **Pinned add-on / image versions:** The kubectl layer is pinned to K8s 1.31
   (`@aws-cdk/lambda-layer-kubectl-v31`); `kubernetesVersion` must match. Core EKS
   add-on versions are resolved by EKS to the cluster-compatible default
   (`resolveConflicts: OVERWRITE`) rather than hard-pinned — pin them explicitly
   once validated with `aws eks describe-addon-versions`. The vLLM image
   (`v0.6.6`), ALB controller (`v2.8.2`), and NVIDIA device plugin (`0.16.2`) are
   pinned; confirm CUDA/driver compatibility with the AL2 GPU AMI.
3. **vLLM entrypoint/flags:** The Deployment uses `command: ["vllm","serve",<model>]`
   with OpenAI-server flags. Validate against the pinned image (older images use a
   different entrypoint) before relying on it.
4. **GPU quota/availability:** New accounts frequently have On-Demand G-family
   quota at 0 — request an increase first (see README §3).
5. **Gated model access:** The default model is gated; the HF token Secret must
   exist in Secrets Manager and be materialised as the `huggingface-token`
   Kubernetes Secret, or vLLM will fail to download weights.
6. **NetworkPolicy enforcement:** Requires the VPC CNI with
   `enableNetworkPolicy=true` (set in the add-on config). Confirm the CNI version
   supports it on the chosen K8s version.
7. **EKS public endpoint:** Enabled by default; set `clusterPublicAccessCidrs` to
   restrict it before any non-pilot use.
8. **Amplify deployment:** The app is created without a connected git repo; the
   SPA is shipped via a manual zip deployment (`deploy-spa.yml`). Wire a repo or
   the zip-deploy step in CI for your provider.

## Manual prerequisites (not automatable here)
- Accept the model license on Hugging Face and store the token in Secrets Manager.
- Request GPU vCPU quota in the target region.
- `cdk bootstrap` the account/region.
- Provide the CI OIDC deploy role (`AWS_DEPLOY_ROLE_ARN`) and `AWS_REGION`.
