import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';

export interface ContainerStackProps extends StackProps {
  readonly config: PilotEnvironmentConfig;
}

/**
 * ECR repositories. The FastAPI repository is the source of truth for the
 * application image. An optional org-controlled vLLM mirror repository is
 * provisioned so the pinned upstream image can be pulled-through / re-tagged
 * under organisation control.
 */
export class ContainerStack extends Stack {
  public readonly fastApiRepository: ecr.Repository;
  public readonly vllmMirrorRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: ContainerStackProps) {
    super(scope, id, props);
    const { config } = props;

    const removalPolicy = config.deletionProtection
      ? RemovalPolicy.RETAIN
      : RemovalPolicy.DESTROY;

    this.fastApiRepository = new ecr.Repository(this, 'FastApiRepo', {
      repositoryName: resourceName(config, 'api'),
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy,
      emptyOnDelete: !config.deletionProtection,
      lifecycleRules: [
        { description: 'Retain only the last 15 images', maxImageCount: 15 },
      ],
    });

    this.vllmMirrorRepository = new ecr.Repository(this, 'VllmMirrorRepo', {
      repositoryName: resourceName(config, 'vllm-mirror'),
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      // vLLM upstream tags are pinned by the caller; keep mutable to allow
      // mirroring the same tag, but rely on digest pinning at deploy time.
      imageTagMutability: ecr.TagMutability.MUTABLE,
      removalPolicy,
      emptyOnDelete: !config.deletionProtection,
      lifecycleRules: [{ description: 'Retain only the last 5 images', maxImageCount: 5 }],
    });

    new CfnOutput(this, 'FastApiRepositoryUri', { value: this.fastApiRepository.repositoryUri });
    new CfnOutput(this, 'VllmMirrorRepositoryUri', {
      value: this.vllmMirrorRepository.repositoryUri,
    });
  }
}
