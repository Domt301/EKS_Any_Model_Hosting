import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig } from '../config/environment-config';
import { CognitoAuth } from '../constructs/cognito-auth';

export interface AuthStackProps extends StackProps {
  readonly config: PilotEnvironmentConfig;
  /** Deterministic per-account/region suffix for the hosted-UI domain prefix. */
  readonly domainSuffix: string;
}

/**
 * Cognito authentication resources and the outputs the SPA + FastAPI consume.
 * No secret values are ever emitted as outputs.
 */
export class AuthStack extends Stack {
  public readonly auth: CognitoAuth;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.auth = new CognitoAuth(this, 'Auth', {
      config,
      domainSuffix: props.domainSuffix,
    });

    const out = (key: string, value: string) => new CfnOutput(this, key, { value });
    out('CognitoUserPoolId', this.auth.userPool.userPoolId);
    out('CognitoAppClientId', this.auth.userPoolClient.userPoolClientId);
    out('CognitoDomain', this.auth.domainBaseUrl);
    out('CognitoIssuerUrl', this.auth.issuerUrl);
    out('CognitoJwksUrl', this.auth.jwksUrl);
    out('CognitoRegion', Stack.of(this).region);
    out('CognitoScopes', this.auth.scopes.join(' '));
    out('CognitoCallbackUrls', config.cognitoCallbackUrls.join(','));
    out('CognitoLogoutUrls', config.cognitoLogoutUrls.join(','));
  }
}
