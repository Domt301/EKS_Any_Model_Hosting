import { PilotEnvironmentConfig } from '../lib/config/environment-config';

/** Deterministic config for CDK assertion tests (no real account needed). */
export const testConfig: PilotEnvironmentConfig = {
  account: '111111111111',
  region: 'us-east-1',
  environmentName: 'test',

  vpcCidr: '10.30.0.0/16',
  natGatewayCount: 1,

  kubernetesVersion: '1.31',
  cpuNodeInstanceTypes: ['m6i.large'],
  gpuNodeInstanceTypes: ['g5.xlarge'],
  cpuNodeDiskSizeGiB: 50,
  gpuNodeDiskSizeGiB: 200,
  clusterPublicAccessCidrs: [],

  modelId: 'meta-llama/Llama-3.2-3B-Instruct',
  modelRevision: '0cb88a4f764b7a12671c53f0838cd831a0843b95',
  servedModelName: 'llama-pilot',
  maxModelLength: 4096,
  maxOutputTokens: 512,
  gpuMemoryUtilization: 0.85,
  vllmImage: 'vllm/vllm-openai:v0.6.6',

  enableHuggingFaceTokenSecret: true,
  huggingFaceSecretName: 'llama-pilot/test/huggingface-token',

  cognitoCallbackUrls: ['https://main.example.amplifyapp.com/'],
  cognitoLogoutUrls: ['https://main.example.amplifyapp.com/'],

  deletionProtection: false,
  logRetentionDays: 14,
};
