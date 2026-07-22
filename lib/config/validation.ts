import { PilotEnvironmentConfig } from './environment-config';

/**
 * Fail fast at synth time when the configuration is internally inconsistent or
 * would produce an obviously invalid / unsafe deployment. This keeps
 * misconfiguration errors close to the developer rather than surfacing as an
 * opaque CloudFormation failure minutes into a deploy.
 */
export function validatePilotConfig(config: PilotEnvironmentConfig): void {
  const errors: string[] = [];

  if (!/^[a-z0-9-]{1,20}$/.test(config.environmentName)) {
    errors.push(
      `environmentName "${config.environmentName}" must be lowercase alphanumeric/dash, <= 20 chars`,
    );
  }

  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(config.vpcCidr)) {
    errors.push(`vpcCidr "${config.vpcCidr}" is not a valid CIDR block`);
  }

  if (config.natGatewayCount < 1 || config.natGatewayCount > 3) {
    errors.push(`natGatewayCount ${config.natGatewayCount} should be between 1 and 3`);
  }

  if (!/^1\.(2[5-9]|3\d)$/.test(config.kubernetesVersion)) {
    errors.push(
      `kubernetesVersion "${config.kubernetesVersion}" is not a recognised EKS minor version (expected e.g. 1.29-1.31)`,
    );
  }

  if (config.cpuNodeInstanceTypes.length === 0) {
    errors.push('cpuNodeInstanceTypes must contain at least one instance type');
  }
  if (config.gpuNodeInstanceTypes.length === 0) {
    errors.push('gpuNodeInstanceTypes must contain at least one instance type');
  }

  if (config.maxOutputTokens < 1 || config.maxOutputTokens > 4096) {
    errors.push(`maxOutputTokens ${config.maxOutputTokens} out of sane range 1..4096`);
  }
  if (config.maxModelLength < config.maxOutputTokens) {
    errors.push(
      `maxModelLength ${config.maxModelLength} must be >= maxOutputTokens ${config.maxOutputTokens}`,
    );
  }
  if (config.gpuMemoryUtilization <= 0 || config.gpuMemoryUtilization > 1) {
    errors.push(`gpuMemoryUtilization ${config.gpuMemoryUtilization} must be in (0, 1]`);
  }

  if (config.vllmImage.endsWith(':latest') || !config.vllmImage.includes(':')) {
    errors.push(`vllmImage "${config.vllmImage}" must be pinned to an explicit tag (never :latest)`);
  }

  if (config.enableHuggingFaceTokenSecret && !config.huggingFaceSecretName) {
    errors.push('huggingFaceSecretName is required when enableHuggingFaceTokenSecret is true');
  }

  if (config.cognitoCallbackUrls.length === 0) {
    errors.push('cognitoCallbackUrls must contain at least one URL');
  }

  if (config.logRetentionDays < 1) {
    errors.push('logRetentionDays must be >= 1');
  }

  // Non-fatal, but surface loudly: wide-open public EKS endpoint.
  if (config.clusterPublicAccessCidrs.some((c) => c === '0.0.0.0/0')) {
    // eslint-disable-next-line no-console
    console.warn(
      '[llama-pilot] WARNING: clusterPublicAccessCidrs includes 0.0.0.0/0 — the EKS public API endpoint will be reachable from anywhere.',
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid llama-pilot configuration:\n  - ${errors.join('\n  - ')}\n` +
        'Fix the values under context.llamaPilot in cdk.json (or -c overrides).',
    );
  }
}
