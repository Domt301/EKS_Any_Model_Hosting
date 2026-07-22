import { Construct } from 'constructs';
import { validatePilotConfig } from './validation';

/**
 * Single typed configuration object for the entire pilot.
 *
 * Values are resolved from CDK context (`cdk.json` -> `context.llamaPilot`, or
 * `-c` overrides) and, for account/region, from the standard CDK environment
 * variables. Secrets are NEVER stored here; only the *name* of a Secrets
 * Manager secret (e.g. the Hugging Face token) is referenced.
 */
export interface PilotEnvironmentConfig {
  /** AWS account id. Falls back to CDK_DEFAULT_ACCOUNT. */
  readonly account: string;
  /** AWS region. Falls back to CDK_DEFAULT_REGION. */
  readonly region: string;
  /** Logical environment name, e.g. "dev". Used in resource names/tags. */
  readonly environmentName: string;

  // ---- Networking ----
  readonly vpcCidr: string;
  readonly natGatewayCount: number;

  // ---- EKS ----
  readonly kubernetesVersion: string;
  readonly cpuNodeInstanceTypes: string[];
  readonly gpuNodeInstanceTypes: string[];
  readonly cpuNodeDiskSizeGiB: number;
  readonly gpuNodeDiskSizeGiB: number;
  /** CIDRs allowed to reach the public EKS API endpoint. Empty => private-preferred. */
  readonly clusterPublicAccessCidrs: string[];

  // ---- Model / inference ----
  readonly modelId: string;
  readonly modelRevision: string;
  readonly servedModelName: string;
  readonly maxModelLength: number;
  readonly maxOutputTokens: number;
  readonly gpuMemoryUtilization: number;
  /** Pinned vLLM OpenAI-compatible container image (never `latest`). */
  readonly vllmImage: string;

  // ---- Secrets (names only, never values) ----
  readonly enableHuggingFaceTokenSecret: boolean;
  readonly huggingFaceSecretName?: string;

  // ---- Cognito ----
  readonly cognitoCallbackUrls: string[];
  readonly cognitoLogoutUrls: string[];

  // ---- Lifecycle ----
  readonly deletionProtection: boolean;
  readonly logRetentionDays: number;
}

const CONTEXT_KEY = 'llamaPilot';

/**
 * Read, coerce, and validate the pilot configuration from CDK context.
 */
export function loadPilotConfig(scope: Construct): PilotEnvironmentConfig {
  const raw = (scope.node.tryGetContext(CONTEXT_KEY) ?? {}) as Record<string, unknown>;

  const account =
    (raw.account as string) ?? process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID ?? '';
  const region =
    (raw.region as string) ?? process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

  const config: PilotEnvironmentConfig = {
    account,
    region,
    environmentName: (raw.environmentName as string) ?? 'dev',

    vpcCidr: (raw.vpcCidr as string) ?? '10.20.0.0/16',
    natGatewayCount: numberOr(raw.natGatewayCount, 1),

    kubernetesVersion: (raw.kubernetesVersion as string) ?? '1.31',
    cpuNodeInstanceTypes: stringArrayOr(raw.cpuNodeInstanceTypes, ['m6i.large']),
    gpuNodeInstanceTypes: stringArrayOr(raw.gpuNodeInstanceTypes, ['g5.xlarge']),
    cpuNodeDiskSizeGiB: numberOr(raw.cpuNodeDiskSizeGiB, 50),
    gpuNodeDiskSizeGiB: numberOr(raw.gpuNodeDiskSizeGiB, 200),
    clusterPublicAccessCidrs: stringArrayOr(raw.clusterPublicAccessCidrs, []),

    modelId: (raw.modelId as string) ?? 'meta-llama/Llama-3.2-3B-Instruct',
    modelRevision: (raw.modelRevision as string) ?? 'main',
    servedModelName: (raw.servedModelName as string) ?? 'llama-pilot',
    maxModelLength: numberOr(raw.maxModelLength, 4096),
    maxOutputTokens: numberOr(raw.maxOutputTokens, 512),
    gpuMemoryUtilization: numberOr(raw.gpuMemoryUtilization, 0.85),
    vllmImage: (raw.vllmImage as string) ?? 'vllm/vllm-openai:v0.6.6',

    enableHuggingFaceTokenSecret: boolOr(raw.enableHuggingFaceTokenSecret, true),
    huggingFaceSecretName: raw.huggingFaceSecretName as string | undefined,

    cognitoCallbackUrls: stringArrayOr(raw.cognitoCallbackUrls, ['http://localhost:5173/']),
    cognitoLogoutUrls: stringArrayOr(raw.cognitoLogoutUrls, ['http://localhost:5173/']),

    deletionProtection: boolOr(raw.deletionProtection, false),
    logRetentionDays: numberOr(raw.logRetentionDays, 14),
  };

  // Two-phase deploy override: once the Amplify branch URL is known, pass
  // `-c spaRedirectUrl=https://main.<appid>.amplifyapp.com/` to redeploy Auth,
  // Eks (CORS), and Amplify with the real SPA origin as the sole
  // callback/logout URL. See README §Amplify callback workflow.
  const spaRedirectUrl = scope.node.tryGetContext('spaRedirectUrl') as string | undefined;
  const resolved: PilotEnvironmentConfig = spaRedirectUrl
    ? { ...config, cognitoCallbackUrls: [spaRedirectUrl], cognitoLogoutUrls: [spaRedirectUrl] }
    : config;

  validatePilotConfig(resolved);
  return resolved;
}

function numberOr(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return fallback;
}

/**
 * Common resource-name helper enforcing `<llama-pilot>-<environment>-<resource>`.
 */
export function resourceName(config: PilotEnvironmentConfig, resource: string): string {
  return `llama-pilot-${config.environmentName}-${resource}`;
}

/**
 * Standard cost-allocation and ownership tags applied to every stack.
 */
export function commonTags(config: PilotEnvironmentConfig): Record<string, string> {
  return {
    Application: 'llama-pilot',
    Environment: config.environmentName,
    ManagedBy: 'aws-cdk',
    Workload: 'self-hosted-inference',
    CostCenter: 'configurable',
  };
}
