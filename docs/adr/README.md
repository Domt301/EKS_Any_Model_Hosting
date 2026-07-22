# Architecture Decision Records

These ADRs capture the significant decisions behind the self-hosted Llama pilot.
Each record states the Context, Decision, Alternatives considered, Consequences,
and the conditions under which it should be revisited.

| ADR | Title | Status |
| --- | --- | --- |
| [001](ADR-001-eks-over-ecs-sagemaker.md) | Use EKS rather than ECS or SageMaker | Accepted |
| [002](ADR-002-vllm-inference-server.md) | Use vLLM as the inference server | Accepted |
| [003](ADR-003-fastapi-boundary.md) | Use FastAPI as the public application boundary | Accepted |
| [004](ADR-004-vllm-private.md) | Keep vLLM private | Accepted |
| [005](ADR-005-api-gateway-https.md) | Use API Gateway for managed HTTPS without a custom domain | Accepted (with a documented streaming constraint) |
| [006](ADR-006-cognito-pkce.md) | Use Cognito authorization-code flow with PKCE | Accepted |
| [007](ADR-007-single-gpu-node.md) | Use one fixed GPU node for the pilot | Accepted |
| [008](ADR-008-browser-conversation-state.md) | Keep conversation state in the browser | Accepted |
| [009](ADR-009-no-vector-database.md) | Do not introduce a vector database | Accepted |
| [010](ADR-010-pin-revisions.md) | Pin model and container revisions | Accepted |

> Implementation note (not a standalone ADR): the EKS cluster and its
> Kubernetes workloads (vLLM, FastAPI), the internal ALB, and the API Gateway
> edge live in **one** CloudFormation stack. CDK always attaches
> `cluster.addManifest(...)` resources to the cluster's stack, so splitting the
> workloads into a separate stack that references the cluster security group and
> the FastAPI target group produces an unavoidable cyclic dependency. Keeping
> them together is the standard, deployable pattern.
