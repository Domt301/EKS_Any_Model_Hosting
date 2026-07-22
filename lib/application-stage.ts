import * as crypto from 'crypto';
import { Stage, StageProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, commonTags } from './config/environment-config';
import { NetworkStack } from './stacks/network-stack';
import { AuthStack } from './stacks/auth-stack';
import { ContainerStack } from './stacks/container-stack';
import { EksStack } from './stacks/eks-stack';
import { AmplifyStack } from './stacks/amplify-stack';
import { FastapiCognitoConfig } from './constructs/fastapi-workload';

export interface ApplicationStageProps extends StageProps {
  readonly config: PilotEnvironmentConfig;
}

/**
 * Composes the full pilot as a single deployable stage: network, auth,
 * containers, EKS, workloads (incl. the public API edge), and Amplify hosting.
 * Cross-stack references wire outputs into downstream stacks so
 * `cdk deploy --all` provisions everything in dependency order.
 */
export class ApplicationStage extends Stage {
  public readonly network: NetworkStack;
  public readonly auth: AuthStack;
  public readonly containers: ContainerStack;
  public readonly eks: EksStack;
  public readonly amplify: AmplifyStack;

  constructor(scope: Construct, id: string, props: ApplicationStageProps) {
    super(scope, id, props);
    const { config } = props;
    const env = { account: config.account || undefined, region: config.region };
    // The stage id already carries `LlamaPilot-<env>`, so stack ids stay short;
    // final CloudFormation names become e.g. `LlamaPilot-dev-Network`.
    const prefix = '';

    // Deterministic, globally-unique-ish suffix for the Cognito hosted-UI domain.
    const domainSuffix = crypto
      .createHash('sha256')
      .update(`${config.account}-${config.region}-${config.environmentName}`)
      .digest('hex')
      .slice(0, 8);

    this.network = new NetworkStack(this, `${prefix}Network`, { config, env });

    this.auth = new AuthStack(this, `${prefix}Auth`, { config, env, domainSuffix });

    this.containers = new ContainerStack(this, `${prefix}Container`, { config, env });

    const cognito: FastapiCognitoConfig = {
      region: config.region,
      userPoolId: this.auth.auth.userPool.userPoolId,
      appClientId: this.auth.auth.userPoolClient.userPoolClientId,
      issuer: this.auth.auth.issuerUrl,
      jwksUrl: this.auth.auth.jwksUrl,
    };

    this.eks = new EksStack(this, `${prefix}Eks`, {
      config,
      env,
      vpc: this.network.vpc,
      fastApiRepository: this.containers.fastApiRepository,
      cognito,
    });

    this.amplify = new AmplifyStack(this, `${prefix}Amplify`, {
      config,
      env,
      cognito,
      cognitoDomain: this.auth.auth.domainBaseUrl,
      apiBaseUrl: this.eks.apiBaseUrl,
      initialRedirectOrigin: originOf(config.cognitoCallbackUrls[0]),
    });

    // Apply common cost-allocation / ownership tags to every stack in the stage.
    const tags = commonTags(config);
    for (const [key, value] of Object.entries(tags)) {
      Tags.of(this).add(key, value);
    }
  }
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url.replace(/\/$/, '');
  }
}
