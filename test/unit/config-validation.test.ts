import { validatePilotConfig } from '../../lib/config/validation';
import { testConfig } from '../test-config';

describe('config validation', () => {
  it('accepts a valid config', () => {
    expect(() => validatePilotConfig(testConfig)).not.toThrow();
  });

  it('rejects an unpinned (:latest) vLLM image', () => {
    expect(() =>
      validatePilotConfig({ ...testConfig, vllmImage: 'vllm/vllm-openai:latest' }),
    ).toThrow(/pinned/);
  });

  it('rejects an image with no tag', () => {
    expect(() => validatePilotConfig({ ...testConfig, vllmImage: 'vllm/vllm-openai' })).toThrow(
      /pinned/,
    );
  });

  it('requires a HF secret name when the HF secret is enabled', () => {
    expect(() =>
      validatePilotConfig({
        ...testConfig,
        enableHuggingFaceTokenSecret: true,
        huggingFaceSecretName: undefined,
      }),
    ).toThrow(/huggingFaceSecretName/);
  });

  it('rejects maxModelLength smaller than maxOutputTokens', () => {
    expect(() =>
      validatePilotConfig({ ...testConfig, maxModelLength: 100, maxOutputTokens: 512 }),
    ).toThrow(/maxModelLength/);
  });

  it('rejects an invalid CIDR', () => {
    expect(() => validatePilotConfig({ ...testConfig, vpcCidr: 'not-a-cidr' })).toThrow(/vpcCidr/);
  });

  it('rejects a gpuMemoryUtilization outside (0,1]', () => {
    expect(() => validatePilotConfig({ ...testConfig, gpuMemoryUtilization: 1.5 })).toThrow(
      /gpuMemoryUtilization/,
    );
  });
});
