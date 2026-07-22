import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { PilotEnvironmentConfig, resourceName } from '../config/environment-config';

export interface CognitoAuthProps {
  readonly config: PilotEnvironmentConfig;
  /** Globally-unique suffix for the Cognito hosted-UI domain prefix. */
  readonly domainSuffix: string;
}

/**
 * Cognito user pool + public (no-secret) SPA app client + managed-login domain.
 *
 * The app client is configured for OAuth2 Authorization Code + PKCE only
 * (implicit grant disabled) and issues short-lived access tokens which FastAPI
 * validates. No client secret is generated — required for a browser SPA.
 */
export class CognitoAuth extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly issuerUrl: string;
  public readonly jwksUrl: string;
  public readonly scopes: string[] = ['openid', 'email', 'profile'];

  constructor(scope: Construct, id: string, props: CognitoAuthProps) {
    super(scope, id);
    const { config } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: resourceName(config, 'user-pool'),
      selfSignUpEnabled: false, // administrator-created users only
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      deletionProtection: config.deletionProtection,
      removalPolicy: config.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'SpaClient', {
      userPool: this.userPool,
      userPoolClientName: resourceName(config, 'spa-client'),
      generateSecret: false, // public SPA client — must NOT have a secret
      authFlows: {
        // No SRP/USER_PASSWORD flows: SPA authenticates via hosted UI + PKCE.
        userSrp: false,
        userPassword: false,
        adminUserPassword: false,
        custom: false,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false, // implicit disabled
          clientCredentials: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: config.cognitoCallbackUrls,
        logoutUrls: config.cognitoLogoutUrls,
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: {
        domainPrefix: `llama-pilot-${config.environmentName}-${props.domainSuffix}`.toLowerCase(),
      },
    });

    // Optional administrator group for future RBAC. Users are still created by
    // an administrator (self-sign-up disabled).
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'pilot-admins',
      description: 'Administrators of the llama pilot',
      precedence: 0,
    });

    const region = Stack.of(this).region;
    this.issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${this.userPool.userPoolId}`;
    this.jwksUrl = `${this.issuerUrl}/.well-known/jwks.json`;
  }

  /** Full hosted-UI base URL, e.g. https://<prefix>.auth.<region>.amazoncognito.com */
  public get domainBaseUrl(): string {
    const region = Stack.of(this).region;
    return `https://${this.userPoolDomain.domainName}.auth.${region}.amazoncognito.com`;
  }
}
